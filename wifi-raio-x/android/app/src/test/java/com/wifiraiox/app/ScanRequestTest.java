package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.Intent;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.ShadowSystemClock;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Pedido de varredura (aceito/recusado e por quê) e os eventos 'scan'. */
public class ScanRequestTest extends AllSdks {

    private Activity activity;
    private Fixtures.Page page;
    private Bridge bridge;

    @Before
    public void setUp() {
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        bridge = Fixtures.bridge(activity, page);
        Fixtures.grantLocation();
        ShadowSystemClock.advanceBy(60, TimeUnit.SECONDS); // relógio longe do zero
    }

    private JSONObject scan(int id) throws Exception {
        bridge.callAsync(id, "scan", "{}");
        return page.resolved(id);
    }

    private void systemAnnouncesResults(boolean updated) {
        Intent intent = new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
        intent.putExtra(WifiManager.EXTRA_RESULTS_UPDATED, updated);
        activity.sendBroadcast(intent);
        Fixtures.idle();
    }

    private static List<ScanResult> twoNetworks() {
        ScanResult a = Fixtures.scanResult("Casa", "AA:AA:AA:AA:AA:01", "[WPA2-PSK-CCMP][ESS]", -48, 2437);
        a.timestamp = (SystemClock.elapsedRealtime() - 700) * 1000;
        ScanResult b = Fixtures.scanResult("", "AA:AA:AA:AA:AA:02", "[ESS]", -80, 5500);
        b.timestamp = (SystemClock.elapsedRealtime() - 9000) * 1000;
        return Arrays.asList(a, b);
    }

    @Test
    public void acceptedRequest() throws Exception {
        Fixtures.wifi().setStartScanSucceeds(true);
        JSONObject r = scan(1);
        assertEquals(true, r.get("accepted"));
        assertFalse(r.has("reason"));
    }

    @Test
    public void refusedByAndroidGivesTheLikelyReason() throws Exception {
        Fixtures.wifi().setStartScanSucceeds(false);
        JSONObject r = scan(1);
        assertEquals(false, r.get("accepted"));
        // 28/29: o limite existe e não é consultável -> é a causa provável. 30+: o Robolectric diz
        // que o limite está desligado, então sobra "failed". Antes do 28 não havia limite em primeiro plano.
        String expected = Build.VERSION.SDK_INT >= 30 ? "failed" : Build.VERSION.SDK_INT >= 28 ? "throttled" : "failed";
        assertEquals(expected, r.get("reason"));
    }

    @Test
    public void refusedWithoutPermission() throws Exception {
        Fixtures.denyLocation();
        JSONObject r = scan(1);
        assertEquals(false, r.get("accepted"));
        assertEquals("no-permission", r.get("reason"));
    }

    @Test
    public void refusedWithLocationOff() throws Exception {
        Fixtures.setLocationEnabled(false);
        JSONObject r = scan(1);
        assertEquals(false, r.get("accepted"));
        assertEquals("location-off", r.get("reason"));
    }

    @Test
    public void refusedWithWifiOff() throws Exception {
        Fixtures.wifiManager().setWifiEnabled(false);
        Fixtures.wifi().setIsScanAlwaysAvailable(false);
        JSONObject r = scan(1);
        assertEquals(false, r.get("accepted"));
        assertEquals("wifi-off", r.get("reason"));

        // "Busca por Wi-Fi sempre disponível": o Android varre mesmo com o Wi-Fi desligado.
        Fixtures.wifi().setIsScanAlwaysAvailable(true);
        Fixtures.wifi().setStartScanSucceeds(true);
        assertEquals(true, scan(2).get("accepted"));
        Fixtures.wifi().setStartScanSucceeds(false);
        assertEquals("wifi-off", scan(3).get("reason"));
    }

    @Test
    public void securityExceptionBecomesNoPermission() throws Exception {
        Fixtures.wifi().setChangeWifiStatePermission(false);
        Fixtures.wifi().setAccessWifiStatePermission(false);
        JSONObject r = scan(1);
        assertEquals(false, r.get("accepted"));
        assertTrue(Arrays.asList("no-permission", "failed").contains(r.getString("reason")));
        // e a leitura do cache continua respondendo, vazia
        JSONObject last = new JSONObject(bridge.call("lastScan", "{}"));
        assertEquals(0, last.getJSONArray("aps").length());
    }

    @Test
    public void lastScanReturnsTheCacheWithContractShape() throws Exception {
        JSONObject empty = new JSONObject(bridge.call("lastScan", "{}"));
        assertEquals(new HashSet<>(Arrays.asList("ts", "fresh", "source", "aps")), Fixtures.keys(empty));
        assertEquals(0, empty.getJSONArray("aps").length()); // o Android (e o Robolectric) pode devolver lista nula

        Fixtures.wifi().setScanResults(twoNetworks());
        long before = System.currentTimeMillis();
        JSONObject last = new JSONObject(bridge.call("lastScan", "{}"));
        assertEquals(false, last.get("fresh"));
        assertEquals("cache", last.get("source"));
        assertTrue(last.getLong("ts") >= before);
        JSONArray aps = last.getJSONArray("aps");
        assertEquals(2, aps.length());
        assertEquals("aa:aa:aa:aa:aa:01", aps.getJSONObject(0).get("bssid"));
        assertEquals(700L, aps.getJSONObject(0).getLong("ageMs"));
        assertEquals("", aps.getJSONObject(1).get("ssid"));
        assertEquals(9000L, aps.getJSONObject(1).getLong("ageMs"));
    }

    @Test
    public void broadcastAfterOurRequestIsSourceRequest() throws Exception {
        bridge.onStart();
        Fixtures.wifi().setStartScanSucceeds(true);
        scan(1);
        // (com a lista já preenchida o Robolectric dispararia o aviso por conta própria)
        Fixtures.wifi().setScanResults(twoNetworks());
        ShadowSystemClock.advanceBy(3, TimeUnit.SECONDS);
        systemAnnouncesResults(true);
        List<JSONObject> events = page.events("scan");
        assertEquals(1, events.size());
        assertEquals("request", events.get(0).get("source"));
        assertEquals(true, events.get(0).get("fresh"));
        assertEquals(2, events.get(0).getJSONArray("aps").length());

        // O pedido já foi respondido: o próximo aviso é do sistema.
        systemAnnouncesResults(true);
        assertEquals("system", page.events("scan").get(1).get("source"));
    }

    /** Num aparelho lento a varredura passou de 12 s: a lista continua sendo a que o app pediu. */
    @Test
    public void aSlowScanIsStillCreditedToOurRequest() throws Exception {
        bridge.onStart();
        Fixtures.wifi().setStartScanSucceeds(true);
        scan(1);
        Fixtures.wifi().setScanResults(twoNetworks());
        ShadowSystemClock.advanceBy(12_500, TimeUnit.MILLISECONDS);
        systemAnnouncesResults(true);
        JSONObject event = page.lastEvent("scan");
        assertEquals("request", event.get("source"));
        assertEquals(true, event.get("fresh"));

        // e cada pedido leva o crédito de um aviso só
        systemAnnouncesResults(true);
        assertEquals("system", page.lastEvent("scan").get("source"));
    }

    @Test
    public void throttledRequestStillLabelsTheStaleBroadcast() throws Exception {
        bridge.onStart();
        Fixtures.wifi().setStartScanSucceeds(false);
        scan(1);
        systemAnnouncesResults(false); // o Android avisa "nada novo" quando recusa
        JSONObject event = page.lastEvent("scan");
        assertEquals("request", event.get("source"));
        assertEquals(false, event.get("fresh"));
    }

    @Test
    public void unsolicitedBroadcastIsSourceSystem() throws Exception {
        bridge.onStart();
        systemAnnouncesResults(true);
        assertEquals("system", page.lastEvent("scan").get("source"));

        // Pedido antigo (fora da janela) não leva o crédito.
        page.clear();
        Fixtures.wifi().setStartScanSucceeds(true);
        scan(1);
        ShadowSystemClock.advanceBy(WifiScanner.REQUEST_WINDOW_MS + 1000, TimeUnit.MILLISECONDS);
        systemAnnouncesResults(true);
        assertEquals("system", page.lastEvent("scan").get("source"));
    }

    @Test
    public void broadcastWithoutTheExtraCountsAsFresh() throws Exception {
        bridge.onStart();
        activity.sendBroadcast(new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        Fixtures.idle();
        assertEquals(true, page.lastEvent("scan").get("fresh"));
    }

    @Test
    public void noEventsBeforeStartOrAfterStop() throws Exception {
        systemAnnouncesResults(true);
        assertTrue(page.events("scan").isEmpty());
        bridge.onStart();
        bridge.onStart(); // idempotente: não registra duas vezes
        systemAnnouncesResults(true);
        assertEquals(1, page.events("scan").size());
        bridge.onStop();
        systemAnnouncesResults(true);
        assertEquals(1, page.events("scan").size());
    }
}
