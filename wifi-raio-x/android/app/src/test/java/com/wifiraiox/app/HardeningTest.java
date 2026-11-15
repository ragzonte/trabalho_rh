package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Intent;
import android.net.Network;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.ShadowNetwork;
import org.robolectric.shadows.ShadowSystemClock;

import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Defeitos corrigidos na revisão do lado nativo: uma falha numa thread de trabalho ou num aviso do
 * sistema nunca pode derrubar o app, e carimbos de tempo estranhos não podem estragar as idades.
 */
public class HardeningTest extends AllSdks {

    private Thread.UncaughtExceptionHandler previousHandler;
    private final AtomicReference<Throwable> crashed = new AtomicReference<>();
    private ScheduledExecutorService watchdog;

    /** No celular, o que chega ao tratador padrão encerra o app ("o app parou de funcionar"). */
    @Before
    public void watchForCrashes() {
        previousHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> crashed.set(error));
        watchdog = Executors.newSingleThreadScheduledExecutor();
    }

    @After
    public void restore() {
        Thread.setDefaultUncaughtExceptionHandler(previousHandler);
        watchdog.shutdownNow();
    }

    // ------------------------------------------------------------ threads de trabalho

    @Test
    public void anErrorInAWorkerThreadIsLoggedNotFatal() throws Exception {
        Thread loose = Sys.thread("teste", () -> {
            throw new AssertionError("falha de propósito");
        });
        assertTrue(loose.isDaemon());
        assertEquals("wrx-teste", loose.getName());
        loose.start();
        loose.join(5000);

        final CountDownLatch ran = new CountDownLatch(1);
        Thread pooled = Sys.threads("grupo").newThread(() -> {
            ran.countDown();
            throw new NoSuchMethodError("API que este aparelho não tem");
        });
        assertEquals("wrx-grupo-1", pooled.getName());
        pooled.start();
        pooled.join(5000);
        assertTrue(ran.await(1, TimeUnit.SECONDS));
        assertNull("nada chega ao tratador que encerra o app", crashed.get());
    }

    @Test
    public void aFailingScanListenerLosesOneListNotTheApp() throws Exception {
        Activity activity = Fixtures.activity();
        Fixtures.grantLocation();
        final int[] calls = {0};
        WifiScanner scanner = new WifiScanner(activity, new Permissions(activity), Runnable::run, event -> {
            calls[0]++;
            throw new NoClassDefFoundError("falha de propósito");
        });
        scanner.start();
        activity.sendBroadcast(new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)); // lançaria aqui dentro
        Fixtures.idle();
        activity.sendBroadcast(new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        Fixtures.idle();
        assertEquals("o aviso seguinte ainda é atendido", 2, calls[0]);
        scanner.stop();
    }

    @Test
    public void aFailingStatusListenerDoesNotEscapeTheReceiver() {
        Activity activity = Fixtures.activity();
        final int[] calls = {0};
        StatusWatcher watcher = new StatusWatcher(activity, () -> {
            calls[0]++;
            throw new IllegalStateException("falha de propósito");
        });
        watcher.start();
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION)); // uma exceção num receiver derruba o app
        Fixtures.idle();
        assertEquals(1, calls[0]);
        watcher.stop();
    }

    @Test
    public void anErrorInOneLanProbeDoesNotStopTheSweepOrTheApp() throws Exception {
        LanScanner.Net net = new LanScanner.Net() {
            @Override
            public double probe(InetAddress address, int attempt, Network network) {
                if (address.getHostAddress().endsWith(".1")) throw new AssertionError("getsockname failed: EBADF");
                return address.getHostAddress().endsWith(".2") ? 4.0 : -1;
            }

            @Override
            public String dnsName(InetAddress address) {
                return null;
            }

            @Override
            public String netbiosName(InetAddress address, Network network) {
                return null;
            }

            @Override
            public Map<String, String> arp() {
                return new HashMap<>();
            }
        };
        final List<int[]> progress = Collections.synchronizedList(new ArrayList<>());
        JSONObject result = new LanScanner(net, 4).run(
                new ConnectionTracker.LanTarget(LanRange.parse("192.168.7.6"), 29, 0, null),
                new LanScanner.Events() {
                    @Override
                    public void onDevice(JSONObject device) {
                    }

                    @Override
                    public void onProgress(int done, int total) {
                        progress.add(new int[] {done, total});
                    }
                });
        JSONArray devices = result.getJSONArray("devices");
        assertEquals("quem respondeu aparece, mais o próprio celular", 2, devices.length());
        assertEquals("192.168.7.2", devices.getJSONObject(0).get("ip"));
        assertEquals("192.168.7.6", devices.getJSONObject(1).get("ip"));
        int[] last = progress.get(progress.size() - 1);
        assertEquals("a varredura chega ao fim", last[1], last[0]);
        assertEquals(6, last[1]);
        assertNull(crashed.get());
    }

    @Test
    public void anErrorInsideASpeedTestConnectionIsAFailedTestNotACrash() throws Exception {
        FakeSpeedServer server;
        try {
            server = new FakeSpeedServer();
        } catch (java.io.IOException e) {
            org.junit.Assume.assumeTrue("sem rede local neste ambiente", false);
            return;
        }
        try {
            // a medida de latência funciona; as conexões de download falham com um Error (não uma exceção comum)
            SpeedTester.Openers openers = network -> url -> {
                if (url.toString().endsWith("bytes=0")) return (HttpURLConnection) url.openConnection();
                throw new AssertionError("getsockname failed: EBADF");
            };
            SpeedTester tester = new SpeedTester(server.baseUrl(), openers,
                    new SpeedTester.Plan(0.6, 0.1, 1_000_000L, 1_000_000L, 2, 2, 2, 100_000L, 100_000L));
            JSONObject summary = tester.run("light", ShadowNetwork.newInstance(9), progress -> { });
            assertEquals(false, summary.get("ok"));
            assertEquals("failed", summary.get("error"));
            assertEquals(0L, summary.getLong("bytesDown"));
            Thread.sleep(200);
            assertNull("as threads do teste não derrubam o app", crashed.get());
        } finally {
            server.close();
        }
    }

    @Test
    public void aPingProbeThatBlowsUpResolvesTheCallWithAnError() throws Exception {
        Pinger pinger = new Pinger("/nao/existe", null, host -> InetAddress.getByAddress(new byte[] {10, 0, 0, 1}),
                new Pinger.Prober[] {(address, timeoutMs) -> {
                    throw new AssertionError("falha de propósito");
                }}, watchdog);
        Fixtures.Page page = new Fixtures.Page();
        Bridge bridge = Fixtures.bridge(Fixtures.activity(), page, pinger, null);
        bridge.callAsync(1, "ping", "{\"host\":\"10.0.0.1\",\"count\":1}");
        JSONObject r = page.awaitResolved(1, 10_000);
        assertTrue("a página recebe um erro em vez de esperar para sempre", r.has("error"));
        assertEquals(0, bridge.pendingCalls());
        assertNull(crashed.get());
        bridge.onDestroy();
    }

    // ------------------------------------------------------------ carimbos de tempo da varredura

    private static final long NOW = 3_600_000L; // o celular está ligado há uma hora

    private static ScanResult heard(String bssid, long timestampMicros) {
        ScanResult r = Fixtures.scanResult("rede", bssid, "[ESS]", -60, 2437);
        r.timestamp = timestampMicros;
        return r;
    }

    private static long[] ages(JSONArray aps) throws Exception {
        long[] out = new long[aps.length()];
        for (int i = 0; i < out.length; i++) out[i] = aps.getJSONObject(i).getLong("ageMs");
        return out;
    }

    @Test
    public void healthyStampsGiveEachNetworkItsOwnAge() throws Exception {
        List<ScanResult> list = Arrays.asList(
                heard("AA:00:00:00:00:01", (NOW - 400) * 1000),
                heard("AA:00:00:00:00:02", (NOW - 2800) * 1000),
                heard("AA:00:00:00:00:03", (NOW - 31_000) * 1000)); // sobra de uma varredura anterior
        assertTrue(ScanMapper.stampsLookRight(list, NOW, true));
        org.junit.Assert.assertArrayEquals(new long[] {400, 2800, 31_000}, ages(ScanMapper.list(list, NOW, true, 0)));
        // uma lista do cache pode ser antiga à vontade
        List<ScanResult> old = Arrays.asList(heard("AA:00:00:00:00:01", (NOW - 900_000) * 1000));
        assertTrue(ScanMapper.stampsLookRight(old, NOW, false));
        org.junit.Assert.assertArrayEquals(new long[] {900_000}, ages(ScanMapper.list(old, NOW, false, 5000)));
        // um resultado sem carimbo no meio de uma lista boa é só ele que fica "muito velho"
        List<ScanResult> mixed = Arrays.asList(heard("AA:00:00:00:00:01", (NOW - 400) * 1000), heard("AA:00:00:00:00:02", 0));
        org.junit.Assert.assertArrayEquals(new long[] {400, NOW}, ages(ScanMapper.list(mixed, NOW, true, 0)));
        assertTrue(ScanMapper.stampsLookRight(new ArrayList<>(), NOW, true));
    }

    @Test
    public void routerClockStampsAreNotMistakenForAges() throws Exception {
        // Aparelho cujo carimbo é o relógio de cada roteador: um ligado há 30 dias (parece "no futuro"),
        // outro reiniciado há 10 minutos (pareceria ouvido há 50 minutos, e sumiria do mapeamento).
        List<ScanResult> list = Arrays.asList(
                heard("AA:00:00:00:00:01", 30L * 24 * 3600 * 1_000_000L),
                heard("AA:00:00:00:00:02", 600L * 1_000_000L));
        assertFalse(ScanMapper.stampsLookRight(list, NOW, true));
        org.junit.Assert.assertArrayEquals("lista recém-varrida: tudo acabou de ser ouvido",
                new long[] {0, 0}, ages(ScanMapper.list(list, NOW, true, 0)));
        org.junit.Assert.assertArrayEquals("lista em cache: tem a idade da última lista nova",
                new long[] {12_000, 12_000}, ages(ScanMapper.list(list, NOW, false, 12_000)));
    }

    @Test
    public void missingStampsAndStaleFreshListsFallBackToTheListAge() throws Exception {
        List<ScanResult> unstamped = Arrays.asList(heard("AA:00:00:00:00:01", 0), heard("AA:00:00:00:00:02", -5));
        assertFalse(ScanMapper.stampsLookRight(unstamped, NOW, true));
        org.junit.Assert.assertArrayEquals(new long[] {0, 0}, ages(ScanMapper.list(unstamped, NOW, true, 0)));
        org.junit.Assert.assertArrayEquals(new long[] {NOW, NOW}, ages(ScanMapper.list(unstamped, NOW)));

        // varredura nova em que nada parece ter sido ouvido no último minuto: o relógio é outro
        List<ScanResult> allOld = Arrays.asList(
                heard("AA:00:00:00:00:01", (NOW - 600_000) * 1000), heard("AA:00:00:00:00:02", (NOW - 1_200_000) * 1000));
        assertFalse(ScanMapper.stampsLookRight(allOld, NOW, true));
        assertTrue("como cache, a mesma lista é plausível", ScanMapper.stampsLookRight(allOld, NOW, false));
        org.junit.Assert.assertArrayEquals(new long[] {0, 0}, ages(ScanMapper.list(allOld, NOW, true, 0)));
        // folga: alguns segundos "no futuro" são atraso de leitura, não outro relógio
        List<ScanResult> slightlyAhead = Arrays.asList(heard("AA:00:00:00:00:01", (NOW + 1500) * 1000));
        assertTrue(ScanMapper.stampsLookRight(slightlyAhead, NOW, true));
        org.junit.Assert.assertArrayEquals(new long[] {0}, ages(ScanMapper.list(slightlyAhead, NOW, true, 0)));
    }

    @Test
    public void scannerAgesUnstampedCacheListsSinceTheLastFreshOne() throws Exception {
        Activity activity = Fixtures.activity();
        Fixtures.grantLocation();
        Fixtures.Page page = new Fixtures.Page();
        Bridge bridge = Fixtures.bridge(activity, page);
        bridge.onStart();
        ShadowSystemClock.advanceBy(1, TimeUnit.HOURS);
        // aparelho que não carimba os resultados
        Fixtures.wifi().setScanResults(Arrays.asList(heard("AA:00:00:00:00:01", 0), heard("AA:00:00:00:00:02", 0)));

        JSONObject first = new JSONObject(bridge.call("lastScan", "{}"));
        long uptime = SystemClock.elapsedRealtime();
        assertEquals("sem nenhuma lista nova ainda: idade desconhecida, tratada como muito antiga",
                uptime, first.getJSONArray("aps").getJSONObject(0).getLong("ageMs"));

        Intent fresh = new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
        fresh.putExtra(WifiManager.EXTRA_RESULTS_UPDATED, true);
        activity.sendBroadcast(fresh);
        Fixtures.idle();
        JSONObject event = page.lastEvent("scan");
        assertNotNull(event);
        org.junit.Assert.assertArrayEquals(new long[] {0, 0}, ages(event.getJSONArray("aps")));

        ShadowSystemClock.advanceBy(45, TimeUnit.SECONDS);
        Intent throttled = new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
        throttled.putExtra(WifiManager.EXTRA_RESULTS_UPDATED, false); // varredura recusada: a lista é a mesma de antes
        activity.sendBroadcast(throttled);
        Fixtures.idle();
        JSONObject stale = page.lastEvent("scan");
        assertEquals(false, stale.get("fresh"));
        org.junit.Assert.assertArrayEquals(new long[] {45_000, 45_000}, ages(stale.getJSONArray("aps")));
        org.junit.Assert.assertArrayEquals(new long[] {45_000, 45_000},
                ages(new JSONObject(bridge.call("lastScan", "{}")).getJSONArray("aps")));
        bridge.onDestroy();
    }
}
