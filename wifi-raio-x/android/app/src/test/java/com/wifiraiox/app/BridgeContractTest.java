package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.net.wifi.ScanResult;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.net.InetAddress;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * O contrato de app/js/bridge.js, método por método, em cada versão do Android: toda chamada
 * devolve JSON no formato combinado, e nenhuma entrada estranha derruba a ponte.
 */
public class BridgeContractTest extends AllSdks {

    private static final String[] SYNC = {"info", "status", "lastScan", "connection", "watchRssi", "unwatchRssi",
        "openSettings", "keepAwake", "vibrate", "setBars", "share", "saveFile", "cancel"};
    private static final String[] ASYNC = {"requestPermission", "scan", "rtt", "ping", "lanScan", "speedTest"};

    private Activity activity;
    private Fixtures.Page page;
    private Bridge bridge;
    private ScheduledExecutorService watchdog;

    @Before
    public void setUp() {
        Fixtures.forgetFileProviderPaths();
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        watchdog = Executors.newSingleThreadScheduledExecutor();
        // Rede de mentira: nenhum teste daqui depende de um ping ou de uma rede local de verdade.
        Pinger pinger = new Pinger("/caminho/que/nao/existe/ping", null,
                host -> InetAddress.getByAddress(host, new byte[] {10, 1, 2, 3}),
                new Pinger.Prober[] {(address, timeoutMs) -> 12.5}, watchdog);
        LanScanner lan = new LanScanner(new LanScanner.Net() {
            @Override
            public double probe(InetAddress address, int attempt, android.net.Network network) {
                return address.getHostAddress().endsWith(".1") ? 3.0 : -1;
            }

            @Override
            public String dnsName(InetAddress address) {
                return "roteador.lan";
            }

            @Override
            public String netbiosName(InetAddress address, android.net.Network network) {
                return null;
            }

            @Override
            public Map<String, String> arp() {
                return new java.util.HashMap<>();
            }
        }, 32);
        SpeedTester speed = new SpeedTester("http://127.0.0.1:9", network -> url -> {
            throw new java.net.UnknownHostException("sem internet nos testes");
        }, null);
        bridge = Fixtures.bridge(activity, page, pinger, lan, speed);
    }

    @After
    public void tearDown() {
        bridge.onDestroy();
        watchdog.shutdownNow();
    }

    private JSONObject call(String method, String args) throws Exception {
        String text = bridge.call(method, args);
        assertNotNull(method, text);
        return new JSONObject(text); // sempre JSON válido
    }

    private static void assertOnlyOk(String what, JSONObject r) throws Exception {
        assertEquals(what + " -> " + r, new HashSet<>(Arrays.asList("ok")), Fixtures.keys(r));
        assertTrue(what, r.get("ok") instanceof Boolean);
    }

    // ------------------------------------------------------------ formato das respostas imediatas

    @Test
    public void infoMatchesDeviceInfo() throws Exception {
        JSONObject info = call("info", "{}");
        assertEquals(new HashSet<>(Arrays.asList("platform", "sdk", "release", "manufacturer", "model", "appVersion",
                "bands", "standards", "rtt")), Fixtures.keys(info));
        assertEquals("android", info.get("platform"));
        assertEquals(Build.VERSION.SDK_INT, info.get("sdk"));
        assertTrue(info.get("release") instanceof String);
        assertTrue(info.get("manufacturer") instanceof String);
        assertTrue(info.get("model") instanceof String);
        assertEquals(BuildConfig.VERSION_NAME, info.get("appVersion"));
        assertTrue(info.get("rtt") instanceof Boolean);

        JSONObject bands = info.getJSONObject("bands");
        assertEquals(new HashSet<>(Arrays.asList("b24", "b5", "b6", "b60")), Fixtures.keys(bands));
        assertEquals(true, bands.get("b24"));
        for (String b : new String[] {"b5", "b6", "b60"}) assertTrue(b, bands.get(b) instanceof Boolean);
        if (Build.VERSION.SDK_INT < 30) assertEquals("6 GHz só pode ser consultado do Android 11 em diante", false, bands.get("b6"));
        if (Build.VERSION.SDK_INT < 31) assertEquals(false, bands.get("b60"));

        JSONArray standards = info.getJSONArray("standards");
        if (Build.VERSION.SDK_INT < 30) assertEquals("antes do Android 11 não há como saber", 0, standards.length());
        for (int i = 0; i < standards.length(); i++) assertTrue(standards.get(i) instanceof Integer);
        if (Build.VERSION.SDK_INT < 28) assertEquals(false, info.get("rtt"));
    }

    @Test
    public void bandsFollowTheRadio() throws Exception {
        Fixtures.wifi().setIs5GHzBandSupported(true);
        assertEquals(true, call("info", "{}").getJSONObject("bands").get("b5"));
        Fixtures.wifi().setIs5GHzBandSupported(false);
        assertEquals(false, call("info", "{}").getJSONObject("bands").get("b5"));
    }

    @Test
    public void everyImmediateMethodAnswersInItsContractShape() throws Exception {
        Fixtures.grantLocation();
        assertEquals(5, call("status", "{}").length());
        assertTrue(call("lastScan", "{}").get("aps") instanceof JSONArray);
        assertTrue(call("connection", "{}").get("connected") instanceof Boolean);
        assertOnlyOk("watchRssi", call("watchRssi", "{\"intervalMs\":500}"));
        assertOnlyOk("unwatchRssi", call("unwatchRssi", "{}"));
        assertOnlyOk("openSettings", call("openSettings", "{\"which\":\"wifi\"}"));
        assertOnlyOk("keepAwake", call("keepAwake", "{\"on\":true}"));
        assertOnlyOk("vibrate", call("vibrate", "{\"ms\":20}"));
        assertOnlyOk("setBars", call("setBars", "{\"color\":\"#0B1220\",\"dark\":true}"));
        assertOnlyOk("share", call("share", "{\"title\":\"t\",\"text\":\"x\"}"));
        assertOnlyOk("saveFile", call("saveFile", "{\"name\":\"a.txt\",\"mime\":\"text/plain\",\"text\":\"x\"}"));
        assertOnlyOk("cancel ping", call("cancel", "{\"op\":\"ping\"}"));
        assertOnlyOk("cancel lan", call("cancel", "{\"op\":\"lan\"}"));
        assertTrue(call("cancel", "{\"op\":\"tudo\"}").has("error"));
        assertTrue(call("cancel", "{}").has("error"));
    }

    @Test
    public void scanListCarriesOnlyFieldsThisAndroidHas() throws Exception {
        Fixtures.grantLocation();
        ScanResult r = Fixtures.scanResult("Casa", "AA:BB:CC:00:00:01", "[WPA2-PSK-CCMP][ESS]", -60, 2437);
        Fixtures.wifi().setScanResults(Arrays.asList(r));
        JSONObject ap = call("lastScan", "{}").getJSONArray("aps").getJSONObject(0);
        Set<String> allowed = new HashSet<>(Arrays.asList("bssid", "ssid", "level", "frequency", "channelWidth",
                "centerFreq0", "centerFreq1", "capabilities", "ageMs", "rttResponder", "passpoint", "venueName", "operatorName"));
        if (Build.VERSION.SDK_INT >= 30) allowed.addAll(Arrays.asList("wifiStandard", "ies"));
        if (Build.VERSION.SDK_INT >= 33) allowed.add("mld");
        Set<String> extra = Fixtures.keys(ap);
        extra.removeAll(allowed);
        assertTrue("campos além do que esta versão tem: " + extra, extra.isEmpty());
        for (String required : new String[] {"bssid", "ssid", "level", "frequency", "channelWidth", "centerFreq0",
                "centerFreq1", "capabilities", "ageMs"}) {
            assertTrue(required, ap.has(required));
        }
    }

    // ------------------------------------------------------------ entradas ruins

    @Test
    public void unknownMethodIsAnErrorNotAnException() throws Exception {
        for (String method : new String[] {"naoExiste", "", "INFO", "info ", "__proto__", "constructor", "toString"}) {
            JSONObject r = call(method, "{}");
            assertTrue(method, r.get("error") instanceof String);
            assertEquals(1, r.length());
        }
        assertTrue(call(null, "{}").has("error"));
        assertTrue(call(null, null).has("error"));
    }

    @Test
    public void malformedArgumentsAreErrorsForEveryMethod() throws Exception {
        String[] garbage = {"{", "}", "[]", "[1,2]", "\"texto\"", "42", "true", "{\"a\":}", "{'a':1", "não é json"};
        for (String method : SYNC) {
            for (String args : garbage) {
                JSONObject r = call(method, args);
                assertTrue(method + " " + args + " -> " + r, r.has("error"));
            }
        }
        assertNull("nada foi aberto por engano", shadowOf(activity).getNextStartedActivity());
    }

    @Test
    public void missingArgumentsMeanEmptyObject() throws Exception {
        // Métodos sem argumentos obrigatórios respondem normalmente; os outros dizem o que faltou.
        for (String args : new String[] {null, "", "  ", "null", "undefined", "{}"}) {
            assertEquals("android", call("info", args).get("platform"));
            assertTrue(call("status", args).has("canScan"));
            assertTrue(call("lastScan", args).has("aps"));
            assertTrue(call("connection", args).has("connected"));
            assertOnlyOk("watchRssi", call("watchRssi", args));
            assertOnlyOk("unwatchRssi", call("unwatchRssi", args));
            assertOnlyOk("vibrate", call("vibrate", args));
            for (String needs : new String[] {"openSettings", "keepAwake", "setBars", "share", "saveFile", "cancel"}) {
                assertTrue(needs + " " + args, call(needs, args).has("error"));
            }
        }
    }

    @Test
    public void wrongTypesNeverThrow() throws Exception {
        String[] odd = {
            "{\"which\":{}}", "{\"on\":[]}", "{\"ms\":{}}", "{\"color\":[]}", "{\"text\":{}}", "{\"name\":[],\"text\":[]}",
            "{\"op\":7}", "{\"intervalMs\":[]}", "{\"host\":{}}", "{\"bssids\":{}}",
        };
        for (String method : SYNC) {
            for (String args : odd) {
                String text = bridge.call(method, args);
                new JSONObject(text);
            }
        }
        int id = 100;
        for (String method : ASYNC) {
            for (String args : odd) bridge.callAsync(id++, method, args);
        }
        Fixtures.idle();
    }

    @Test
    public void asyncOnlyMethodsRefuseTheImmediatePath() throws Exception {
        for (String method : ASYNC) {
            JSONObject r = call(method, "{}");
            assertTrue(method, r.getString("error").contains("callAsync"));
        }
    }

    // ------------------------------------------------------------ respostas posteriores

    @Test
    public void asyncMethodsResolveInTheirContractShape() throws Exception {
        Fixtures.grantLocation();
        Fixtures.noNetworks();

        bridge.callAsync(1, "requestPermission", "{}");
        Fixtures.idle();
        assertEquals(5, page.resolved(1).length());
        assertEquals("granted", page.resolved(1).get("permission"));

        bridge.callAsync(2, "scan", "{}");
        JSONObject scan = page.resolved(2);
        assertTrue(scan.get("accepted") instanceof Boolean);
        if (scan.getBoolean("accepted")) assertEquals(1, scan.length());
        else assertTrue(scan.get("reason") instanceof String);

        shadowOf(activity.getPackageManager()).setSystemFeature("android.hardware.wifi.rtt", false);
        bridge.callAsync(3, "rtt", "{\"bssids\":[\"aa:bb:cc:dd:ee:ff\"]}");
        Fixtures.idle();
        assertEquals(new HashSet<>(Arrays.asList("results")), Fixtures.keys(page.resolved(3)));
        assertEquals(0, page.resolved(3).getJSONArray("results").length());

        bridge.callAsync(4, "ping", "{\"host\":\"exemplo.com\",\"count\":2,\"timeoutMs\":300}");
        JSONObject summary = page.awaitResolved(4, 10_000);
        assertEquals(new HashSet<>(Arrays.asList("host", "method", "sent", "received", "lossPct", "min", "avg", "max", "jitter")),
                Fixtures.keys(summary));
        assertEquals("exemplo.com", summary.get("host"));
        assertEquals("tcp", summary.get("method"));
        assertEquals(2, summary.get("sent"));
        assertEquals(2, summary.get("received"));
        assertEquals(12.5, summary.getDouble("avg"), 1e-9);
        List<JSONObject> replies = page.events("ping");
        assertEquals(2, replies.size());
        assertEquals(new HashSet<>(Arrays.asList("host", "seq", "ok", "ms")), Fixtures.keys(replies.get(0)));
        assertEquals(1, replies.get(0).get("seq"));
        assertEquals(true, replies.get(0).get("ok"));

        bridge.callAsync(5, "lanScan", "{}");
        JSONObject lan = page.awaitResolved(5, 10_000);
        assertEquals(new HashSet<>(Arrays.asList("devices")), Fixtures.keys(lan));
        assertEquals("fora do Wi-Fi não há o que varrer", 0, lan.getJSONArray("devices").length());

        bridge.callAsync(6, "speedTest", "{\"mode\":\"light\"}");
        JSONObject speed = page.awaitResolved(6, 10_000);
        assertEquals(new HashSet<>(Arrays.asList("ok", "error", "bytesDown", "bytesUp")), Fixtures.keys(speed));
        assertEquals(false, speed.get("ok"));
        assertEquals("offline", speed.get("error"));
        assertEquals(0, bridge.pendingCalls());
    }

    @Test
    public void lanScanOnWifiEmitsDevicesAndProgress() throws Exception {
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"192.168.50.23/24"}, "192.168.50.1", "192.168.50.1"));
        bridge.callAsync(7, "lanScan", "{}");
        JSONObject lan = page.awaitResolved(7, 20_000);
        JSONArray devices = lan.getJSONArray("devices");
        assertEquals(2, devices.length());
        JSONObject router = devices.getJSONObject(0);
        assertEquals("192.168.50.1", router.get("ip"));
        assertEquals(true, router.get("gateway"));
        assertEquals("roteador.lan", router.get("host"));
        assertEquals(3.0, router.getDouble("ms"), 1e-9);
        JSONObject self = devices.getJSONObject(1);
        assertEquals("192.168.50.23", self.get("ip"));
        assertEquals(true, self.get("self"));
        Set<String> allowed = new HashSet<>(Arrays.asList("ip", "host", "mac", "ms", "self", "gateway"));
        for (int i = 0; i < devices.length(); i++) assertTrue(allowed.containsAll(Fixtures.keys(devices.getJSONObject(i))));

        assertEquals(2, page.events("lan").size());
        List<JSONObject> progress = page.events("lanProgress");
        assertFalse(progress.isEmpty());
        JSONObject last = progress.get(progress.size() - 1);
        assertEquals(new HashSet<>(Arrays.asList("done", "total")), Fixtures.keys(last));
        assertEquals(254, last.get("total"));
        assertEquals(254, last.get("done"));
    }

    @Test
    public void pingRejectsBadHostsBeforeDoingAnything() throws Exception {
        String[] bad = {"{}", "{\"host\":\"\"}", "{\"host\":\"-c 5 8.8.8.8\"}", "{\"host\":\"a;b\"}", "{\"host\":5}", "{\"host\":null}"};
        int id = 20;
        for (String args : bad) {
            bridge.callAsync(id, "ping", args);
            JSONObject r = page.resolved(id); // já respondeu, na própria chamada
            assertNotNull(args, r);
            assertEquals(args, Pinger.ERR_INVALID_HOST, r.get("error"));
            id++;
        }
        assertTrue(page.events("ping").isEmpty());
    }

    @Test
    public void immediateMethodsAlsoWorkThroughCallAsync() throws Exception {
        bridge.callAsync(1, "info", "{}");
        assertEquals("android", page.resolved(1).get("platform"));
        bridge.callAsync(2, "naoExiste", "{}");
        assertTrue(page.resolved(2).has("error"));
        bridge.callAsync(3, "info", "[quebrado");
        assertTrue(page.resolved(3).has("error"));
        bridge.callAsync(4, null, "{}");
        assertTrue(page.resolved(4).has("error"));
        assertEquals(0, bridge.pendingCalls());
    }

    @Test
    public void eachAsyncCallIsAnsweredExactlyOnce() throws Exception {
        for (int i = 0; i < 20; i++) bridge.callAsync(300 + i, "scan", "{}");
        for (int i = 0; i < 20; i++) assertNotNull(page.resolved(300 + i)); // resolved() falha se houver resposta em dobro
        assertEquals(0, bridge.pendingCalls());
    }

    // ------------------------------------------------------------ origem e encerramento

    @Test
    public void onlyTheAppsOwnPageMayUseTheBridge() throws Exception {
        String[] foreign = {
            "https://evil.example/", "http://appassets.androidplatform.net/assets/www/index.html",
            "https://appassets.androidplatform.net.evil.example/assets/www/index.html",
            "https://appassets.androidplatform.net:8443/assets/www/index.html",
            "https://user@evil.example/appassets.androidplatform.net", "file:///android_asset/www/index.html",
            "about:blank", "data:text/html,<script>WrxNative.call('info','{}')</script>", "", null, "javascript:alert(1)",
        };
        for (String url : foreign) {
            bridge.setPageUrl(url);
            for (String method : SYNC) {
                JSONObject r = call(method, "{}");
                assertEquals(String.valueOf(url), Bridge.ERR_FORBIDDEN, r.get("error"));
            }
            page.clear();
            for (String method : ASYNC) bridge.callAsync(1, method, "{}");
            Fixtures.idle();
            assertTrue("página estranha não recebe nem resposta", page.scripts().isEmpty());
            assertNull(shadowOf(activity).getLastRequestedPermission());
        }
        for (String url : new String[] {WebClient.START_URL, "https://appassets.androidplatform.net/assets/www/outra.html?x=1#y",
                "https://appassets.androidplatform.net/"}) {
            bridge.setPageUrl(url);
            assertEquals(url, "android", call("info", "{}").get("platform"));
        }
    }

    @Test
    public void afterDestroyTheBridgeAnswersClosedAndStaysQuiet() throws Exception {
        bridge.onDestroy();
        assertTrue(bridge.isDestroyed());
        assertEquals(Bridge.ERR_CLOSED, call("info", "{}").get("error"));
        page.clear();
        bridge.callAsync(1, "scan", "{}");
        bridge.onResume();
        bridge.onStart();
        bridge.onPermissionsResult(Permissions.REQUEST_LOCATION, new String[0], new int[0]);
        bridge.emit("scan", new JSONObject());
        Fixtures.idle();
        assertTrue(page.scripts().isEmpty());
        bridge.onDestroy(); // repetido: não lança
    }

    @Test
    public void destroyAnswersCallsStillRunning() throws Exception {
        // um ping que ficaria preso resolvendo o nome
        final java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        Pinger stuck = new Pinger("/nao/existe", null, host -> {
            release.await();
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> -1}, watchdog);
        Fixtures.Page other = new Fixtures.Page();
        Bridge b = Fixtures.bridge(Fixtures.activity(), other, stuck, null);
        b.callAsync(77, "ping", "{\"host\":\"preso.exemplo\"}");
        assertEquals(1, b.pendingCalls());
        b.onDestroy();
        JSONObject r = other.resolved(77);
        assertNotNull("a promessa da página é respondida antes de a tela morrer", r);
        assertEquals(Bridge.ERR_CLOSED, r.get("error"));
        assertEquals(0, b.pendingCalls());
        release.countDown();
        Thread.sleep(100);
        assertNotNull("a resposta atrasada da thread de trabalho é descartada", other.resolved(77));
    }

    @Test
    public void aNewPageNeverReceivesAnswersMeantForTheOldOne() throws Exception {
        // dois pings que ficam presos na resolução do nome até o teste soltar cada um
        final java.util.concurrent.CountDownLatch releaseOld = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch releaseNew = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch bothWaiting = new java.util.concurrent.CountDownLatch(2);
        Pinger slow = new Pinger("/nao/existe", null, host -> {
            bothWaiting.countDown();
            (host.startsWith("antiga") ? releaseOld : releaseNew).await();
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 5.0}, watchdog);
        Fixtures.Page p = new Fixtures.Page();
        Bridge b = Fixtures.bridge(Fixtures.activity(), p, slow, null);
        b.onStart();
        b.call("watchRssi", "{}");

        b.callAsync(1, "ping", "{\"host\":\"antiga.exemplo\",\"count\":1}"); // página antiga, id 1
        assertEquals(1, b.pendingCalls());
        b.onNewPage();                                                           // recarga
        assertEquals(0, b.pendingCalls());
        b.callAsync(1, "ping", "{\"host\":\"nova.exemplo\",\"count\":1}");   // a página nova reutiliza o id 1
        assertTrue(bothWaiting.await(10, TimeUnit.SECONDS));

        // o trabalho da página antiga termina primeiro, com a chamada nova ainda esperando
        releaseOld.countDown();
        Thread.sleep(300);
        Fixtures.idle();
        assertNull("a resposta antiga não pode cair na chamada nova", p.resolved(1));
        assertEquals(1, b.pendingCalls());

        releaseNew.countDown();
        assertEquals("nova.exemplo", p.awaitResolved(1, 10_000).get("host"));

        // o relógio de sinal da página antiga também parou
        p.clear();
        org.robolectric.shadows.ShadowLooper.idleMainLooper(5, TimeUnit.SECONDS);
        assertTrue(p.events("rssi").isEmpty());
        b.onDestroy();
    }

    @Test
    public void aReusedIdIsOnlyAnsweredByItsLatestCall() throws Exception {
        final java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        Pinger stuck = new Pinger("/nao/existe", null, host -> {
            release.await();
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 5.0}, watchdog);
        Fixtures.Page p = new Fixtures.Page();
        Bridge b = Fixtures.bridge(Fixtures.activity(), p, stuck, null);
        b.callAsync(7, "ping", "{\"host\":\"primeira.exemplo\",\"count\":1}");
        b.callAsync(7, "scan", "{}"); // a página (por engano) repetiu o id
        assertTrue(p.resolved(7).has("accepted"));
        release.countDown();
        Thread.sleep(300);
        assertTrue("uma resposta só, a da chamada mais recente", p.resolved(7).has("accepted"));
        b.onDestroy();
    }

    @Test
    public void callsFromManyThreadsAtOnce() throws Exception {
        Fixtures.grantLocation();
        final java.util.concurrent.atomic.AtomicInteger bad = new java.util.concurrent.atomic.AtomicInteger();
        Thread[] threads = new Thread[8];
        for (int t = 0; t < threads.length; t++) {
            final int base = 1000 * (t + 1);
            threads[t] = new Thread(() -> {
                try {
                    for (int i = 0; i < 40; i++) {
                        String method = SYNC[i % 4]; // info, status, lastScan, connection
                        if (new JSONObject(bridge.call(method, "{}")).has("error")) bad.incrementAndGet();
                        bridge.callAsync(base + i, "scan", "{}");
                    }
                } catch (Throwable e) {
                    bad.incrementAndGet();
                }
            });
            threads[t].start();
        }
        for (Thread t : threads) t.join(20_000);
        assertEquals(0, bad.get());
        assertEquals(0, bridge.pendingCalls());
        for (int t = 0; t < threads.length; t++) {
            for (int i = 0; i < 40; i++) assertNotNull(page.resolved(1000 * (t + 1) + i));
        }
    }
}
