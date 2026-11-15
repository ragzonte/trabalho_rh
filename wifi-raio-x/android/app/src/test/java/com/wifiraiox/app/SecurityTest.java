package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.junit.Assume.assumeTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.robolectric.Robolectric;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * O app guarda a permissão de localização e fala com a rede local: tudo o que vem da página é
 * tratado como entrada de um estranho (mesmo sendo a nossa página), e nada de fora do APK pode
 * chegar à ponte nativa. Cada teste aqui é um ataque concreto que tem de falhar.
 */
public class SecurityTest extends AllSdks {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Activity activity;
    private Fixtures.Page page;
    private ScheduledExecutorService watchdog;
    private final List<Bridge> bridges = new ArrayList<>();

    @Before
    public void setUp() {
        Fixtures.forgetFileProviderPaths();
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        watchdog = Executors.newSingleThreadScheduledExecutor();
    }

    @After
    public void tearDown() {
        for (Bridge b : bridges) b.onDestroy();
        watchdog.shutdownNow();
    }

    private Bridge bridge(Pinger pinger, LanScanner lan) {
        Bridge b = Fixtures.bridge(activity, page, pinger, lan, new SpeedTester("http://127.0.0.1:9", network -> url -> {
            throw new java.net.UnknownHostException("sem internet nos testes");
        }, null));
        bridges.add(b);
        return b;
    }

    private Bridge bridge() {
        return bridge(new Pinger("/nao/existe", null, host -> InetAddress.getByAddress(host, new byte[] {10, 1, 2, 3}),
                new Pinger.Prober[] {(a, t) -> 3.0}, watchdog), null);
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
                return false;
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

    // ------------------------------------------------------------------ a ponte e quem a alcança

    @Test
    public void thePageSeesExactlyTwoMethodsOfTheBridge() {
        Set<String> exposed = new TreeSet<>();
        for (Class<?> c = Bridge.class; c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (m.isAnnotationPresent(JavascriptInterface.class)) exposed.add(m.getName() + Arrays.toString(m.getParameterTypes()));
            }
        }
        for (Class<?> i : Bridge.class.getInterfaces()) {
            for (Method m : i.getMethods()) assertFalse(m.isAnnotationPresent(JavascriptInterface.class));
        }
        assertEquals("só call e callAsync, com os tipos do contrato",
                new TreeSet<>(Arrays.asList("call[class java.lang.String, class java.lang.String]",
                        "callAsync[int, class java.lang.String, class java.lang.String]")), exposed);
        assertTrue("ninguém estende a ponte para pendurar mais métodos", Modifier.isFinal(Bridge.class.getModifiers()));
        for (Field f : Bridge.class.getFields()) {
            assertTrue("campo público que não é constante: " + f, Modifier.isStatic(f.getModifiers()) && Modifier.isFinal(f.getModifiers()));
        }
        // Do Android 4.2 em diante só métodos anotados ficam visíveis; nenhuma outra classe do app é anotada.
        for (String other : new String[] {"MainActivity", "WebClient", "WebAssets", "Sharer", "Pinger", "LanScanner", "Permissions"}) {
            try {
                for (Method m : Class.forName("com.wifiraiox.app." + other).getDeclaredMethods()) {
                    assertFalse(other + "." + m.getName(), m.isAnnotationPresent(JavascriptInterface.class));
                }
            } catch (ClassNotFoundException e) {
                fail(other);
            }
        }
    }

    @Test
    public void onlyOneObjectIsInjectedAndOnlyUnderTheContractName() {
        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebView web = main.webView();
        assertTrue(shadowOf(web).getJavascriptInterface(Bridge.JS_NAME) instanceof Bridge);
        for (String other : new String[] {"Android", "android", "native", "bridge", "wrx", "Wrx", "WrxNative2", "__wrx"}) {
            assertNull(other, shadowOf(web).getJavascriptInterface(other));
        }
    }

    @Test
    public void nothingFromOutsideTheApkIsEverFetchedIntoThePage() throws Exception {
        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebView web = main.webView();
        WebViewClient client = shadowOf(web).getWebViewClient();
        String[] foreign = {
            "https://evil.example/x.js", "http://evil.example/x.js", "https://cdn.jsdelivr.net/npm/three", "https://speed.cloudflare.com/__down?bytes=1",
            "http://appassets.androidplatform.net/assets/www/js/main.js",       // o nosso domínio, mas sem TLS
            "https://appassets.androidplatform.net:8443/assets/www/js/main.js", // outra porta = outra origem
            "https://appassets.androidplatform.net.evil.example/assets/www/js/main.js",
            "https://APPASSETS.ANDROIDPLATFORM.NET.evil.example/",
            "https://evil.example/appassets.androidplatform.net/assets/www/index.html",
            "https://user:pw@evil.example/", "ws://evil.example/socket", "wss://evil.example/socket", "ftp://evil.example/x",
            "file:///data/data/com.wifiraiox.app/shared_prefs/wrx_permissions.xml", "file:///android_asset/www/index.html",
            "content://com.wifiraiox.app.fileprovider/shared/x", "content://media/external/images/media/1",
            "intent://scan/#Intent;scheme=zxing;end", "market://details?id=x", "chrome://version", "javascript:alert(1)", "view-source:https://x",
        };
        for (boolean mainFrame : new boolean[] {false, true}) {
            for (String url : foreign) {
                WebResourceResponse r = client.shouldInterceptRequest(web, request(url, mainFrame));
                assertNotNull(url + " seguiria para a rede/arquivo", r);
                assertEquals(url, 403, r.getStatusCode());
                assertEquals("resposta vazia: nenhum conteúdo de fora entra", 0, r.getData().available());
            }
        }
        // o que o WebView resolve na memória segue normal em sub-recursos (ícone embutido, worker, imagem gerada)
        for (String local : new String[] {"data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "blob:https://appassets.androidplatform.net/1b2c", "about:blank"}) {
            assertNull(local, client.shouldInterceptRequest(web, request(local, false)));
            assertEquals("mas nunca como página principal: " + local, 403,
                    client.shouldInterceptRequest(web, request(local, true)).getStatusCode());
        }
        // e o que é do app continua servido (ou 404 na hora, sem ir procurar o domínio reservado na internet)
        assertEquals(200, client.shouldInterceptRequest(web, request(WebClient.START_URL, true)).getStatusCode());
        assertEquals(200, client.shouldInterceptRequest(web,
                request("https://appassets.androidplatform.net/assets/www/js/bridge.js", false)).getStatusCode());
        for (String missing : new String[] {"https://appassets.androidplatform.net/", "https://appassets.androidplatform.net/outra/pasta.js",
                "https://appassets.androidplatform.net/assets/www/../../AndroidManifest.xml",
                "https://appassets.androidplatform.net/assets/www/%2e%2e/%2e%2e/classes.dex",
                "https://appassets.androidplatform.net/assets/www/js/..%2f..%2f..%2fAndroidManifest.xml",
                "https://appassets.androidplatform.net/assets/www/js\\..\\..\\x", "https://appassets.androidplatform.net/assets/www/a%00b.js",
                "https://appassets.androidplatform.net/res/xml/file_paths.xml"}) {
            assertEquals(missing, 404, client.shouldInterceptRequest(web, request(missing, false)).getStatusCode());
        }
    }

    @Test
    public void noNavigationLeavesTheAppOrigin() {
        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebView web = main.webView();
        WebViewClient client = shadowOf(web).getWebViewClient();
        String[] away = {
            "https://evil.example/", "http://appassets.androidplatform.net/assets/www/index.html",
            "https://appassets.androidplatform.net:444/assets/www/index.html", "https://appassets.androidplatform.net./assets/www/index.html",
            "https://APPASSETS.androidplatform.net/assets/www/index.html", // o Android não iguala maiúsculas: fecha por via das dúvidas
            "file:///android_asset/www/index.html", "content://com.wifiraiox.app.fileprovider/shared/x.html",
            "data:text/html,<script>WrxNative.call('lastScan','{}')</script>", "blob:https://appassets.androidplatform.net/1b2c",
            "about:blank", "javascript:WrxNative.call('lastScan','{}')", "intent://x/#Intent;scheme=http;end",
            "intent:#Intent;component=com.wifiraiox.app/.MainActivity;end", "market://details?id=x", "ws://evil.example/", "ftp://evil.example/",
        };
        for (boolean mainFrame : new boolean[] {true, false}) {
            for (String url : away) {
                assertTrue(url, client.shouldOverrideUrlLoading(web, request(url, mainFrame)));
                Intent started = shadowOf(main).getNextStartedActivity();
                if (started != null) {
                    // só um link comum, na página principal, vai para o navegador; nada mais vira Intent
                    assertTrue(url, mainFrame && (url.startsWith("http:") || url.startsWith("https:")));
                    assertEquals(Intent.ACTION_VIEW, started.getAction());
                    assertNull("nunca um Intent dirigido a um componente", started.getComponent());
                    assertEquals(url, started.getDataString());
                }
            }
        }
        // se mesmo assim a página principal mudar de endereço, a ponte se cala na hora
        Bridge b = main.bridge();
        for (String url : away) {
            client.onPageStarted(web, url, null);
            assertEquals(url, Bridge.ERR_FORBIDDEN, parse(b.call("lastScan", "{}")).optString("error"));
        }
        client.onPageStarted(web, WebClient.START_URL, null);
        assertTrue(parse(b.call("lastScan", "{}")).has("aps"));
    }

    private static JSONObject parse(String json) {
        try {
            return new JSONObject(json);
        } catch (org.json.JSONException e) {
            throw new AssertionError(json, e);
        }
    }

    // ------------------------------------------------------------------ política da página

    private static Map<String, List<String>> directives(String policy) {
        Map<String, List<String>> out = new HashMap<>();
        for (String part : policy.split(";")) {
            String[] words = part.trim().split("\\s+");
            assertNull("diretiva repetida: " + words[0], out.put(words[0], Arrays.asList(words).subList(1, words.length)));
        }
        return out;
    }

    @Test
    public void thePagePolicyKeepsInjectedContentAwayFromTheBridge() throws Exception {
        Map<String, List<String>> csp = directives(WebAssets.PAGE_POLICY);
        // um nome de rede como <img src=x onerror=...> ou <script>...</script> não pode executar nada
        assertEquals("só script que veio do APK", Arrays.asList("'self'"), csp.get("script-src"));
        assertEquals(Arrays.asList("'self'"), csp.get("default-src"));
        assertEquals(Arrays.asList("'none'"), csp.get("object-src"));
        assertEquals("sem <base> para desviar os módulos", Arrays.asList("'none'"), csp.get("base-uri"));
        assertEquals("a página não fala com a rede", Arrays.asList("'self'"), csp.get("connect-src"));
        assertEquals("formulário não envia nada para fora", Arrays.asList("'none'"), csp.get("form-action"));
        // a ponte é injetada em todo quadro: só os do próprio APK podem existir (nada de data:/blob:/outros sites)
        assertEquals(Arrays.asList("'self'"), csp.get("frame-src"));
        for (Map.Entry<String, List<String>> d : csp.entrySet()) {
            for (String source : d.getValue()) {
                assertFalse(d.getKey() + " libera a rede: " + source, source.startsWith("http") || source.equals("*") || source.startsWith("ws"));
                if (!d.getKey().equals("style-src")) assertFalse(d.getKey() + " " + source, source.contains("unsafe"));
            }
        }
        // e é esta a política que acompanha cada página HTML servida
        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        WebViewClient client = shadowOf(main.webView()).getWebViewClient();
        WebResourceResponse index = client.shouldInterceptRequest(main.webView(), request(WebClient.START_URL, true));
        assertEquals(WebAssets.PAGE_POLICY, index.getResponseHeaders().get("Content-Security-Policy"));
        WebResourceResponse framed = client.shouldInterceptRequest(main.webView(), request(WebClient.START_URL + "?quadro", false));
        assertEquals(WebAssets.PAGE_POLICY, framed.getResponseHeaders().get("Content-Security-Policy"));
    }

    @Test
    public void thePackagedPagesCanRunUnderThePolicy() throws Exception {
        // Se a interface ganhar um <script> em linha, um onclick="" ou um endereço de fora, ela pararia
        // de funcionar só no celular (a política bloqueia em silêncio). Aqui a compilação avisa antes.
        File www = new File(System.getProperty("user.dir"), "build/generated/web/www");
        assertTrue("cópia da interface não encontrada em " + www, new File(www, "index.html").isFile());
        List<File> pages = new ArrayList<>();
        collectHtml(www, pages);
        assertFalse(pages.isEmpty());
        for (File file : pages) {
            String html = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
            java.util.regex.Matcher script = java.util.regex.Pattern.compile("(?is)<script\\b([^>]*)>(.*?)</script>").matcher(html);
            while (script.find()) {
                assertTrue(file.getName() + ": <script> sem src não roda sob a política da página", script.group(1).matches("(?is).*\\bsrc\\s*=.*"));
                assertTrue(file.getName() + ": <script src> com conteúdo em linha", script.group(2).trim().isEmpty());
                assertFalse(file.getName() + ": script de outro site", script.group(1).matches("(?is).*\\bsrc\\s*=\\s*[\"']?(https?:)?//.*"));
            }
            assertFalse(file.getName() + ": atributo on...=\"\" não roda sob a política da página",
                    java.util.regex.Pattern.compile("(?is)<[a-z][^>]*\\son[a-z]+\\s*=").matcher(html).find());
            assertFalse(file.getName() + ": endereço javascript:", html.toLowerCase().contains("javascript:"));
            assertFalse(file.getName() + ": <iframe>/<object>/<embed> não combinam com a política",
                    java.util.regex.Pattern.compile("(?i)<(iframe|object|embed|base)\\b").matcher(html).find());
            assertFalse(file.getName() + ": folha de estilo ou módulo de outro site",
                    java.util.regex.Pattern.compile("(?is)<link\\b[^>]*\\bhref\\s*=\\s*[\"']?(https?:)?//").matcher(html).find());
        }
    }

    private static void collectHtml(File dir, List<File> out) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            if (f.isDirectory()) collectHtml(f, out);
            else if (f.getName().endsWith(".html") || f.getName().endsWith(".htm")) out.add(f);
        }
    }

    @Test
    @Config(shadows = DebugFlagWebView.class)
    public void remoteInspectionOfThePageOnlyInDebuggableBuilds() {
        ApplicationInfo info = Fixtures.app().getApplicationInfo();
        info.flags |= ApplicationInfo.FLAG_DEBUGGABLE;
        Robolectric.buildActivity(MainActivity.class).setup();
        assertEquals("versão de desenvolvimento: chrome://inspect liberado", Boolean.TRUE, DebugFlagWebView.debugging);

        info.flags &= ~ApplicationInfo.FLAG_DEBUGGABLE;
        DebugFlagWebView.debugging = null;
        MainActivity release = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertEquals("versão de loja: desligado explicitamente (um cabo USB não pode dirigir a ponte)", Boolean.FALSE, DebugFlagWebView.debugging);

        // e o console da página (que pode citar nomes de rede) não vai para o logcat
        ShadowLog.clear();
        shadowOf(release.webView()).getWebChromeClient().onConsoleMessage(
                new ConsoleMessage("rede SEGREDO-DA-CASA a4:91:b1:00:11:22", "main.js", 1, ConsoleMessage.MessageLevel.LOG));
        for (ShadowLog.LogItem item : ShadowLog.getLogs()) assertFalse(String.valueOf(item.msg), String.valueOf(item.msg).contains("SEGREDO"));
        info.flags |= ApplicationInfo.FLAG_DEBUGGABLE;
    }

    // ------------------------------------------------------------------ nada de nomes de rede no logcat

    @Test
    public void networkNamesAndAddressesNeverReachTheLog() throws Exception {
        ApplicationInfo info = Fixtures.app().getApplicationInfo();
        info.flags &= ~ApplicationInfo.FLAG_DEBUGGABLE;
        ShadowLog.clear();
        Fixtures.grantLocation();
        ScanResult ap = Fixtures.scanResult("SEGREDO-DA-CASA", "A4:91:B1:5E:C2:E7", "[WPA2-PSK-CCMP][ESS]", -48, 5180);
        ap.timestamp = SystemClock.elapsedRealtime() * 1000;
        Fixtures.wifi().setScanResults(Arrays.asList(ap, null));
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo("SEGREDO-DA-CASA", "A4:91:B1:5E:C2:E7", -52, 433, 5180));
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"192.168.77.37/24"}, "192.168.77.1", "192.168.77.1"),
                NetworkCapabilities.NET_CAPABILITY_INTERNET);

        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        Bridge b = main.bridge();
        assertTrue(b.call("lastScan", "{}").contains("SEGREDO-DA-CASA"));
        assertTrue(b.call("connection", "{}").contains("a4:91:b1:5e:c2:e7"));
        b.call("watchRssi", "{\"intervalMs\":250}");
        b.callAsync(1, "scan", "{}");
        main.sendBroadcast(new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        b.callAsync(2, "rtt", "{\"bssids\":[\"a4:91:b1:5e:c2:e7\"]}");
        b.callAsync(3, "ping", "{\"host\":\"-SEGREDO-DA-CASA\"}");
        b.call("share", "{\"title\":\"SEGREDO-DA-CASA\",\"text\":\"SEGREDO-DA-CASA a4:91:b1:5e:c2:e7\"}");
        b.call("saveFile", "{\"name\":\"SEGREDO-DA-CASA.csv\",\"text\":\"SEGREDO-DA-CASA;a4:91:b1:5e:c2:e7\"}");
        b.call("naoExiste", "{\"SEGREDO-DA-CASA\":1}");
        b.call("info", "{SEGREDO-DA-CASA");
        org.robolectric.shadows.ShadowLooper.idleMainLooper(2, TimeUnit.SECONDS);
        Thread.sleep(200);
        Fixtures.idle();
        main.finish();

        for (ShadowLog.LogItem item : ShadowLog.getLogs()) {
            String text = (item.msg + " " + (item.throwable == null ? "" : item.throwable)).toLowerCase();
            for (String secret : new String[] {"segredo", "a4:91:b1:5e:c2:e7", "192.168.77."}) {
                assertFalse("[" + item.tag + "] " + item.msg, text.contains(secret));
            }
        }
        info.flags |= ApplicationInfo.FLAG_DEBUGGABLE;
    }

    // ------------------------------------------------------------------ ping

    private File argsFile;

    private String fakePing(String body) throws Exception {
        argsFile = new File(tmp.getRoot(), "args-" + System.nanoTime() + ".txt");
        File f = tmp.newFile();
        String script = "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '" + argsFile.getAbsolutePath() + "'\n" + body + "\n";
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(script.getBytes(StandardCharsets.UTF_8));
        }
        assertTrue(f.setExecutable(true));
        return f.getAbsolutePath();
    }

    @Test
    @Config(sdk = 34) // processo de verdade: a versão do Android não muda nada
    public void whateverThePageAsksThePingProgramOnlyGetsNumbers() throws Exception {
        assumeTrue(new File("/bin/sh").canExecute());
        String program = fakePing("echo '64 bytes from x: icmp_seq=1 ttl=64 time=1.0 ms'");
        final List<String> resolved = Collections.synchronizedList(new ArrayList<>());
        Pinger pinger = new Pinger(program, program, host -> {
            resolved.add(host);
            if (host.indexOf('%') >= 0) { // endereço de enlace com escopo, como o Android o devolve
                byte[] linkLocal = new byte[16];
                linkLocal[0] = (byte) 0xfe;
                linkLocal[1] = (byte) 0x80;
                linkLocal[15] = 1;
                return java.net.Inet6Address.getByAddress(null, linkLocal, 3);
            }
            return InetAddress.getByName(PingHost.isIpv4(host) || PingHost.isIpv6(host) ? host : "203.0.113.9");
        }, new Pinger.Prober[] {(a, t) -> -1}, watchdog);
        // tudo isto passa pela validação; nada disto pode chegar ao programa como veio
        String[] hosts = {"exemplo.com.br", "a_b.local", "LOCALHOST", "8.8.8.8", "0.0.0.0", "255.255.255.255", "224.0.0.1",
            "::1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "fe80::1%lo", "1e100.net", "xn--caf-dma.example", "example.com."};
        Object[][] numbers = {{1, 1000}, {50, 5000}, {Integer.MAX_VALUE, Integer.MAX_VALUE}, {Integer.MIN_VALUE, Integer.MIN_VALUE}, {0, 0}};
        int n = 0;
        for (String host : hosts) {
            Object[] pair = numbers[n++ % numbers.length];
            JSONObject summary = pinger.run(host, (Integer) pair[0], (Integer) pair[1], r -> { });
            assertFalse(host + " -> " + summary, summary.has("error"));
            List<String> args = Files.readAllLines(argsFile.toPath());
            assertEquals(host, 7, args.size());
            assertEquals(Arrays.asList("-c", "-i", "0.2", "-W"), Arrays.asList(args.get(0), args.get(2), args.get(3), args.get(4)));
            int count = Integer.parseInt(args.get(1));
            int wait = Integer.parseInt(args.get(5));
            assertTrue(host, count >= 1 && count <= 50 && wait >= 1 && wait <= 5);
            String target = args.get(6);
            assertTrue(host + " -> " + target, target.matches("[0-9.]{7,15}|[0-9a-f:.]{2,45}(%[0-9a-z]{1,16})?"));
            assertFalse(target.startsWith("-"));
        }
        assertEquals("cada destino foi resolvido aqui, antes de o programa rodar", hosts.length, resolved.size());
    }

    @Test
    public void lookAlikeAndSmuggledHostsAreRefusedBeforeAnythingRuns() throws Exception {
        final AtomicInteger resolutions = new AtomicInteger();
        Pinger pinger = new Pinger("/nao/existe", null, host -> {
            resolutions.incrementAndGet();
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 1.0}, watchdog);
        Bridge b = bridge(pinger, null);
        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 200_000; i++) huge.append('a');
        String[] attacks = {
            "-c", "--", "-I wlan0 8.8.8.8", "8.8.8.8 -f", "8.8.8.8\n-f", "8.8.8.8\u0000-f", "\u00008.8.8.8", "8.8.8.8;id", "$(id)", "`id`",
            "８.８.８.８",                 // algarismos de largura cheia
            "１::１", "：:1", "fe80::１",   // IPv6 com algarismos e dois-pontos de outros alfabetos
            "٨.٨.٨.٨",                     // algarismos arábicos
            "ｅｘａｍｐｌｅ.com", "exаmple.com", // letras de largura cheia; "а" cirílico
            "example。com", "example．com",  // pontos de outros alfabetos
            "exam\u200Bple.com", "\u202Emoc.elpmaxe", "example.com\u0085", "a\u00A0b.com",
            "fe80::1%wlan0%lo", "fe80::1%", "fe80::1%wlan0 -f", "fe80::1%../../x", "fe80::1%wlan-0", "fe80::1%ｗlan0",
            "fe80::1%abcdefghijklmnopq",   // escopo longo demais
            "[::1]", "::1/128", "http://8.8.8.8", "8.8.8.8:53", "8.8.8.8/24", "134744072", "010.010.010.010.",
            huge.toString(), huge + ".com", "",
        };
        int id = 1;
        for (String host : attacks) {
            b.callAsync(id, "ping", new JSONObject().put("host", host).toString());
            JSONObject r = page.resolved(id); // recusado na própria chamada, antes de qualquer thread
            assertNotNull(host, r);
            assertEquals(host.length() > 60 ? "(texto enorme)" : host, Pinger.ERR_INVALID_HOST, r.optString("error"));
            id++;
        }
        assertEquals("nem uma consulta de DNS", 0, resolutions.get());
        assertTrue(page.events("ping").isEmpty());
        assertEquals(0, b.pendingCalls());
    }

    @Test
    public void pingStartsAreRateLimited() throws Exception {
        final AtomicLong clock = new AtomicLong(1_000_000_000L);
        Pinger.Limiter limiter = new Pinger.Limiter(Pinger.START_BURST, Pinger.START_EVERY_MS, clock::get);
        final AtomicInteger resolutions = new AtomicInteger();
        Pinger pinger = new Pinger("/nao/existe", null, host -> {
            resolutions.incrementAndGet();
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 1.0}, watchdog, limiter);

        // uma varredura de endereços disfarçada de ping: um destino diferente por chamada, sem parar
        int started = 0;
        int refused = 0;
        for (int i = 0; i < 300; i++) {
            JSONObject r = pinger.run("198.51.100." + (i % 250 + 1), 1, 200, reply -> { });
            if (r.has("error")) {
                assertEquals(Pinger.ERR_TOO_MANY, r.get("error"));
                refused++;
            } else {
                started++;
            }
        }
        assertEquals("só a rajada inicial passa", Pinger.START_BURST, started);
        assertEquals(300 - Pinger.START_BURST, refused);
        assertEquals("os recusados não tocam nem no DNS", Pinger.START_BURST, resolutions.get());

        // o freio solta um por segundo, e nunca acumula além da rajada
        clock.addAndGet(TimeUnit.MILLISECONDS.toNanos(Pinger.START_EVERY_MS));
        assertFalse(pinger.run("198.51.100.7", 1, 200, reply -> { }).has("error"));
        assertEquals(Pinger.ERR_TOO_MANY, pinger.run("198.51.100.8", 1, 200, reply -> { }).get("error"));
        clock.addAndGet(TimeUnit.HOURS.toNanos(5));
        int burst = 0;
        while (!pinger.run("198.51.100.9", 1, 200, reply -> { }).has("error")) burst++;
        assertEquals(Pinger.START_BURST, burst);

        // destino inválido não gasta a cota
        clock.addAndGet(TimeUnit.HOURS.toNanos(5));
        for (int i = 0; i < 100; i++) assertEquals(Pinger.ERR_INVALID_HOST, pinger.run("-f", 1, 200, reply -> { }).get("error"));
        assertFalse(pinger.run("198.51.100.10", 1, 200, reply -> { }).has("error"));

        assertTrue("o ping de verdade (o do app) nasce com o freio", new Pinger(watchdog).rateLimited());
    }

    @Test
    public void aRefusedPingLeavesTheRunningOneAloneAndAnswersOnce() throws Exception {
        final AtomicLong clock = new AtomicLong(5_000_000_000L);
        final CountDownLatch release = new CountDownLatch(1);
        Pinger pinger = new Pinger("/nao/existe", null, host -> {
            if (host.startsWith("lento")) release.await(20, TimeUnit.SECONDS);
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 1.0}, watchdog, new Pinger.Limiter(2, 1000, clock::get));
        Bridge b = bridge(pinger, null);
        b.callAsync(1, "ping", "{\"host\":\"rapido.exemplo\",\"count\":1}");
        assertEquals(1, page.awaitResolved(1, 10_000).get("received"));
        b.callAsync(2, "ping", "{\"host\":\"lento.exemplo\",\"count\":1}");
        Thread.sleep(100);
        b.callAsync(3, "ping", "{\"host\":\"demais.exemplo\",\"count\":1}"); // cota esgotada
        assertEquals(Pinger.ERR_TOO_MANY, page.awaitResolved(3, 10_000).get("error"));
        assertNull("o ping em andamento não foi interrompido pelo recusado", page.resolved(2));
        release.countDown();
        JSONObject slow = page.awaitResolved(2, 10_000);
        assertEquals("terminou a série dele", 1, slow.get("received"));
        assertEquals(0, b.pendingCalls());
    }

    // ------------------------------------------------------------------ muitas chamadas

    @Test
    public void aLoopingPageCannotPileUpUnansweredCalls() throws Exception {
        Fixtures.denyLocation();
        Bridge b = bridge();
        // o pedido de permissão fica esperando o diálogo; a página pede 500 vezes sem esperar resposta
        int id = 1;
        for (int i = 0; i < 500; i++) b.callAsync(id++, "requestPermission", "{}");
        Fixtures.idle();
        assertEquals("o que passa do teto é recusado na hora", Bridge.MAX_PENDING, b.pendingCalls());
        int refused = 0;
        for (int i = 1; i < id; i++) {
            JSONObject r = page.resolved(i);
            if (r == null) continue;
            assertEquals(Bridge.ERR_BUSY, r.get("error"));
            refused++;
        }
        assertEquals(500 - Bridge.MAX_PENDING, refused);
        // o caminho imediato continua atendido; o assíncrono recusa até abrir vaga
        assertEquals("android", parse(b.call("info", "{}")).get("platform"));
        b.callAsync(9001, "scan", "{}");
        assertEquals(Bridge.ERR_BUSY, page.resolved(9001).get("error"));

        // respondido o diálogo, tudo volta ao normal e ninguém ficou sem resposta
        b.onPermissionsResult(Permissions.REQUEST_LOCATION, new String[] {Fixtures.FINE, Fixtures.COARSE},
                new int[] {PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_DENIED});
        Fixtures.idle();
        assertEquals(0, b.pendingCalls());
        for (int i = 1; i < id; i++) assertNotNull("id " + i, page.resolved(i)); // resolved() falha se houver resposta em dobro
        b.callAsync(9002, "scan", "{}");
        assertTrue(page.resolved(9002).has("accepted"));
    }

    // ------------------------------------------------------------------ arquivos e compartilhamento

    private File sharedDir() {
        return new File(activity.getCacheDir(), Sharer.FOLDER);
    }

    @Test
    public void noFileNameEscapesTheSharedFolder() throws Exception {
        Bridge b = bridge();
        File outside = new File(activity.getFilesDir(), "segredo.txt");
        Files.write(outside.toPath(), "intacto".getBytes(StandardCharsets.UTF_8));
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 5000; i++) longName.append(i % 7 == 0 ? 'ç' : 'x');
        StringBuilder deep = new StringBuilder();
        for (int i = 0; i < 2000; i++) deep.append("../");
        String[] names = {
            "../../files/segredo.txt", "..\\..\\files\\segredo.txt", outside.getAbsolutePath(), "/data/data/com.wifiraiox.app/files/segredo.txt",
            "file:///" + outside.getAbsolutePath(), "content://com.wifiraiox.app.fileprovider/shared/../../files/segredo.txt",
            deep + "etc/passwd", "....//....//files/segredo.txt", "..%2f..%2ffiles%2fsegredo.txt", "%2e%2e/segredo.txt", "..\u2215..\u2215segredo.txt",
            "a\u0000/../../files/segredo.txt", "segredo.txt\u0000.png", "\u0000", "..", ".", "...", " .. ", "~/segredo.txt", "$HOME/x", "`id`.txt",
            "con", "nul.txt", "aux", "a:b", "a|b", "a*b?", "<script>.html", "nome\r\ncom\tcontrole.txt", "\u202Etxt.exe", "\uD83D\uDCF6.txt",
            longName.toString(), longName + ".csv", "." + longName, "-rf", "--help", "shared", "shared/", "../shared/x",
        };
        Set<String> written = new HashSet<>();
        for (String name : names) {
            String reply = b.call("saveFile", new JSONObject().put("name", name).put("text", "x").toString());
            JSONObject r = parse(reply);
            if (r.has("error")) continue; // nome vazio depois de aparado: argumento inválido
            assertEquals(name.length() > 80 ? "(nome enorme)" : name, true, r.get("ok"));
            Intent chooser = shadowOf(activity).getNextStartedActivity();
            Intent send = chooser.getParcelableExtra(Intent.EXTRA_INTENT);
            Uri uri = send.getParcelableExtra(Intent.EXTRA_STREAM);
            assertEquals("content", uri.getScheme());
            assertEquals("com.wifiraiox.app.fileprovider", uri.getAuthority());
            List<String> segments = uri.getPathSegments();
            assertEquals(String.valueOf(uri), 2, segments.size());
            assertEquals("shared", segments.get(0));
            String stored = segments.get(1);
            assertFalse(stored, stored.contains("/") || stored.contains("\\") || stored.startsWith(".") || stored.contains("\u0000"));
            assertTrue(stored, stored.length() <= 80 && stored.getBytes(StandardCharsets.UTF_8).length <= 255);
            for (int i = 0; i < stored.length(); i++) assertFalse(Character.isISOControl(stored.charAt(i)));
            assertFalse("nada de inverter a direção do texto para disfarçar a extensão", stored.contains("\u202E"));
            written.add(stored);
        }
        assertTrue(written.size() > 10);
        // tudo o que existe está dentro de cache/shared, e nada fora dela foi tocado
        File[] inside = sharedDir().listFiles();
        assertNotNull(inside);
        for (File f : inside) {
            assertTrue(f.isFile());
            assertEquals(sharedDir().getCanonicalFile(), f.getCanonicalFile().getParentFile());
        }
        assertEquals("intacto", new String(Files.readAllBytes(outside.toPath()), StandardCharsets.UTF_8));
        File[] cacheRoot = activity.getCacheDir().listFiles();
        assertNotNull(cacheRoot);
        for (File f : cacheRoot) assertTrue("criado fora da pasta de exportação: " + f, f.isDirectory());
    }

    @Test
    public void exportsCannotFillTheStorage() throws Exception {
        Bridge b = bridge();
        long now = System.currentTimeMillis();
        for (int i = 0; i < 40; i++) {
            assertEquals("{\"ok\":true}", b.call("saveFile", "{\"name\":\"mapa-" + i + ".json\",\"text\":\"{}\"}"));
            // datas distintas, como numa sequência de exportações de verdade
            assertTrue(new File(sharedDir(), "mapa-" + i + ".json").setLastModified(now - (40 - i) * 1000L));
        }
        String[] left = sharedDir().list();
        assertNotNull(left);
        assertEquals("ficam só as últimas", Sharer.MAX_FILES, left.length);
        for (int i = 40 - Sharer.MAX_FILES; i < 40; i++) assertTrue(new File(sharedDir(), "mapa-" + i + ".json").isFile());

        if (Build.VERSION.SDK_INT != 34) return; // textos de dezenas de MB: uma versão do Android basta
        // tamanho: 20 MB por arquivo, medido antes de decodificar o base64
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < 1024; i++) big.append("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"); // 64 KiB
        String chunk = big.toString();
        StringBuilder tooBig = new StringBuilder((int) Sharer.MAX_BYTES + chunk.length());
        while (tooBig.length() <= Sharer.MAX_BYTES) tooBig.append(chunk);
        assertNull(Sharer.payload(tooBig.toString(), null));
        assertNull("base64 que viraria mais de 20 MB nem é decodificado",
                Sharer.payload(null, tooBig.toString() + tooBig.substring(0, tooBig.length() / 2)));
        assertEquals("{\"ok\":false}", b.call("saveFile", new JSONObject().put("name", "enorme.bin").put("text", tooBig.toString()).toString()));
        assertFalse(new File(sharedDir(), "enorme.bin").exists());
        assertEquals(Sharer.MAX_FILES, sharedDir().list().length);
    }

    @Test
    public void whatIsNotBase64IsAnErrorNotACorruptedFile() throws Exception {
        Bridge b = bridge();
        String png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        String[] wrong = {
            "data:image/png;base64," + png,          // esqueceram de tirar o prefixo
            png.replace('+', '-').replace('/', '_') + "-_", // alfabeto de URL
            "não é base64", "<svg/>", "{\"a\":1}", png + "\u0000", "%69%56", png.substring(0, 20) + "…" + png.substring(20),
        };
        for (String base64 : wrong) {
            JSONObject r = parse(b.call("saveFile", new JSONObject().put("name", "mapa.png").put("mime", "image/png").put("base64", base64).toString()));
            assertEquals(base64, Bridge.ERR_ARGS + ": base64", r.optString("error"));
        }
        assertNull("nenhum arquivo estragado foi oferecido", shadowOf(activity).getNextStartedActivity());
        String[] left = sharedDir().list();
        assertTrue(left == null || left.length == 0);

        // base64 de verdade passa, com ou sem quebras de linha e preenchimento
        for (String base64 : new String[] {png, png.substring(0, 40) + "\r\n" + png.substring(40), "eA==", "eA", " eA== "}) {
            assertEquals(base64, "{\"ok\":true}", b.call("saveFile", new JSONObject().put("name", "ok.bin").put("base64", base64).toString()));
            assertNotNull(shadowOf(activity).getNextStartedActivity());
        }
        assertEquals("x", new String(Files.readAllBytes(new File(sharedDir(), "ok.bin").toPath()), StandardCharsets.UTF_8));
    }

    @Test
    public void sharedTextTooBigForAnIntentGoesAsAFileAndTitlesAreTamed() throws Exception {
        Bridge b = bridge();
        // até o teto: texto dentro do Intent
        StringBuilder atLimit = new StringBuilder();
        while (atLimit.length() < Sharer.MAX_TEXT_CHARS) atLimit.append('r');
        assertEquals("{\"ok\":true}", b.call("share", new JSONObject().put("title", "Relatório").put("text", atLimit.toString()).toString()));
        Intent send = shadowOf(activity).getNextStartedActivity().getParcelableExtra(Intent.EXTRA_INTENT);
        assertEquals(Sharer.MAX_TEXT_CHARS, send.getStringExtra(Intent.EXTRA_TEXT).length());
        assertNull(send.getParcelableExtra(Intent.EXTRA_STREAM));

        // acima dele (o Android não transporta ~1 MB entre apps): o mesmo texto vai como arquivo .txt
        String big = atLimit + "!";
        // (nome sem acento: a JVM dos testes não grava nomes de arquivo em UTF-8 como o Android grava)
        assertEquals("{\"ok\":true}", b.call("share", new JSONObject().put("title", "Relatorio do Wi-Fi: casa/escritorio").put("text", big).toString()));
        send = shadowOf(activity).getNextStartedActivity().getParcelableExtra(Intent.EXTRA_INTENT);
        assertNull("o texto não viaja no Intent", send.getStringExtra(Intent.EXTRA_TEXT));
        assertEquals("text/plain", send.getType());
        Uri uri = send.getParcelableExtra(Intent.EXTRA_STREAM);
        assertEquals("/shared/Relatorio do Wi-Fi_ casa_escritorio.txt", uri.getPath());
        assertEquals(big, new String(Files.readAllBytes(new File(sharedDir(), uri.getLastPathSegment()).toPath()), StandardCharsets.UTF_8));
        assertEquals("{\"ok\":true}", b.call("share", new JSONObject().put("text", big).toString()));
        send = shadowOf(activity).getNextStartedActivity().getParcelableExtra(Intent.EXTRA_INTENT);
        assertEquals("/shared/texto.txt", ((Uri) send.getParcelableExtra(Intent.EXTRA_STREAM)).getPath());

        // grande demais até para arquivo
        if (Build.VERSION.SDK_INT == 34) {
            StringBuilder huge = new StringBuilder();
            while (huge.length() <= Sharer.MAX_BYTES) huge.append(atLimit);
            assertEquals("{\"ok\":false}", b.call("share", new JSONObject().put("text", huge.toString()).toString()));
            assertNull(shadowOf(activity).getNextStartedActivity());
        }

        // título: uma linha, tamanho contido
        StringBuilder longTitle = new StringBuilder("linha 1\nlinha 2\u0000\t");
        while (longTitle.length() < 5000) longTitle.append("título ");
        assertEquals("{\"ok\":true}", b.call("share", new JSONObject().put("title", longTitle.toString()).put("text", "x").toString()));
        Intent chooser = shadowOf(activity).getNextStartedActivity();
        send = chooser.getParcelableExtra(Intent.EXTRA_INTENT);
        String subject = send.getStringExtra(Intent.EXTRA_SUBJECT);
        assertTrue(subject.length() <= Sharer.MAX_TITLE_CHARS);
        assertTrue(subject.startsWith("linha 1 linha 2"));
        for (int i = 0; i < subject.length(); i++) assertFalse(Character.isISOControl(subject.charAt(i)));
        assertEquals(subject, String.valueOf(chooser.getCharSequenceExtra(Intent.EXTRA_TITLE)));
        assertNull(Sharer.cleanTitle(" \n\t "));
        assertNull(Sharer.cleanTitle(null));
    }

    @Test
    public void theFileProviderOnlyServesTheSharedFolder() throws Exception {
        File shared = new File(sharedDir(), "ok.txt");
        assertTrue(shared.getParentFile().isDirectory() || shared.getParentFile().mkdirs());
        Files.write(shared.toPath(), "x".getBytes(StandardCharsets.UTF_8));
        assertEquals("/shared/ok.txt", Sharer.uriFor(activity, shared).getPath());

        File[] elsewhere = {
            new File(activity.getCacheDir(), "outro.txt"), new File(activity.getFilesDir(), "mapa.json"),
            new File(activity.getFilesDir().getParentFile(), "shared_prefs/wrx_permissions.xml"),
            new File(activity.getFilesDir().getParentFile(), "app_webview/Default/Local Storage/leveldb/000003.log"),
            new File(sharedDir(), "../outro.txt"), new File("/etc/hosts"),
        };
        for (File f : elsewhere) {
            try {
                Uri uri = FileProvider.getUriForFile(activity, Sharer.authority(activity), f);
                fail(f + " ganhou endereço: " + uri);
            } catch (IllegalArgumentException expected) {
                // fora da única pasta declarada em res/xml/file_paths.xml
            }
        }
        ProviderInfo provider = activity.getPackageManager().resolveContentProvider(Sharer.authority(activity), 0);
        assertNotNull(provider);
        assertFalse("outros apps só leem o que receberam por permissão temporária", provider.exported);
        assertTrue(provider.grantUriPermissions);
        assertNull("sem permissão fixa de leitura ou escrita", provider.readPermission);
    }

    // ------------------------------------------------------------------ argumentos estranhos

    @Test
    public void settingsScreensComeFromAFixedList() throws Exception {
        Bridge b = bridge();
        String[] attacks = {
            "android.settings.SETTINGS", "android.intent.action.VIEW", "android.intent.action.CALL", "WIFI", "Wifi", " wifi", "wifi ",
            "wifi\u0000", "wifi;location", "wifi,app", "*", "", "intent:#Intent;action=android.intent.action.FACTORY_RESET;end",
            "com.android.settings/.Settings$DevelopmentSettingsDashboardActivity", "package:com.wifiraiox.app", "tel:190", "https://evil.example/",
            "ｗｉｆｉ", "toString", "__proto__", "constructor",
        };
        for (String which : attacks) {
            JSONObject r = parse(b.call("openSettings", new JSONObject().put("which", which).toString()));
            assertTrue(which, r.optString("error").startsWith(Bridge.ERR_ARGS));
        }
        for (String args : new String[] {"{\"which\":[\"wifi\"]}", "{\"which\":{\"wifi\":1}}", "{\"which\":true}", "{\"which\":0}", "{\"Which\":\"wifi\"}"}) {
            assertTrue(args, parse(b.call("openSettings", args)).has("error"));
        }
        assertNull("nenhuma tela foi aberta", shadowOf(activity).getNextStartedActivity());

        Set<String> allowed = new HashSet<>(Arrays.asList(Settings.ACTION_WIFI_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS,
                Settings.ACTION_LOCATION_SOURCE_SETTINGS, Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS, Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS, Settings.ACTION_SETTINGS,
                "android.settings.panel.action.WIFI"));
        for (String which : new String[] {"wifi", "location", "app", "developer", "panel"}) {
            for (Intent intent : SettingsOpener.candidates(activity, which)) {
                assertTrue(which + " -> " + intent.getAction(), allowed.contains(intent.getAction()));
                assertNull("só ações do sistema, nunca um componente escolhido", intent.getComponent());
                if (intent.getData() != null) assertEquals("package:com.wifiraiox.app", intent.getDataString());
                assertNull(intent.getExtras());
            }
        }
    }

    @Test
    public void barColoursAreParsedStrictly() throws Exception {
        Bridge b = bridge();
        String[] bad = {
            "", "#", "#12", "#12345", "#1234567", "#12345678", "0a0f1c", "#0a0f1g", "#-a0f1c", "#+a0f1c", "# a0f1c", "#0a 0f1c",
            "rgb(1,2,3)", "red", "transparent", "#０a0f1c", "#٠٠٠٠٠٠", "＃0a0f1c", "#0a0f1c;", "#0a0f\u00001c", "url(x)", "var(--bg)",
        };
        for (String color : bad) {
            assertNull(color, SystemBars.parseColor(color));
            assertTrue(color, parse(b.call("setBars", new JSONObject().put("color", color).toString())).optString("error").startsWith(Bridge.ERR_ARGS));
        }
        assertNull(SystemBars.parseColor(null));
        assertEquals(Integer.valueOf(0xFF0A0F1C), SystemBars.parseColor("#0a0f1c"));
        assertEquals(Integer.valueOf(0xFF0A0F1C), SystemBars.parseColor(" #0A0F1C "));
        assertEquals(Integer.valueOf(0xFFAABBCC), SystemBars.parseColor("#abc"));
        // dark que não é booleano vale false; nunca derruba a chamada
        for (String dark : new String[] {"\"true\"", "1", "null", "[]", "{}"}) {
            assertEquals("{\"ok\":true}", b.call("setBars", "{\"color\":\"#0a0f1c\",\"dark\":" + dark + "}"));
        }
        Fixtures.idle();
    }

    @Test
    public void absurdNumbersAreContainedNeverTrusted() throws Exception {
        final List<int[]> pings = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger probes = new AtomicInteger();
        Pinger pinger = new Pinger("/nao/existe", null, host -> InetAddress.getByAddress(new byte[] {10, 0, 0, 1}),
                new Pinger.Prober[] {(a, t) -> {
                    pings.add(new int[] {t});
                    probes.incrementAndGet();
                    return -1;
                }}, watchdog);
        Bridge b = bridge(pinger, null);
        b.onStart();
        // NaN e Infinity não existem em JSON, mas o leitor do Android os aceita: têm de cair no padrão ou no limite
        String[] numbers = {"NaN", "-NaN", "Infinity", "-Infinity", "1e999", "-1e999", "1e308", "-1e308", "9223372036854775807",
            "-9223372036854775808", "2147483648", "-2147483649", "0", "-0", "-1", "0.0000001", "4.9e-324", "1.5", "007", "0x7fffffff", "1e2"};
        Set<String> pinged = new HashSet<>(Arrays.asList("NaN", "Infinity", "-1e999", "9223372036854775807", "-1", "0.0000001"));
        int id = 100;
        for (String n : numbers) {
            JSONObject watch = parse(b.call("watchRssi", "{\"intervalMs\":" + n + "}"));
            assertTrue(n + " -> " + watch, watch.optBoolean("ok") || watch.optString("error").startsWith(Bridge.ERR_ARGS));
            JSONObject vibrate = parse(b.call("vibrate", "{\"ms\":" + n + "}"));
            assertTrue(n + " -> " + vibrate, vibrate.optBoolean("ok") || vibrate.optString("error").startsWith(Bridge.ERR_ARGS));
            if (!pinged.contains(n)) continue; // cada série leva meio segundo: uma amostra dos casos basta
            b.callAsync(id, "ping", "{\"host\":\"10.0.0.1\",\"count\":" + n + ",\"timeoutMs\":" + n + "}");
            JSONObject summary = page.awaitResolved(id, 30_000);
            if (summary.has("error")) {
                // NaN e Infinity: o leitor de JSON do Android recusa o objeto inteiro, antes de qualquer método
                assertEquals(n, Bridge.ERR_ARGS, summary.get("error"));
                assertTrue(n, n.contains("NaN") || n.contains("Infinity") || n.contains("e999"));
            } else {
                int sent = summary.getInt("sent");
                assertTrue(n + ": " + sent + " pacotes", sent >= 1 && sent <= Pinger.MAX_COUNT);
            }
            id++;
        }
        assertTrue(Double.isNaN(Json.number(new JSONObject(), "x", Double.NaN))); // sem o campo vale o padrão dado
        assertEquals("número que não é finito nunca passa adiante", 7.0, Json.number(new JSONObject() {
            @Override
            public Object opt(String name) {
                return Double.POSITIVE_INFINITY;
            }
        }, "x", 7.0), 0);
        for (int[] t : pings) assertTrue("prazo de " + t[0] + " ms", t[0] >= Pinger.MIN_TIMEOUT_MS && t[0] <= Pinger.MAX_TIMEOUT_MS);
        assertTrue(probes.get() > 0);
        // o intervalo do sinal nunca sai de 250 ms .. 60 s, venha o que vier
        for (double v : new double[] {Double.NaN, Double.NEGATIVE_INFINITY, Double.POSITIVE_INFINITY, -1, 0, 1, 249.4, 1e300, Long.MAX_VALUE}) {
            int interval = RssiWatcher.clampInterval(v);
            assertTrue(v + " -> " + interval, interval >= RssiWatcher.MIN_INTERVAL_MS && interval <= RssiWatcher.MAX_INTERVAL_MS);
        }
        // o id do callAsync é só um rótulo: qualquer inteiro serve e volta igual
        for (int odd : new int[] {0, -1, Integer.MIN_VALUE, Integer.MAX_VALUE}) {
            b.callAsync(odd, "scan", "{}");
            assertNotNull(String.valueOf(odd), page.resolved(odd));
        }
    }

    // ------------------------------------------------------------------ rede local

    @Test
    public void theLanSweepNeverLeavesPrivateAddressesOrGrowsWithoutBound() {
        Random random = new Random(20261115);
        for (int i = 0; i < 20_000; i++) {
            int ip = random.nextInt();
            int prefix = random.nextInt(40) - 4; // inclui máscaras absurdas
            int[] hosts = LanRange.hosts(ip, prefix);
            if (!LanRange.isPrivate(ip)) {
                assertEquals(LanRange.format(ip) + "/" + prefix, 0, hosts.length);
                continue;
            }
            assertTrue(LanRange.format(ip) + "/" + prefix + ": " + hosts.length, hosts.length <= 1022);
            for (int h : hosts) {
                assertTrue(LanRange.isPrivate(h));
                assertEquals("mesmo /22 do celular, no máximo", ip >>> 10, h >>> 10);
            }
        }
        // as faixas privadas são só as três da RFC 1918
        String[] notPrivate = {"8.8.8.8", "100.64.0.1", "169.254.1.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.1.1",
            "11.0.0.1", "9.255.255.255", "127.0.0.1", "0.0.0.0", "224.0.0.251", "255.255.255.255", "198.18.0.1", "192.0.2.1"};
        for (String ip : notPrivate) assertFalse(ip, LanRange.isPrivate(LanRange.parse(ip)));
        for (String ip : new String[] {"10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.254"}) {
            assertTrue(ip, LanRange.isPrivate(LanRange.parse(ip)));
        }
    }

    /** Rede de mentira que anota cada sonda: endereço e tipo. */
    private static final class SpyNet implements LanScanner.Net {
        final Set<String> echo = Collections.synchronizedSet(new HashSet<>());
        final Set<String> bound = Collections.synchronizedSet(new HashSet<>());
        final Set<String> reverseDns = Collections.synchronizedSet(new HashSet<>());
        final Set<String> netbios = Collections.synchronizedSet(new HashSet<>());
        final Set<Network> networks = Collections.synchronizedSet(new HashSet<>());

        @Override
        public double probe(InetAddress address, int attempt, Network network) {
            (attempt == 0 ? echo : bound).add(address.getHostAddress());
            if (attempt != 0 && network != null) networks.add(network);
            return address.getHostAddress().endsWith(".1") || address.getHostAddress().endsWith(".9") ? 2.0 : -1;
        }

        @Override
        public String dnsName(InetAddress address) {
            reverseDns.add(address.getHostAddress());
            return "nome-de-outra-rede.corp";
        }

        @Override
        public String netbiosName(InetAddress address, Network network) {
            netbios.add(address.getHostAddress());
            if (network != null) networks.add(network);
            return address.getHostAddress().endsWith(".9") ? "NOTEBOOK" : null;
        }

        @Override
        public Map<String, String> arp() {
            return new HashMap<>();
        }
    }

    @Test
    public void withAVpnOrMobileDataInChargeNoProbeLeavesThroughAnotherNetwork() throws Exception {
        Network wifi = Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"192.168.50.23/24"}, "192.168.50.1", "192.168.50.1"),
                NetworkCapabilities.NET_CAPABILITY_INTERNET);
        ConnectionTracker tracker = new ConnectionTracker(activity, new android.os.Handler(android.os.Looper.getMainLooper()), c -> { });
        ConnectionTracker.LanTarget target = tracker.lanTarget();
        assertSameNetwork(wifi, target.network);
        assertTrue("Wi-Fi é a rede padrão: o eco comum sai por ele", target.direct);

        // a mesma casa, agora com uma VPN (ou os dados móveis) como rede padrão
        Network other = Fixtures.anotherNetworkBecomesDefault();
        assertFalse(wifi.equals(((ConnectivityManager) activity.getSystemService(android.content.Context.CONNECTIVITY_SERVICE)).getActiveNetwork()));
        target = tracker.lanTarget();
        assertSameNetwork(wifi, target.network);
        assertFalse("sondas sem amarração iriam para a outra rede", target.direct);
        assertNotNull(other);

        SpyNet net = new SpyNet();
        final List<JSONObject> found = Collections.synchronizedList(new ArrayList<>());
        JSONArray devices = new LanScanner(net, 16).run(target, new LanScanner.Events() {
            @Override
            public void onDevice(JSONObject device) {
                found.add(device);
            }

            @Override
            public void onProgress(int done, int total) {
            }
        }).getJSONArray("devices");
        assertTrue("nenhum eco (ICMP/TCP 7), que sairia pela rede padrão: " + net.echo, net.echo.isEmpty());
        assertTrue("nenhuma consulta de nome ao DNS da outra rede: " + net.reverseDns, net.reverseDns.isEmpty());
        assertEquals("as sondas amarradas ao Wi-Fi cobrem a sub-rede inteira", 253, net.bound.size());
        assertEquals("e só ao Wi-Fi", Collections.singleton(wifi), net.networks);
        for (String ip : net.bound) assertTrue(ip, ip.startsWith("192.168.50."));
        // a descoberta continua funcionando, sem nomes emprestados de outra rede
        Map<String, JSONObject> byIp = new HashMap<>();
        for (int i = 0; i < devices.length(); i++) byIp.put(devices.getJSONObject(i).getString("ip"), devices.getJSONObject(i));
        assertEquals(true, byIp.get("192.168.50.1").get("gateway"));
        assertFalse(byIp.get("192.168.50.1").has("host"));
        assertEquals("NOTEBOOK", byIp.get("192.168.50.9").get("host"));
        assertEquals(true, byIp.get("192.168.50.23").get("self"));

        // com o Wi-Fi no comando, o caminho completo
        SpyNet home = new SpyNet();
        new LanScanner(home, 16).run(new ConnectionTracker.LanTarget(target.ip, target.prefix, target.gateway, wifi, true), new LanScanner.Events() {
            @Override
            public void onDevice(JSONObject device) {
            }

            @Override
            public void onProgress(int done, int total) {
            }
        });
        assertEquals(253, home.echo.size());
        assertFalse(home.reverseDns.isEmpty());
    }

    private static void assertSameNetwork(Network expected, Network actual) {
        assertEquals(expected, actual);
    }

    @Test
    public void thePageCannotChooseWhatTheLanSweepProbes() throws Exception {
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"192.168.50.23/24"}, "192.168.50.1", "192.168.50.1"));
        SpyNet net = new SpyNet();
        Bridge b = bridge(null, new LanScanner(net, 16));
        // a página tenta dirigir a varredura para a internet (ou para outra faixa) pelos argumentos
        b.callAsync(1, "lanScan", "{\"ip\":\"8.8.8.8\",\"prefix\":8,\"gateway\":\"1.1.1.1\",\"range\":\"0.0.0.0/0\",\"hosts\":[\"8.8.4.4\"],"
                + "\"target\":{\"ip\":\"203.0.113.1\",\"prefix\":16},\"network\":\"cell\",\"threads\":100000,\"direct\":true}");
        JSONObject r = page.awaitResolved(1, 20_000);
        assertTrue(r.has("devices"));
        Set<String> all = new HashSet<>(net.echo);
        all.addAll(net.bound);
        all.addAll(net.netbios);
        all.addAll(net.reverseDns);
        assertEquals(253, net.echo.size());
        for (String ip : all) assertTrue("fora da sub-rede do Wi-Fi: " + ip, ip.startsWith("192.168.50."));

        // Wi-Fi com endereço público (rede de operadora, hotspot com IP real): não há varredura
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"203.0.113.77/24"}, "203.0.113.1", "203.0.113.1"));
        SpyNet operator = new SpyNet();
        Bridge second = bridge(null, new LanScanner(operator, 16));
        second.callAsync(2, "lanScan", "{}");
        assertEquals(0, page.awaitResolved(2, 20_000).getJSONArray("devices").length());
        assertTrue(operator.echo.isEmpty() && operator.bound.isEmpty() && operator.netbios.isEmpty() && operator.reverseDns.isEmpty());
        // idem para a faixa das operadoras (CGNAT) e para endereços de enlace
        for (String address : new String[] {"100.64.3.7/10", "169.254.10.20/16"}) {
            Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {address}, null));
            SpyNet none = new SpyNet();
            Bridge other = bridge(null, new LanScanner(none, 16));
            other.callAsync(3, "lanScan", "{}");
            assertEquals(address, 0, page.awaitResolved(3, 20_000).getJSONArray("devices").length());
            assertTrue(address, none.echo.isEmpty() && none.bound.isEmpty() && none.netbios.isEmpty());
            page.clear();
        }
    }

    // ------------------------------------------------------------------ manifesto

    @Test
    public void manifestExposesOnlyTheLauncherAndKeepsDataAtHome() throws Exception {
        PackageManager pm = Fixtures.app().getPackageManager();
        String pkg = Fixtures.app().getPackageName();
        PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_ACTIVITIES | PackageManager.GET_SERVICES
                | PackageManager.GET_RECEIVERS | PackageManager.GET_PROVIDERS | PackageManager.GET_PERMISSIONS);
        assertNotNull(info.activities);
        for (ActivityInfo a : info.activities) {
            if (a.name.equals(MainActivity.class.getName())) {
                assertTrue(a.exported);
                assertNull("a tela não exige nem concede permissão própria", a.permission);
                assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK, a.launchMode);
            } else {
                assertFalse("tela exportada além da principal: " + a.name, a.exported);
            }
        }
        assertTrue("nenhum serviço", info.services == null || info.services.length == 0);
        if (info.receivers != null) {
            for (ActivityInfo r : info.receivers) {
                // O único receiver vem do androidx (instala perfis de desempenho) e só atende quem tem
                // DUMP, permissão que apps comuns não recebem (só o shell do adb e o sistema).
                assertEquals("receiver inesperado: " + r.name, "androidx.profileinstaller.ProfileInstallReceiver", r.name);
                assertEquals("android.permission.DUMP", r.permission);
            }
        }
        assertNotNull(info.providers);
        boolean ours = false;
        for (ProviderInfo p : info.providers) {
            assertFalse("provedor exportado: " + p.name, p.exported);
            if (p.name.equals(SharedFileProvider.class.getName())) ours = true;
        }
        assertTrue(ours);

        // permissões: só o que o código usa (nada de multicast, armazenamento, câmera, telefone...)
        Set<String> declared = new HashSet<>(Arrays.asList(info.requestedPermissions));
        declared.remove(pkg + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"); // interna do androidx.core, nível assinatura
        assertEquals(new HashSet<>(Arrays.asList("android.permission.ACCESS_WIFI_STATE", "android.permission.CHANGE_WIFI_STATE",
                "android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION",
                "android.permission.NEARBY_WIFI_DEVICES", "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.INTERNET", "android.permission.VIBRATE")), declared);

        ApplicationInfo app = pm.getApplicationInfo(pkg, 0);
        assertEquals("sem backup: mapas e histórico dizem onde a pessoa mora", 0, app.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);

        // o que o Robolectric não lê do manifesto é conferido no próprio arquivo
        String manifest = new String(Files.readAllBytes(
                new File(System.getProperty("user.dir"), "src/main/AndroidManifest.xml").toPath()), StandardCharsets.UTF_8);
        assertTrue(manifest.contains("android:usesCleartextTraffic=\"false\""));
        assertTrue(manifest.contains("android:allowBackup=\"false\""));
        assertTrue(manifest.contains("android:fullBackupContent=\"false\""));
        assertTrue(manifest.contains("android:dataExtractionRules=\"@xml/data_extraction_rules\""));
        assertFalse("depuração nunca é ligada à mão", manifest.contains("android:debuggable"));
        assertFalse(manifest.contains("networkSecurityConfig"));
        assertFalse(manifest.contains("android:sharedUserId"));
        String rules = new String(Files.readAllBytes(
                new File(System.getProperty("user.dir"), "src/main/res/xml/data_extraction_rules.xml").toPath()), StandardCharsets.UTF_8);
        for (String section : new String[] {"cloud-backup", "device-transfer"}) {
            String body = rules.substring(rules.indexOf("<" + section + ">"), rules.indexOf("</" + section + ">"));
            for (String domain : new String[] {"root", "file", "database", "sharedpref", "external"}) {
                assertTrue(section + " tem de excluir " + domain, body.contains("<exclude domain=\"" + domain + "\""));
            }
            assertFalse(body.contains("<include"));
        }
        String paths = new String(Files.readAllBytes(
                new File(System.getProperty("user.dir"), "src/main/res/xml/file_paths.xml").toPath()), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
        assertEquals("uma única pasta compartilhável", 1, paths.split("-path\\b", -1).length - 1);
        assertTrue(paths.contains("<cache-path name=\"shared\" path=\"shared/\""));
    }
}
