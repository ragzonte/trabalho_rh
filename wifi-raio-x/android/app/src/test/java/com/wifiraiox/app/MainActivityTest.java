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
    public void bundledAssetsAreServedWithTheRightTypes() throws Exception {
        MainActivity activity = launch();
        WebViewClient client = shadowOf(activity.webView()).getWebViewClient();

        WebResourceResponse index = client.shouldInterceptRequest(activity.webView(), request(WebClient.START_URL, true));
        assertNotNull(index);
        assertEquals(200, index.getStatusCode());
        assertEquals("text/html", index.getMimeType());
        assertEquals("UTF-8", index.getEncoding());
        assertTrue(body(index).toLowerCase().contains("<!doctype html>"));
        assertEquals("quadros de outros sites ficam proibidos na página", "frame-src 'self' blob: data:",
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

        // recursos de terceiros (imagem, fetch) não são da nossa conta
        assertNull(client.shouldInterceptRequest(web, request("https://cdn.example/lib.js", false)));

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

        controller.start().resume(); // volta para a frente
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
        assertEquals(1, activity.bridge().pendingCalls());
        controller.destroy(); // o Android pode pular etapas quando mata a tela
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        assertEquals("ninguém fica esperando resposta", 0, activity.bridge().pendingCalls());
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
    public void secondBackWhileThePageIsStuckLeavesAnyway() {
        MainActivity activity = launch();
        activity.onBackPressed();
        assertFalse(activity.isFinishing());
        activity.onBackPressed(); // a página não respondeu ao primeiro
        assertTrue(activity.isFinishing());
        // a resposta atrasada não faz mais nada
        shadowOf(activity.webView()).getLastEvaluatedJavascriptCallback().onReceiveValue("true");
        assertTrue(activity.isFinishing());
    }

    @Test
    public void rendererDeathRecreatesInsteadOfCrashing() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity.lastRendererGoneAt = -1;
        MainActivity activity = launch();
        WebViewClient client = shadowOf(activity.webView()).getWebViewClient();
        assertTrue("true = tratado; false derrubaria o app", client.onRenderProcessGone(activity.webView(), null));
        assertFalse("a primeira vez recria a tela", activity.isFinishing());

        // morreu de novo logo depois: recriar entraria em laço, então fecha
        assertTrue(client.onRenderProcessGone(activity.webView(), null));
        assertTrue(activity.isFinishing());

        // muito tempo depois é outro episódio: recria de novo
        MainActivity.lastRendererGoneAt = -1;
        MainActivity later = launch();
        org.robolectric.shadows.ShadowSystemClock.advanceBy(60, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(shadowOf(later.webView()).getWebViewClient().onRenderProcessGone(later.webView(), null));
        org.robolectric.shadows.ShadowSystemClock.advanceBy(60, java.util.concurrent.TimeUnit.SECONDS);
        assertTrue(shadowOf(later.webView()).getWebViewClient().onRenderProcessGone(later.webView(), null));
        assertFalse(later.isFinishing());
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
                "android.permission.CHANGE_WIFI_MULTICAST_STATE",
                "android.permission.VIBRATE")), declared);
    }

    @Test
    public void manifestKeepsThePageAliveAcrossConfigurationChanges() throws Exception {
        PackageManager pm = Fixtures.app().getPackageManager();
        ActivityInfo info = pm.getActivityInfo(new ComponentName(Fixtures.app(), MainActivity.class), 0);
        int needed = ActivityInfo.CONFIG_ORIENTATION | ActivityInfo.CONFIG_SCREEN_SIZE | ActivityInfo.CONFIG_UI_MODE
                | ActivityInfo.CONFIG_SCREEN_LAYOUT | ActivityInfo.CONFIG_SMALLEST_SCREEN_SIZE | ActivityInfo.CONFIG_KEYBOARD_HIDDEN
                | ActivityInfo.CONFIG_DENSITY | ActivityInfo.CONFIG_FONT_SCALE | ActivityInfo.CONFIG_LOCALE;
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
