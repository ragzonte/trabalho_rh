package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.junit.Test;
import org.robolectric.Robolectric;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowWebView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** A tela de verdade: WebView, navegação, ciclo de vida, botão voltar e o manifesto. */
public class MainActivityTest extends AllSdks {

    private ActivityController<MainActivity> controller;

    private MainActivity launch() {
        controller = Robolectric.buildActivity(MainActivity.class).setup();
        return controller.get();
    }

    private static WebResourceRequest request(final String url, final boolean mainFrame) {
        return new WebResourceRequest() {
            @Override
            public Uri getUrl() {
                return Uri.parse(url);
            }

            @Override
            public boolean isForMainFrame() {
                return mainFrame;
            }

            @Override
            public boolean isRedirect() {
                return false;
            }

            @Override
            public boolean hasGesture() {
                return true;
            }

            @Override
            public String getMethod() {
                return "GET";
            }

            @Override
            public Map<String, String> getRequestHeaders() {
                return new HashMap<>();
            }
        };
    }

    private static String body(WebResourceResponse response) throws Exception {
        try (InputStream in = response.getData()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static List<BroadcastReceiver> ourReceivers() {
        List<BroadcastReceiver> out = new ArrayList<>();
        for (ShadowApplication.Wrapper w : shadowOf(Fixtures.app()).getRegisteredReceivers()) {
            if (w.broadcastReceiver.getClass().getName().startsWith("com.wifiraiox.app.")) out.add(w.broadcastReceiver);
        }
        return out;
    }

    // ------------------------------------------------------------ WebView

    @Test
    public void webViewIsLockedDownAndLoadsTheBundledPage() {
        MainActivity activity = launch();
        WebView web = activity.webView();
        assertNotNull(web);
        WebSettings settings = web.getSettings();
        assertTrue(settings.getJavaScriptEnabled());
        assertTrue(settings.getDomStorageEnabled());
        assertFalse("file:// fica fechado", settings.getAllowFileAccess());
        assertFalse("content:// fica fechado", settings.getAllowContentAccess());
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.getMixedContentMode());
        assertFalse(settings.getAllowFileAccessFromFileURLs());
        assertFalse(settings.getAllowUniversalAccessFromFileURLs());

        assertEquals("https://appassets.androidplatform.net/assets/www/index.html", shadowOf(web).getLastLoadedUrl());
        assertSame("a ponte é injetada com o nome do contrato", activity.bridge(), shadowOf(web).getJavascriptInterface("WrxNative"));
        assertNotNull(shadowOf(web).getWebChromeClient());
        WebViewClient client = shadowOf(web).getWebViewClient();
        assertEquals("tratamento da morte do renderizador só existe do Android 8 em diante",
                Build.VERSION.SDK_INT >= 26, client instanceof WebClientApi26);
    }

    @Test
    @org.robolectric.annotation.Config(shadows = BrokenWebView.class)
    public void deviceWithoutAWorkingWebViewGetsAMessageNotACrash() {
        Throwable[] failures = {
            new android.util.AndroidRuntimeException("android.webkit.WebViewFactory$MissingWebViewPackageException"),
            // durante a atualização do WebView pela loja a biblioteca nativa some por instantes: é um Error, não uma exceção
            new UnsatisfiedLinkError("dlopen failed: library \"libwebviewchromium.so\" not found"),
        };
        try {
            for (Throwable failure : failures) {
                BrokenWebView.failure = failure;
                ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).create();
                MainActivity activity = c.get();
                assertTrue(String.valueOf(failure), activity.isFinishing());
                assertNull(activity.webView());
                assertNull(activity.bridge());
                assertTrue(org.robolectric.shadows.ShadowToast.getTextOfLatestToast().contains("WebView"));
                // o resto do ciclo de vida, se o Android ainda o entregar, não encontra nada para quebrar
                c.start().resume();
                activity.onBackPressed();
                activity.onRequestPermissionsResult(Permissions.REQUEST_LOCATION, new String[0], new int[0]);
                activity.eval("1+1");
                Fixtures.idle();
                c.pause().stop().destroy();
            }
        } finally {
            BrokenWebView.failure = null;
        }
    }

    @Test
    public void bundledAssetsAreServedWithTheRightTypes() throws Exception {
        MainActivity activity = launch();
        WebViewClient client = shadowOf(activity.webView()).getWebViewClient();

        WebResourceResponse index = client.shouldInterceptRequest(activity.webView(), request(WebClient.START_URL, true));
        assertNotNull(index);
        assertEquals(200, index.getStatusCode());
        assertEquals("text/html", index.getMimeType());
        assertEquals("UTF-8", index.getEncoding());
        assertTrue(body(index).toLowerCase().contains("<!doctype html>"));
        assertEquals("a política de segurança da página vai no cabeçalho", WebAssets.PAGE_POLICY,
                index.getResponseHeaders().get("Content-Security-Policy"));

        // Módulos ES só carregam com um tipo JavaScript.
        WebResourceResponse js = client.shouldInterceptRequest(activity.webView(),
                request("https://appassets.androidplatform.net/assets/www/js/bridge.js?v=3", false));
        assertEquals(200, js.getStatusCode());
        assertEquals("text/javascript", js.getMimeType());
        assertEquals("UTF-8", js.getEncoding());
        assertTrue(body(js).contains("WrxNative"));
        assertNull(js.getResponseHeaders().get("Content-Security-Policy"));

        for (String missing : new String[] {"js/nao-existe.js", "../AndroidManifest.xml", "js/../../segredo", ""}) {
            WebResourceResponse r = client.shouldInterceptRequest(activity.webView(),
                    request("https://appassets.androidplatform.net/assets/www/" + missing, false));
            if (missing.isEmpty()) {
                assertEquals("a pasta serve o index", 200, r.getStatusCode());
            } else {
                assertEquals(missing, 404, r.getStatusCode());
            }
        }
        // fora de /assets/www/ não há nada, e a resposta vem na hora (sem ir à internet)
        assertEquals(404, client.shouldInterceptRequest(activity.webView(),
                request("https://appassets.androidplatform.net/outra/coisa.js", false)).getStatusCode());
    }

    /**
     * A cópia da interface que ESTE build empacotou (tarefa copyWeb do Gradle). É ela, e não a pasta
     * wifi-raio-x/app ao vivo, que serve de referência: o que importa é nada se perder da cópia até o APK.
     */
    private static java.io.File webAppDir() {
        java.io.File dir = new java.io.File(System.getProperty("user.dir"), "build/generated/web/www");
        assertTrue("cópia da interface não encontrada em " + dir, new java.io.File(dir, "index.html").isFile());
        return dir;
    }

    private static void collect(java.io.File dir, String prefix, List<String> out) {
        java.io.File[] children = dir.listFiles();
        if (children == null) return;
        Arrays.sort(children);
        for (java.io.File f : children) {
            if (f.getName().startsWith(".")) continue; // ocultos (.DS_Store, .gitkeep) ficam mesmo de fora do APK
            if (f.isDirectory()) collect(f, prefix + f.getName() + "/", out);
            else out.add(prefix + f.getName());
        }
    }

    @Test
    public void everyFileOfTheWebAppIsInsideTheApkAndServedWithAUsableType() throws Exception {
        // O empacotador do Android descarta em silêncio arquivos e pastas que começam com "." e, por
        // padrão, pastas que começam com "_" (ver androidResources no build.gradle): a página abriria
        // faltando um módulo, e só no celular.
        List<String> files = new ArrayList<>();
        collect(webAppDir(), "", files);
        assertTrue("a interface tem de estar lá: " + files.size(), files.size() >= 10);
        assertTrue(files.contains("index.html"));
        assertTrue(files.contains("js/bridge.js"));

        MainActivity activity = launch();
        WebViewClient client = shadowOf(activity.webView()).getWebViewClient();
        Map<String, String> required = new HashMap<>();
        required.put("js", "text/javascript");   // módulos ES e Web Workers recusam qualquer outro tipo
        required.put("mjs", "text/javascript");
        required.put("css", "text/css");
        required.put("html", "text/html");
        required.put("json", "application/json");
        required.put("svg", "image/svg+xml");
        required.put("wasm", "application/wasm"); // WebAssembly.instantiateStreaming exige este tipo
        for (String path : files) {
            String url = "https://appassets.androidplatform.net/assets/www/" + Uri.encode(path, "/");
            WebResourceResponse r = client.shouldInterceptRequest(activity.webView(), request(url, false));
            assertNotNull(path, r);
            assertEquals(path + " ficou de fora do APK", 200, r.getStatusCode());
            java.io.File source = new java.io.File(webAppDir(), path);
            try (InputStream in = r.getData()) {
                long length = 0;
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) length += n;
                assertEquals(path + ": conteúdo empacotado diferente do arquivo", source.length(), length);
            }
            int dot = path.lastIndexOf('.');
            String expected = dot < 0 ? null : required.get(path.substring(dot + 1).toLowerCase());
            if (expected != null) assertEquals(path, expected, r.getMimeType());
        }
    }

    @Test
    public void mimeTable() {
        String[][] table = {
            {"index.html", "text/html"}, {"js/app.js", "text/javascript"}, {"js/worker.mjs", "text/javascript"},
            {"css/app.css", "text/css"}, {"data/oui.json", "application/json"}, {"vendor/three.min.js", "text/javascript"},
            {"img/icone.svg", "image/svg+xml"}, {"img/a.PNG", "image/png"}, {"fonts/x.woff2", "font/woff2"},
            {"x.wasm", "application/wasm"}, {"LICENSE", "text/plain"}, {"pasta.v2/arquivo", "text/plain"},
            {"modelo.glb", "model/gltf-binary"}, {"a.b.c.js", "text/javascript"}, {"x.desconhecido", "text/plain"},
        };
        for (String[] row : table) assertEquals(row[0], row[1], WebAssets.mimeOf(row[0]));
        assertTrue(WebAssets.isText("text/javascript"));
        assertTrue(WebAssets.isText("application/json"));
        assertTrue(WebAssets.isText("image/svg+xml"));
        assertFalse(WebAssets.isText("image/png"));
        assertFalse(WebAssets.isText("application/wasm"));
    }

    @Test
    public void linksToOtherSitesOpenInTheBrowserNotInTheApp() {
        MainActivity activity = launch();
        WebViewClient client = shadowOf(activity.webView()).getWebViewClient();

        assertFalse("navegação dentro do app segue normal",
                client.shouldOverrideUrlLoading(activity.webView(), request(WebClient.START_URL + "#mapa", true)));
        assertNull(shadowOf(activity).getNextStartedActivity());

        assertTrue(client.shouldOverrideUrlLoading(activity.webView(), request("https://pt.wikipedia.org/wiki/Wi-Fi", true)));
        Intent view = shadowOf(activity).getNextStartedActivity();
        assertNotNull(view);
        assertEquals(Intent.ACTION_VIEW, view.getAction());
        assertEquals("https://pt.wikipedia.org/wiki/Wi-Fi", view.getDataString());

        // esquemas que poderiam abrir outros apps ou arquivos: bloqueados sem abrir nada
        for (String url : new String[] {"intent://scan/#Intent;scheme=zxing;end", "file:///sdcard/x.html", "content://x/y",
                "javascript:alert(1)", "market://details?id=x", "http://appassets.androidplatform.net/assets/www/index.html#x"}) {
            assertTrue(url, client.shouldOverrideUrlLoading(activity.webView(), request(url, true)));
            Intent started = shadowOf(activity).getNextStartedActivity();
            if (url.startsWith("http:")) {
                assertNotNull("http comum vai para o navegador", started);
            } else {
                assertNull(url, started);
            }
        }
        // quadro interno apontando para fora: bloqueado, sem abrir o navegador
        assertTrue(client.shouldOverrideUrlLoading(activity.webView(), request("https://anuncio.example/", false)));
        assertNull(shadowOf(activity).getNextStartedActivity());
    }

    @Test
    public void foreignPageNeverGetsLoadedIntoTheMainFrame() throws Exception {
        MainActivity activity = launch();
        WebView web = activity.webView();
        WebViewClient client = shadowOf(web).getWebViewClient();

        // caminho que não passa por shouldOverrideUrlLoading (ex.: formulário POST)
        WebResourceResponse blocked = client.shouldInterceptRequest(web, request("https://evil.example/login", true));
        assertNotNull(blocked);
        assertEquals("o conteúdo de fora nunca é entregue", 403, blocked.getStatusCode());
        assertEquals(0, blocked.getData().available());
        Fixtures.idle();
        assertEquals("https://evil.example/login", shadowOf(activity).getNextStartedActivity().getDataString());

        // recursos de terceiros (script, imagem, fetch) também não entram: a interface é toda local
        WebResourceResponse foreign = client.shouldInterceptRequest(web, request("https://cdn.example/lib.js", false));
        assertNotNull(foreign);
        assertEquals(403, foreign.getStatusCode());
        assertEquals(0, foreign.getData().available());

        // se a página principal chegar a trocar de endereço: a ponte se fecha e o app recarrega a própria interface
        client.onPageStarted(web, "https://evil.example/login", null);
        assertTrue(activity.bridge().call("info", "{}").contains("error"));
        assertEquals(WebClient.START_URL, shadowOf(web).getLastLoadedUrl());
        client.onPageStarted(web, WebClient.START_URL, null);
        assertFalse(activity.bridge().call("info", "{}").contains("error"));
    }

    @Test
    public void aPageThatKeepsLeavingDoesNotCauseAReloadLoop() {
        MainActivity activity = launch();
        WebView web = activity.webView();
        WebViewClient client = shadowOf(web).getWebViewClient();
        int reloads = 0;
        for (int i = 0; i < 10; i++) {
            web.loadUrl("about:blank#marca" + i); // só para o teste enxergar se houve recarga depois
            client.onPageStarted(web, "https://evil.example/" + i, null);
            if (WebClient.START_URL.equals(shadowOf(web).getLastLoadedUrl())) reloads++;
        }
        assertEquals("recarrega o app algumas vezes e depois para de insistir", 3, reloads);
    }

    // ------------------------------------------------------------ ciclo de vida

    @Test
    public void lifecycleLeavesNothingRegistered() {
        int receiversBefore = ourReceivers().size();
        int callbacksBefore = Fixtures.shadowConnectivity().getNetworkCallbacks().size();

        MainActivity activity = launch(); // create + start + resume
        WebView web = activity.webView();
        assertEquals("varredura + estado do Wi-Fi/Localização", receiversBefore + 2, ourReceivers().size());
        assertEquals(callbacksBefore + 1, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertTrue(shadowOf(Fixtures.app()).hasReceiverForIntent(new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)));

        controller.pause();
        assertEquals("pausado (ex.: diálogo de permissão por cima) continua ouvindo", receiversBefore + 2, ourReceivers().size());
        controller.stop();
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertTrue(shadowOf(web).wasOnPauseCalled());

        controller.restart().resume(); // volta para a frente (onRestart, onStart, onResume)
        assertEquals(receiversBefore + 2, ourReceivers().size());
        assertEquals(callbacksBefore + 1, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertTrue(shadowOf(web).wasOnResumeCalled());

        Bridge bridge = activity.bridge();
        controller.pause().stop().destroy();
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertTrue(bridge.isDestroyed());
        assertEquals(0, bridge.pendingCalls());
        assertTrue(shadowOf(web).wasDestroyCalled());
        assertNull(shadowOf(web).getJavascriptInterface("WrxNative"));
        assertNull(activity.webView());
    }

    @Test
    public void destroyWithoutStopAlsoCleansUp() {
        int receiversBefore = ourReceivers().size();
        int callbacksBefore = Fixtures.shadowConnectivity().getNetworkCallbacks().size();
        MainActivity activity = launch();
        activity.bridge().call("watchRssi", "{}");
        activity.bridge().callAsync(5, "requestPermission", "{}");
        Fixtures.idle();
        Bridge bridge = activity.bridge();
        assertEquals(1, bridge.pendingCalls());
        controller.destroy(); // o Android pode pular etapas quando mata a tela
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertEquals("ninguém fica esperando resposta", 0, bridge.pendingCalls());
        assertTrue(bridge.isDestroyed());
        assertNull(activity.bridge());
    }

    @Test
    public void recreationBuildsAFreshPageAndBridge() {
        MainActivity first = launch();
        Bridge old = first.bridge();
        controller.recreate();
        MainActivity second = controller.get();
        assertTrue(old.isDestroyed());
        assertFalse(second.bridge().isDestroyed());
        assertEquals(WebClient.START_URL, shadowOf(second.webView()).getLastLoadedUrl());
        assertFalse(second.bridge().call("info", "{}").contains("error"));
    }

    @Test
    public void eventsReachThePageThroughEvaluateJavascript() {
        MainActivity activity = launch();
        Fixtures.grantLocation();
        activity.onRequestPermissionsResult(Permissions.REQUEST_LOCATION,
                new String[] {Fixtures.FINE, Fixtures.COARSE}, new int[] {0, 0});
        String script = shadowOf(activity.webView()).getLastEvaluatedJavascript();
        assertTrue(script, script.startsWith("window.__wrx&&window.__wrx.emit&&window.__wrx.emit(\"status\",{"));
        assertTrue(script.contains("\"permission\":\"granted\""));
    }

    @Test
    public void evalFromAnyThreadAndAfterDestroyIsSafe() throws Exception {
        final MainActivity activity = launch();
        Thread worker = new Thread(() -> activity.eval("1+1"));
        worker.start();
        worker.join(5000);
        assertFalse("de outra thread, só entra na fila", "1+1".equals(shadowOf(activity.webView()).getLastEvaluatedJavascript()));
        Fixtures.idle();
        WebView web = activity.webView();
        assertEquals("1+1", shadowOf(web).getLastEvaluatedJavascript());

        controller.pause().stop().destroy();
        activity.eval("2+2"); // descartado em silêncio
        Thread late = new Thread(() -> activity.eval("3+3"));
        late.start();
        late.join(5000);
        Fixtures.idle();
        assertEquals("1+1", shadowOf(web).getLastEvaluatedJavascript());
    }

    // ------------------------------------------------------------ voltar

    @Test
    public void backAsksThePageFirst() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());

        activity.onBackPressed();
        assertEquals("window.__wrx && window.__wrx.back ? window.__wrx.back() : false", web.getLastEvaluatedJavascript());
        assertFalse("espera a resposta da página", activity.isFinishing());
        web.getLastEvaluatedJavascriptCallback().onReceiveValue("true"); // a página fechou um painel
        assertFalse(activity.isFinishing());

        activity.onBackPressed();
        web.getLastEvaluatedJavascriptCallback().onReceiveValue("false"); // nada para fechar
        assertTrue("só então o app sai", activity.isFinishing());
    }

    @Test
    public void backLeavesWhenThePageHasNoAnswer() {
        for (String answer : new String[] {"null", "undefined", "", "\"true\"", "1", null}) {
            MainActivity activity = launch();
            activity.onBackPressed();
            shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback().onReceiveValue(answer);
            assertTrue(String.valueOf(answer), activity.isFinishing());
        }
    }

    @Test
    public void backAnsweredAfterTheScreenWentToTheBackgroundDoesNotCrash() {
        // No Android 7 o onBackPressed() do sistema lança IllegalStateException depois de o estado ser
        // salvo; a resposta da página é assíncrona e pode chegar com o app já fora da tela.
        MainActivity activity = launch();
        activity.onBackPressed();
        android.webkit.ValueCallback<String> answer = shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback();
        controller.pause().saveInstanceState(new android.os.Bundle()).stop();
        answer.onReceiveValue("false");
        assertTrue("sai do mesmo jeito, sem derrubar o app", activity.isFinishing());
    }

    /**
     * O mesmo roteiro com o onBackPressed() de verdade do Android (ver RealBackActivity): no 7 ele
     * lança IllegalStateException depois do estado salvo; do 8 em diante já confere antes.
     */
    @Test
    @org.robolectric.annotation.Config(sdk = {24, 26, 28}, shadows = RealBackActivity.class)
    public void theRealBackHandlingOfEachAndroidSurvivesALateAnswer() {
        MainActivity activity = launch();
        activity.onBackPressed();
        android.webkit.ValueCallback<String> answer = shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback();
        controller.pause().saveInstanceState(new android.os.Bundle()).stop();
        answer.onReceiveValue("false"); // sem a proteção, no Android 7: "Can not perform this action after onSaveInstanceState"
        assertTrue(activity.isFinishing());

        // e no caminho normal (tela em primeiro plano) o "voltar" de verdade também fecha
        MainActivity second = launch();
        second.onBackPressed();
        shadowOf(second.webView()).getLastEvaluatedJavascriptCallback().onReceiveValue("false");
        assertTrue(second.isFinishing());
    }

    @Test
    public void backAnsweredAfterDestroyIsIgnored() {
        MainActivity activity = launch();
        activity.onBackPressed();
        android.webkit.ValueCallback<String> answer = shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback();
        controller.pause().saveInstanceState(new android.os.Bundle()).stop().destroy();
        answer.onReceiveValue("false"); // não lança
        answer.onReceiveValue("true");
    }

    @Test
    public void backAnswerFromAPageThatWasReplacedIsIgnored() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity activity = launch();
        activity.onBackPressed();
        android.webkit.ValueCallback<String> stale = shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback();
        assertTrue(rendererGone(activity.webView()));
        Fixtures.idle();
        // a página nova recebe o próximo "voltar" como o primeiro, e a resposta velha não vale para ela
        activity.onBackPressed();
        stale.onReceiveValue("false");
        assertFalse(activity.isFinishing());
        shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        assertFalse(activity.isFinishing());
    }

    @Test
    public void secondBackWhileThePageIsStuckLeavesAnyway() {
        MainActivity activity = launch();
        activity.onBackPressed();
        assertFalse(activity.isFinishing());
        // a página não respondeu ao primeiro e o tempo passou: está travada, o usuário não fica preso
        org.robolectric.shadows.ShadowSystemClock.advanceBy(MainActivity.BACK_PATIENCE_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
        activity.onBackPressed();
        assertTrue(activity.isFinishing());
        // a resposta atrasada não faz mais nada
        shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        assertTrue(activity.isFinishing());
    }

    /**
     * Visto num aparelho lento: com um painel aberto a página demorava a responder ao "voltar", e um
     * segundo toque logo em seguida fechava o app inteiro em vez de fechar o painel.
     */
    @Test
    public void aRepeatedBackOnABusyPageDoesNotThrowTheUserOutOfTheApp() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        activity.onBackPressed();
        android.webkit.ValueCallback<String> first = web.getLastEvaluatedJavascriptCallback();

        org.robolectric.shadows.ShadowSystemClock.advanceBy(MainActivity.BACK_PATIENCE_MS - 1, java.util.concurrent.TimeUnit.MILLISECONDS);
        activity.onBackPressed(); // toque repetido, a página ainda está ocupada
        activity.onBackPressed();
        assertFalse("ainda dentro do prazo: não sai", activity.isFinishing());
        assertSame("e não pergunta de novo: a resposta do primeiro toque resolve", first, web.getLastEvaluatedJavascriptCallback());

        first.onReceiveValue("true"); // a página fechou o painel
        assertFalse(activity.isFinishing());

        // o "voltar" seguinte é um pedido novo, com prazo novo
        activity.onBackPressed();
        android.webkit.ValueCallback<String> second = web.getLastEvaluatedJavascriptCallback();
        assertTrue(second != first);
        activity.onBackPressed();
        assertFalse(activity.isFinishing());
        second.onReceiveValue("false");
        assertTrue("sem nada para fechar, sai", activity.isFinishing());
    }

    // ------------------------------------------------------------ morte do renderizador (Android 8+)

    private static boolean rendererGone(WebView web) {
        return shadowOf(web).getWebViewClient().onRenderProcessGone(web, null);
    }

    @Test
    public void rendererDeathRebuildsThePageInsteadOfCrashing() {
        if (Build.VERSION.SDK_INT < 26) return;
        int receiversBefore = ourReceivers().size();
        int callbacksBefore = Fixtures.shadowConnectivity().getNetworkCallbacks().size();
        MainActivity activity = launch();
        WebView first = activity.webView();
        Bridge old = activity.bridge();
        old.callAsync(7, "requestPermission", "{}");
        Fixtures.idle();
        assertEquals(1, old.pendingCalls());

        assertTrue("true = tratado; false derrubaria o app", rendererGone(first));
        // o WebView morto é destruído na hora, com a ponte dele...
        assertTrue(shadowOf(first).wasDestroyCalled());
        assertNull(first.getParent());
        assertTrue(old.isDestroyed());
        assertEquals(0, old.pendingCalls());
        assertNull(activity.webView());
        assertNull(activity.bridge());
        assertTrue(activity.pageLost());
        assertFalse(activity.isFinishing());
        assertEquals("nada fica registrado enquanto não há página", receiversBefore, ourReceivers().size());

        // ...e a página é refeita logo em seguida, fora do callback, na mesma tela
        Fixtures.idle();
        WebView second = activity.webView();
        assertNotNull(second);
        assertTrue(second != first);
        assertFalse(activity.pageLost());
        assertSame(activity, controller.get());
        assertFalse(activity.isFinishing());
        assertEquals(WebClient.START_URL, shadowOf(second).getLastLoadedUrl());
        assertSame(activity.bridge(), shadowOf(second).getJavascriptInterface("WrxNative"));
        assertFalse(activity.bridge().isDestroyed());
        assertNotNull(second.getParent());
        assertFalse(activity.bridge().call("info", "{}").contains("error"));
        // a tela está visível e em primeiro plano: a ponte nova já ouve o sistema e avisou o estado
        assertEquals(receiversBefore + 2, ourReceivers().size());
        assertEquals(callbacksBefore + 1, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertTrue(shadowOf(second).wasOnResumeCalled());
        assertTrue(String.valueOf(shadowOf(second).getLastEvaluatedJavascript()),
                shadowOf(second).getLastEvaluatedJavascript().contains("\"status\""));

        // um aviso repetido sobre o WebView que já foi descartado não muda nada
        assertTrue(shadowOf(first).getWebViewClient().onRenderProcessGone(first, null));
        Fixtures.idle();
        assertSame(second, activity.webView());
        assertFalse(activity.isFinishing());

        controller.pause().stop().destroy();
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
    }

    @Test
    public void aRebuiltPageThatDiesRightAwayClosesTheAppInsteadOfLooping() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity activity = launch();
        assertTrue(rendererGone(activity.webView()));
        Fixtures.idle();
        WebView second = activity.webView();
        assertNotNull(second);

        org.robolectric.shadows.ShadowSystemClock.advanceBy(2, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(rendererGone(second));
        assertTrue("morreu de novo logo depois de refeita: fecha", activity.isFinishing());
        assertTrue(shadowOf(second).wasDestroyCalled());
        assertTrue(String.valueOf(org.robolectric.shadows.ShadowToast.getTextOfLatestToast()),
                org.robolectric.shadows.ShadowToast.getTextOfLatestToast().contains("parou de funcionar"));
        Fixtures.idle();
        assertNull("e não tenta refazer", activity.webView());
        controller.pause().stop().destroy(); // encerrar sem página não lança
    }

    @Test
    public void aLaterRendererDeathIsAnotherEpisode() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity activity = launch();
        for (int i = 0; i < 3; i++) {
            assertTrue(rendererGone(activity.webView()));
            Fixtures.idle();
            assertNotNull("refeita na vez " + i, activity.webView());
            assertFalse(activity.isFinishing());
            org.robolectric.shadows.ShadowSystemClock.advanceBy(60, java.util.concurrent.TimeUnit.SECONDS);
        }
    }

    @Test
    public void rendererKilledInBackgroundIsRebuiltOnlyWhenTheUserComesBack() {
        if (Build.VERSION.SDK_INT < 26) return;
        int receiversBefore = ourReceivers().size();
        int callbacksBefore = Fixtures.shadowConnectivity().getNetworkCallbacks().size();
        MainActivity activity = launch();
        WebView first = activity.webView();
        controller.pause().stop(); // o usuário foi para outro app; o Android recupera memória

        assertTrue(rendererGone(first));
        Fixtures.idle();
        assertTrue(shadowOf(first).wasDestroyCalled());
        assertNull("em segundo plano não se cria outro WebView: o sistema o mataria de novo", activity.webView());
        assertTrue(activity.pageLost());
        assertFalse(activity.isFinishing());
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        // enquanto isso, nada do que chega encontra a página: tudo é descartado sem lançar
        activity.eval("1+1");
        activity.onAppPageRequested();
        activity.onPageUrl(WebClient.START_URL);
        activity.onRequestPermissionsResult(Permissions.REQUEST_LOCATION, new String[0], new int[0]);
        Fixtures.idle();

        controller.restart().resume();
        WebView second = activity.webView();
        assertNotNull("ao voltar, a página é refeita", second);
        assertFalse(activity.pageLost());
        assertEquals(WebClient.START_URL, shadowOf(second).getLastLoadedUrl());
        assertEquals(receiversBefore + 2, ourReceivers().size());
        assertEquals(callbacksBefore + 1, Fixtures.shadowConnectivity().getNetworkCallbacks().size());

        // sair de novo e morrer de novo em poucos segundos não é "laço": ninguém a refez em segundo plano
        controller.pause().stop();
        org.robolectric.shadows.ShadowSystemClock.advanceBy(2, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(rendererGone(second));
        assertFalse(activity.isFinishing());
        controller.restart().resume();
        assertNotNull(activity.webView());
    }

    @Test
    public void screenWithoutAPageStillHandlesBackAndDestroy() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity activity = launch();
        controller.pause().stop();
        assertTrue(rendererGone(activity.webView()));
        controller.restart();
        // refeita no onStart; mata de novo antes do resume para ficar sem página em primeiro plano
        org.robolectric.shadows.ShadowSystemClock.advanceBy(60, java.util.concurrent.TimeUnit.SECONDS);
        WebView rebuilt = activity.webView();
        controller.resume();
        assertTrue(rendererGone(rebuilt));
        assertNull(activity.webView());
        activity.onBackPressed(); // sem página para perguntar: sai
        assertTrue(activity.isFinishing());
        controller.pause().stop().destroy();
    }

    @Test
    public void aFailureWhileHandlingRendererDeathStillCountsAsHandled() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity activity = launch();
        WebClient.Host broken = new WebClient.Host() {
            @Override
            public void onPageUrl(String url) {
            }

            @Override
            public void onAppPageRequested() {
                throw new IllegalStateException("falha de propósito");
            }

            @Override
            public void openExternal(Uri uri) {
            }

            @Override
            public void onForeignMainFrame(Uri uri) {
            }

            @Override
            public void onRendererGone(WebView view) {
                throw new IllegalStateException("falha de propósito");
            }
        };
        WebClientApi26 client = new WebClientApi26(
                new androidx.webkit.WebViewAssetLoader.Builder().addPathHandler(WebAssets.URL_PATH, new WebAssets(activity)).build(), broken);
        assertTrue("devolver false (ou lançar) faria o Android encerrar o app", client.onRenderProcessGone(activity.webView(), null));
        // e uma exceção ao servir um arquivo vira resposta de erro, não queda (roda numa thread do WebView)
        WebResourceResponse r = client.shouldInterceptRequest(activity.webView(), request(WebClient.START_URL, true));
        assertEquals(500, r.getStatusCode());
    }

    // ------------------------------------------------------------ a página abriu?

    private static void advance(long ms) {
        org.robolectric.shadows.ShadowLooper.idleMainLooper(ms, java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    @Test
    public void aPageThatNeverComesAliveGetsAnExplanationAndAWayOut() {
        // WebView antigo demais para os módulos da interface: nenhum script do app chega a rodar.
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        advance(MainActivity.PAGE_START_MS - 1000);
        assertFalse("ainda dentro do prazo", Js.ALIVE_SCRIPT.equals(web.getLastEvaluatedJavascript()));
        advance(1000);
        assertEquals(Js.ALIVE_SCRIPT, web.getLastEvaluatedJavascript());
        assertNull(activity.startProblemDialog());

        web.getLastEvaluatedJavascriptCallback().onReceiveValue("false");
        android.app.AlertDialog dialog = activity.startProblemDialog();
        assertNotNull("em vez de ficar para sempre na tela de abertura", dialog);
        assertTrue(dialog.isShowing());
        String message = String.valueOf(shadowOf(dialog).getMessage());
        assertTrue(message, message.contains("Android System WebView"));
        assertTrue(message, message.contains("Play Store"));
        assertFalse(activity.isFinishing());

        // "Atualizar" leva à página do componente na loja
        dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick();
        Fixtures.idle();
        Intent store = shadowOf(activity).getNextStartedActivity();
        assertNotNull(store);
        assertEquals(Intent.ACTION_VIEW, store.getAction());
        assertEquals("market://details?id=com.google.android.webview", store.getDataString());
        assertFalse(dialog.isShowing());
        assertNull(activity.startProblemDialog());

        // o aviso aparece uma vez só por página, mesmo que ela continue parada
        advance(MainActivity.PAGE_START_MS * 3);
        assertNull(activity.startProblemDialog());
    }

    /**
     * Visto num aparelho: um laço sem fim na partida da página deixava a tela de abertura para
     * sempre. A pergunta "está de pé?" nunca voltava, e sem resposta o aviso não aparecia.
     */
    @Test
    public void aPageTooStuckToEvenAnswerAlsoGetsTheExplanation() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        advance(MainActivity.PAGE_START_MS);
        assertEquals(Js.ALIVE_SCRIPT, web.getLastEvaluatedJavascript());
        android.webkit.ValueCallback<String> question = web.getLastEvaluatedJavascriptCallback();
        assertNull("ainda dentro do prazo da resposta", activity.startProblemDialog());

        advance(MainActivity.PAGE_ANSWER_MS); // a página não respondeu
        android.app.AlertDialog dialog = activity.startProblemDialog();
        assertNotNull("sem resposta também é \"não abriu\"", dialog);
        assertTrue(dialog.isShowing());
        assertFalse(activity.isFinishing());

        // enquanto a página não responde, não se empilham perguntas na fila dela
        advance(MainActivity.PAGE_RECHECK_MS * 5 + MainActivity.PAGE_ANSWER_MS * 5);
        assertSame(question, web.getLastEvaluatedJavascriptCallback());
        assertTrue(dialog.isShowing());

        // a página destravou: a resposta atrasada fecha o aviso sozinha
        question.onReceiveValue("true");
        assertFalse(dialog.isShowing());
        assertNull(activity.startProblemDialog());
        advance(MainActivity.PAGE_START_MS * 3);
        assertNull(activity.startProblemDialog());
        assertSame("página de pé não é perguntada de novo", question, web.getLastEvaluatedJavascriptCallback());
    }

    @Test
    public void aStuckPageThatAnswersNoIsAskedAgainUntilItStarts() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        advance(MainActivity.PAGE_START_MS);
        android.webkit.ValueCallback<String> first = web.getLastEvaluatedJavascriptCallback();
        advance(MainActivity.PAGE_ANSWER_MS);
        assertNotNull(activity.startProblemDialog());
        first.onReceiveValue("false"); // respondeu, mas os módulos ainda não rodaram
        advance(MainActivity.PAGE_RECHECK_MS);
        android.webkit.ValueCallback<String> second = web.getLastEvaluatedJavascriptCallback();
        assertTrue("pergunta de novo depois de uma resposta", second != first);
        second.onReceiveValue("true");
        assertNull(activity.startProblemDialog());
    }

    @Test
    public void aHealthyPageIsCheckedOnceAndNeverBothered() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        advance(MainActivity.PAGE_START_MS);
        android.webkit.ValueCallback<String> answer = web.getLastEvaluatedJavascriptCallback();
        answer.onReceiveValue("true");
        assertNull(activity.startProblemDialog());
        assertNull(org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog());
        advance(MainActivity.PAGE_START_MS * 6);
        assertSame("não pergunta de novo", answer, web.getLastEvaluatedJavascriptCallback());

        // sair e voltar não reabre a questão
        controller.pause().stop();
        controller.restart().resume();
        advance(MainActivity.PAGE_START_MS * 2);
        assertNull(org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog());

        // uma recarga da página, sim: a página nova tem de mostrar que roda
        shadowOf(activity.webView()).getWebViewClient().onPageStarted(activity.webView(), WebClient.START_URL, null);
        advance(MainActivity.PAGE_START_MS);
        assertEquals(Js.ALIVE_SCRIPT, web.getLastEvaluatedJavascript());
        assertTrue(answer != web.getLastEvaluatedJavascriptCallback());
    }

    @Test
    public void aSlowPageDismissesTheWarningByItselfOnceItStarts() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        advance(MainActivity.PAGE_START_MS);
        web.getLastEvaluatedJavascriptCallback().onReceiveValue("false");
        android.app.AlertDialog dialog = activity.startProblemDialog();
        assertTrue(dialog.isShowing());

        advance(MainActivity.PAGE_RECHECK_MS); // pergunta de novo enquanto o aviso está na tela
        web.getLastEvaluatedJavascriptCallback().onReceiveValue("false");
        assertTrue(dialog.isShowing());
        advance(MainActivity.PAGE_RECHECK_MS);
        web.getLastEvaluatedJavascriptCallback().onReceiveValue("true"); // a página acordou
        assertFalse(dialog.isShowing());
        assertNull(activity.startProblemDialog());
    }

    @Test
    public void theWarningNeverOutlivesTheScreenAndIsNotAskedInTheBackground() {
        MainActivity activity = launch();
        ShadowWebView web = shadowOf(activity.webView());
        controller.pause().stop(); // saiu do app antes do prazo: fora da tela a página pode estar suspensa
        advance(MainActivity.PAGE_START_MS * 2);
        assertFalse(Js.ALIVE_SCRIPT.equals(web.getLastEvaluatedJavascript()));

        controller.restart().resume();
        advance(MainActivity.PAGE_START_MS);
        assertEquals("de volta à tela, o prazo recomeça", Js.ALIVE_SCRIPT, web.getLastEvaluatedJavascript());
        android.webkit.ValueCallback<String> answer = web.getLastEvaluatedJavascriptCallback();
        answer.onReceiveValue("null"); // qualquer coisa que não seja true
        android.app.AlertDialog dialog = activity.startProblemDialog();
        assertTrue(dialog.isShowing());

        controller.pause().stop().destroy();
        assertFalse("um diálogo aberto numa tela destruída vazaria a janela", dialog.isShowing());
        answer.onReceiveValue("false"); // resposta atrasada depois de tudo encerrado: não lança, não mostra nada
        assertNull(activity.startProblemDialog());
    }

    @Test
    public void reloadingThePageResetsWhatTheOldPageLeftRunning() {
        MainActivity activity = launch();
        WebViewClient client = shadowOf(activity.webView()).getWebViewClient();
        Bridge bridge = activity.bridge();
        bridge.call("keepAwake", "{\"on\":true}");
        bridge.callAsync(3, "requestPermission", "{}");
        Fixtures.idle();
        assertEquals(1, bridge.pendingCalls());
        int keepOn = android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
        assertTrue((activity.getWindow().getAttributes().flags & keepOn) != 0);

        // o WebView pede o documento principal de novo (location.reload())
        assertEquals(200, client.shouldInterceptRequest(activity.webView(), request(WebClient.START_URL, true)).getStatusCode());
        Fixtures.idle();
        assertEquals("a página nova não herda chamadas da antiga", 0, bridge.pendingCalls());
        assertEquals("nem a tela presa ligada", 0, activity.getWindow().getAttributes().flags & keepOn);

        // pedidos de outros arquivos (scripts, imagens) não contam como página nova
        bridge.callAsync(4, "requestPermission", "{}"); // pega carona no diálogo que continua aberto
        Fixtures.idle();
        client.shouldInterceptRequest(activity.webView(), request("https://appassets.androidplatform.net/assets/www/js/bridge.js", false));
        Fixtures.idle();
        assertEquals(1, bridge.pendingCalls());

        // o usuário responde ao diálogo: quem recebe é a página nova
        Fixtures.grantLocation();
        activity.onRequestPermissionsResult(Permissions.REQUEST_LOCATION, new String[] {Fixtures.FINE, Fixtures.COARSE}, new int[] {0, 0});
        Fixtures.idle();
        assertEquals(0, bridge.pendingCalls());
    }

    // ------------------------------------------------------------ tema claro/escuro

    /** O que o WebView consulta (Android 10+) para responder "prefers-color-scheme" à página. */
    private static boolean themeIsLight(MainActivity activity) {
        android.content.res.TypedArray a = activity.getTheme().obtainStyledAttributes(new int[] {android.R.attr.isLightTheme});
        try {
            return a.getBoolean(0, true);
        } finally {
            a.recycle();
        }
    }

    private static int themeColor(MainActivity activity, int attr) {
        android.util.TypedValue v = new android.util.TypedValue();
        assertTrue(activity.getTheme().resolveAttribute(attr, v, true));
        return v.data;
    }

    @Test
    public void lightPhoneGetsALightWindowAndTellsThePageSo() {
        MainActivity activity = launch();
        assertEquals(0xFFF3F5F9, themeColor(activity, android.R.attr.statusBarColor));
        assertEquals(0xFFF3F5F9, activity.getColor(R.color.page));
        if (Build.VERSION.SDK_INT >= 29) assertTrue(themeIsLight(activity));
        // Antes do Android 8.1 a barra de navegação não aceita ícones escuros: fica preta.
        int nav = themeColor(activity, android.R.attr.navigationBarColor);
        assertEquals(Build.VERSION.SDK_INT >= 27 ? 0xFFF3F5F9 : 0xFF000000, nav);
    }

    @Test
    @org.robolectric.annotation.Config(qualifiers = "night")
    public void darkPhoneGetsADarkWindowAndTellsThePageSo() {
        MainActivity activity = launch();
        assertEquals(0xFF0A0F1C, themeColor(activity, android.R.attr.statusBarColor));
        assertEquals(0xFF0A0F1C, activity.getColor(R.color.page));
        if (Build.VERSION.SDK_INT >= 29) assertFalse(themeIsLight(activity));
    }

    @Test
    public void switchingTheSystemThemeDoesNotRecreateTheScreenButUpdatesTheAnswer() {
        MainActivity activity = launch();
        WebView web = activity.webView();
        Bridge bridge = activity.bridge();
        if (Build.VERSION.SDK_INT >= 29) assertTrue(themeIsLight(activity));

        org.robolectric.RuntimeEnvironment.setQualifiers("+night");
        controller.configurationChange();

        assertSame("uiMode está em configChanges: a mesma tela continua", activity, controller.get());
        assertSame(web, activity.webView());
        assertFalse(bridge.isDestroyed());
        assertFalse(shadowOf(web).wasDestroyCalled());
        if (Build.VERSION.SDK_INT >= 29) {
            assertFalse("o valor é uma referência: relido no modo novo, sem recriar o tema", themeIsLight(activity));
        }
        assertEquals(0xFF0A0F1C, activity.getColor(R.color.page));
    }

    @Test
    public void rotatingDoesNotReloadThePage() {
        MainActivity activity = launch();
        WebView web = activity.webView();
        org.robolectric.RuntimeEnvironment.setQualifiers("+land");
        controller.configurationChange();
        assertSame(web, activity.webView());
        assertFalse(shadowOf(web).wasDestroyCalled());
        assertEquals(0, shadowOf(web).getReloadInvocations());
        assertFalse(activity.bridge().isDestroyed());
    }

    // ------------------------------------------------------------ manifesto

    @Test
    public void manifestDeclaresExactlyTheExpectedPermissions() throws Exception {
        PackageInfo info = Fixtures.app().getPackageManager()
                .getPackageInfo(Fixtures.app().getPackageName(), PackageManager.GET_PERMISSIONS);
        Set<String> declared = new HashSet<>(Arrays.asList(info.requestedPermissions));
        // a biblioteca androidx.core acrescenta uma permissão interna (assinatura) para receivers; não é nossa
        declared.remove("com.wifiraiox.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION");
        assertEquals(new HashSet<>(Arrays.asList(
                "android.permission.ACCESS_WIFI_STATE",
                "android.permission.CHANGE_WIFI_STATE",
                "android.permission.ACCESS_COARSE_LOCATION",
                "android.permission.ACCESS_FINE_LOCATION",
                "android.permission.NEARBY_WIFI_DEVICES",
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.INTERNET",
                "android.permission.VIBRATE")), declared);
    }

    @Test
    public void manifestKeepsThePageAliveAcrossConfigurationChanges() throws Exception {
        PackageManager pm = Fixtures.app().getPackageManager();
        ActivityInfo info = pm.getActivityInfo(new ComponentName(Fixtures.app(), MainActivity.class), 0);
        int needed = ActivityInfo.CONFIG_ORIENTATION | ActivityInfo.CONFIG_SCREEN_SIZE | ActivityInfo.CONFIG_UI_MODE
                | ActivityInfo.CONFIG_SCREEN_LAYOUT | ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE | ActivityInfo.CONFIG_KEYBOARD_HIDDEN
                | ActivityInfo.CONFIG_DENSITY | ActivityInfo.CONFIG_FONT_SCALE | ActivityInfo.CONFIG_LOCALE
                | ActivityInfo.CONFIG_MCC | ActivityInfo.CONFIG_MNC // troca de chip / modo avião
                | ActivityInfo.CONFIG_KEYBOARD | ActivityInfo.CONFIG_NAVIGATION | ActivityInfo.CONFIG_TOUCHSCREEN
                | ActivityInfo.CONFIG_LAYOUT_DIRECTION;
        assertEquals("girar a tela ou trocar o tema não pode recarregar a página", needed, info.configChanges & needed);
        assertEquals("orientação livre: o mapa 3D ganha com a tela deitada",
                ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, info.screenOrientation);
        assertTrue(info.exported);

        ApplicationInfo app = pm.getApplicationInfo(Fixtures.app().getPackageName(), 0);
        assertEquals(0, app.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);
        assertEquals("WiFi Raio-X", pm.getApplicationLabel(app).toString());
        assertEquals(34, app.targetSdkVersion);
    }
}
