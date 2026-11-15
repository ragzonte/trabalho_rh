package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.app.Activity;
import android.net.Network;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.ShadowNetwork;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Teste de velocidade contra um servidor HTTP local que imita o speed.cloudflare.com
 * (GET /__down?bytes=N e POST /__up). As conexões, os fluxos em paralelo e o cancelamento são reais.
 */
public class SpeedTest extends AllSdks {

    private FakeSpeedServer server;
    private String base;
    private final List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());
    private final Network wifi = ShadowNetwork.newInstance(9);
    /** No lugar de Network.openConnection: uma conexão comum, que aqui só alcança o servidor local. */
    private final SpeedTester.Openers local = network -> url -> (HttpURLConnection) url.openConnection();

    @Before
    public void startServer() {
        try {
            server = new FakeSpeedServer();
        } catch (IOException e) {
            assumeTrue("sem rede local neste ambiente", false);
            return;
        }
        base = server.baseUrl();
    }

    @After
    public void stopServer() {
        if (server != null) server.close();
    }

    private SpeedTester tester(SpeedTester.Plan plan) {
        return new SpeedTester(base, local, plan);
    }

    private static List<JSONObject> phase(List<JSONObject> all, String name) {
        List<JSONObject> out = new ArrayList<>();
        for (JSONObject e : all) if (name.equals(e.optString("phase"))) out.add(e);
        return out;
    }

    @Test
    public void lightTestMeasuresLatencyDownloadAndUpload() throws Exception {
        JSONObject s = tester(null).run("light", wifi, events::add);
        assertEquals(s.toString(), true, s.get("ok"));
        assertEquals(new HashSet<>(Arrays.asList("ok", "latencyMs", "jitterMs", "downMbps", "upMbps", "bytesDown", "bytesUp", "server")),
                Fixtures.keys(s));
        assertTrue(s.getDouble("latencyMs") >= 0 && s.getDouble("latencyMs") < 2000);
        assertTrue(s.getDouble("jitterMs") >= 0);
        assertTrue(s.getDouble("downMbps") > 1);
        assertTrue(s.getDouble("upMbps") > 1);
        assertEquals("GRU", s.get("server"));
        // o modo leve para no teto de dados (25 MB para baixar, 10 MB para enviar), com folga de um pedaço
        long down = s.getLong("bytesDown");
        long up = s.getLong("bytesUp");
        assertTrue("download " + down, down >= 25_000_000L && down < 26_000_000L);
        assertTrue("upload " + up, up >= 10_000_000L && up < 10_100_000L);
        assertTrue(server.downRequests.get() >= 5);
        assertTrue(server.upRequests.get() >= 5);

        // eventos: latência, depois download, depois upload; cada fase termina em progresso 1
        List<String> order = new ArrayList<>();
        for (JSONObject e : events) {
            String p = e.getString("phase");
            if (order.isEmpty() || !order.get(order.size() - 1).equals(p)) order.add(p);
        }
        assertEquals(Arrays.asList("latency", "download", "upload"), order);
        List<JSONObject> latency = phase(events, "latency");
        assertEquals(5, latency.size());
        for (JSONObject e : latency) {
            assertEquals(new HashSet<>(Arrays.asList("phase", "progress", "ms", "bytes")), Fixtures.keys(e));
            assertTrue(e.getDouble("ms") >= 0);
        }
        assertEquals(0.2, latency.get(0).getDouble("progress"), 1e-9);
        assertEquals(1.0, latency.get(4).getDouble("progress"), 1e-9);
        for (String name : new String[] {"download", "upload"}) {
            List<JSONObject> list = phase(events, name);
            assertFalse(name, list.isEmpty());
            double last = 0;
            for (JSONObject e : list) {
                assertEquals(new HashSet<>(Arrays.asList("phase", "progress", "mbps", "bytes")), Fixtures.keys(e));
                double p = e.getDouble("progress");
                assertTrue(p >= last && p <= 1);
                assertTrue(e.getDouble("mbps") >= 0);
                last = p;
            }
            assertEquals(name, 1.0, last, 1e-9);
        }
    }

    @Test
    public void phaseEndsByTimeWhenTheLinkIsSlow() throws Exception {
        server.chunkPauseMs = 20; // ~1,6 MB/s por conexão: o teto de dados nunca é alcançado
        SpeedTester.Plan quick = new SpeedTester.Plan(1.0, 0.3, Long.MAX_VALUE, Long.MAX_VALUE, 3, 2, 2, 50_000_000L, 50_000_000L);
        long t0 = System.currentTimeMillis();
        JSONObject s = tester(quick).run("full", wifi, events::add);
        long took = System.currentTimeMillis() - t0;
        assertEquals(s.toString(), true, s.get("ok"));
        assertTrue("duas fases de ~1 s: " + took, took >= 1800 && took < 8000);
        assertTrue(s.getDouble("downMbps") > 0.5 && s.getDouble("downMbps") < 400);
        assertTrue(s.getLong("bytesDown") > 0 && s.getLong("bytesDown") < 50_000_000L);
        assertTrue(s.getLong("bytesUp") > 0);
        List<JSONObject> down = phase(events, "download");
        assertTrue("vários avisos por segundo", down.size() >= 4);
        assertEquals(1.0, down.get(down.size() - 1).getDouble("progress"), 1e-9);
        assertTrue(down.get(0).getDouble("progress") < 0.5);
    }

    @Test
    public void cancelStopsQuicklyWithCancelledAndTheBytesSpent() throws Exception {
        server.chunkPauseMs = 20;
        final SpeedTester t = tester(null);
        final JSONObject[] result = new JSONObject[1];
        final CountDownLatch downloading = new CountDownLatch(1);
        Thread runner = new Thread(() -> result[0] = t.run("full", wifi, e -> {
            if ("download".equals(e.optString("phase"))) downloading.countDown();
        }));
        runner.start();
        assertTrue(downloading.await(20, TimeUnit.SECONDS));
        long t0 = System.currentTimeMillis();
        t.cancel();
        runner.join(5000);
        assertFalse("o teste completo levaria 16 s", runner.isAlive());
        assertTrue(System.currentTimeMillis() - t0 < 3000);
        assertEquals(false, result[0].get("ok"));
        assertEquals("cancelled", result[0].get("error"));
        assertEquals(new HashSet<>(Arrays.asList("ok", "error", "bytesDown", "bytesUp")), Fixtures.keys(result[0]));
        assertTrue(result[0].getLong("bytesDown") > 0);
        assertEquals(0, result[0].getLong("bytesUp"));
        t.cancel(); // nada rodando
    }

    @Test
    public void aSecondTestCancelsTheFirst() throws Exception {
        server.chunkPauseMs = 20;
        final SpeedTester t = tester(null);
        final JSONObject[] first = new JSONObject[1];
        final CountDownLatch started = new CountDownLatch(1);
        Thread runner = new Thread(() -> first[0] = t.run("full", wifi, e -> started.countDown()));
        runner.start();
        assertTrue(started.await(20, TimeUnit.SECONDS));
        server.chunkPauseMs = 0;
        JSONObject second = t.run("light", wifi, e -> { });
        runner.join(5000);
        assertFalse(runner.isAlive());
        assertEquals("cancelled", first[0].get("error"));
        assertEquals(second.toString(), true, second.get("ok"));
    }

    @Test
    public void withoutWifiTheTestIsOffline() throws Exception {
        JSONObject s = tester(null).run("full", null, events::add);
        assertEquals(false, s.get("ok"));
        assertEquals("offline", s.get("error"));
        assertEquals(0, s.getLong("bytesDown"));
        assertEquals(0, s.getLong("bytesUp"));
        assertTrue(events.isEmpty());
        assertEquals(0, server.downRequests.get());
    }

    @Test
    public void unreachableServerIsOffline() throws Exception {
        SpeedTester.Openers noDns = network -> url -> {
            throw new UnknownHostException("speed.cloudflare.com");
        };
        JSONObject s = new SpeedTester(base, noDns, null).run("light", wifi, events::add);
        assertEquals("offline", s.get("error"));

        server.close(); // ninguém escutando: conexão recusada
        JSONObject refused = tester(null).run("light", wifi, events::add);
        assertEquals(false, refused.get("ok"));
        assertEquals("offline", refused.get("error"));
        assertTrue(events.isEmpty());
    }

    @Test
    public void serverErrorIsAFailedTest() throws Exception {
        server.downStatus = 429; // limite de uso do serviço
        JSONObject s = tester(null).run("light", wifi, events::add);
        assertEquals(false, s.get("ok"));
        assertEquals("failed", s.get("error"));
    }

    @Test
    public void uploadRefusedByTheServerFailsInsteadOfInventingANumber() throws Exception {
        server.upStatus = 403;
        JSONObject s = tester(null).run("light", wifi, events::add);
        assertEquals(s.toString(), false, s.get("ok"));
        assertEquals("failed", s.get("error"));
        assertTrue("o download já tinha gastado dados: isso é informado", s.getLong("bytesDown") >= 25_000_000L);
        assertTrue(server.upRequests.get() >= 1);
    }

    @Test
    public void helpers() {
        assertEquals(3.0, SpeedTester.median(Arrays.asList(9.0, 1.0, 3.0)), 1e-9);
        assertEquals(5.0, SpeedTester.median(Arrays.asList(5.0)), 1e-9);
        assertEquals(0.0, SpeedTester.jitter(Arrays.asList(5.0)), 1e-9);
        assertEquals(3.0, SpeedTester.jitter(Arrays.asList(10.0, 14.0, 12.0)), 1e-9);
        assertEquals(1.23, SpeedTester.serverTime("cfRequestDuration;dur=1.23"), 1e-9);
        assertEquals(12.0, SpeedTester.serverTime("cfL4;desc=\"x\", cfRequestDuration;dur=12"), 1e-9);
        assertEquals(-1.0, SpeedTester.serverTime(null), 1e-9);
        assertEquals(-1.0, SpeedTester.serverTime("nada"), 1e-9);
        assertEquals(-1.0, SpeedTester.serverTime("dur="), 1e-9);
        assertTrue(SpeedTester.validMode("full"));
        assertTrue(SpeedTester.validMode("light"));
        assertFalse(SpeedTester.validMode("turbo"));
        assertFalse(SpeedTester.validMode(null));
        assertEquals("offline", SpeedTester.classify(new UnknownHostException("x")));
        assertEquals("offline", SpeedTester.classify(new java.net.ConnectException("refused")));
        assertEquals("offline", SpeedTester.classify(new java.net.SocketTimeoutException()));
        assertEquals("failed", SpeedTester.classify(new IOException("HTTP 500")));
        assertEquals("failed", SpeedTester.classify(new javax.net.ssl.SSLHandshakeException("portal cativo")));
    }

    // ------------------------------------------------------------ pela ponte

    @Test
    public void bridgeRunsTheTestAndEmitsSpeedEvents() throws Exception {
        Activity activity = Fixtures.activity();
        Fixtures.Page page = new Fixtures.Page();
        Bridge bridge = Fixtures.bridge(activity, page, null, null, tester(null));
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"192.168.1.5/24"}, "192.168.1.1"));

        assertTrue("só pelo caminho assíncrono", new JSONObject(bridge.call("speedTest", "{}")).getString("error").contains("callAsync"));
        for (String bad : new String[] {"{\"mode\":\"turbo\"}", "{\"mode\":5}", "{\"mode\":null}"}) {
            bridge.callAsync(1, "speedTest", bad);
            assertEquals(bad, "argumentos inválidos: mode", page.resolved(1).get("error"));
            page.clear();
        }

        bridge.callAsync(2, "speedTest", "{\"mode\":\"light\"}");
        JSONObject s = page.awaitResolved(2, 30_000);
        assertEquals(s.toString(), true, s.get("ok"));
        assertTrue(s.getDouble("downMbps") > 0);
        List<JSONObject> speed = page.events("speed");
        assertFalse(speed.isEmpty());
        Set<String> phases = new HashSet<>();
        for (JSONObject e : speed) phases.add(e.getString("phase"));
        assertEquals(new HashSet<>(Arrays.asList("latency", "download", "upload")), phases);
        assertEquals("{\"ok\":true}", bridge.call("cancel", "{\"op\":\"speed\"}"));
        bridge.onDestroy();
    }

    @Test
    public void bridgeAnswersOfflineWithoutWifiAndCancelsOnDemand() throws Exception {
        Activity activity = Fixtures.activity();
        Fixtures.Page page = new Fixtures.Page();
        Bridge bridge = Fixtures.bridge(activity, page, null, null, tester(null));

        Fixtures.cellularOnly(); // só dados móveis: o teste não roda (não gasta a franquia do chip)
        bridge.callAsync(1, "speedTest", "{}");
        JSONObject offline = page.awaitResolved(1, 10_000);
        assertEquals(false, offline.get("ok"));
        assertEquals("offline", offline.get("error"));
        assertEquals(0, server.downRequests.get());

        Fixtures.wifiNetwork(null);
        server.chunkPauseMs = 20;
        bridge.callAsync(2, "speedTest", "{\"mode\":\"full\"}");
        long deadline = System.currentTimeMillis() + 20_000;
        while (page.events("speed").isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertFalse(page.events("speed").isEmpty());
        assertNull(page.resolved(2));
        bridge.call("cancel", "{\"op\":\"speed\"}");
        assertEquals("cancelled", page.awaitResolved(2, 5000).get("error"));

        // encerrar a tela também interrompe
        bridge.callAsync(3, "speedTest", "{\"mode\":\"full\"}");
        Thread.sleep(300);
        bridge.onDestroy();
        assertNotNull(page.resolved(3));
        assertEquals(0, bridge.pendingCalls());
    }
}
