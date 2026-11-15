package com.wifiraiox.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.MacAddress;
import android.net.wifi.ScanResult;
import android.net.wifi.rtt.RangingResult;
import android.net.wifi.rtt.WifiRttManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.RangingResultBuilder;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.util.ReflectionHelpers;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Wi-Fi RTT: indisponível com elegância onde não existe; medidas em metros onde existe. */
public class RttTest extends AllSdks {

    private static final String FEATURE = "android.hardware.wifi.rtt";
    private static final String AP_MC = "a4:91:b1:00:11:22";      // anuncia 802.11mc
    private static final String AP_MC_2 = "a4:91:b1:00:11:33";
    private static final String AP_PLAIN = "0c:11:22:33:44:55";   // não anuncia
    private static final String AP_GONE = "de:ad:be:ef:00:00";    // não está na varredura

    private Activity activity;
    private Fixtures.Page page;
    private Bridge bridge;

    @Before
    public void setUp() {
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        bridge = Fixtures.bridge(activity, page);
        Fixtures.grantLocation();
    }

    private void deviceSupportsRtt() {
        shadowOf(activity.getPackageManager()).setSystemFeature(FEATURE, true);
    }

    /** (O Robolectric liga todo recurso citado em uses-feature no manifesto; aqui o aparelho não tem o rádio.) */
    private void deviceLacksRtt() {
        shadowOf(activity.getPackageManager()).setSystemFeature(FEATURE, false);
    }

    private static ScanResult ap(String bssid, boolean responder) {
        ScanResult r = Fixtures.scanResult("rede", bssid.toUpperCase(), "[ESS]", -50, 5180);
        if (responder) ReflectionHelpers.setField(r, "flags", 0x2L);
        return r;
    }

    private void scanShows(ScanResult... results) {
        Fixtures.wifi().setScanResults(Arrays.asList(results));
    }

    private JSONArray rtt(int id, String... bssids) throws Exception {
        JSONArray wanted = new JSONArray();
        for (String b : bssids) wanted.put(b);
        bridge.callAsync(id, "rtt", new JSONObject().put("bssids", wanted).toString());
        Fixtures.idle();
        answerNearbyDialogIfShown();
        JSONObject r = page.resolved(id);
        assertNotNull("rtt tem de responder sempre", r);
        return r.getJSONArray("results");
    }

    /** Android 13+: o primeiro uso pede "Dispositivos por perto"; o resultado sai com qualquer resposta. */
    private void answerNearbyDialogIfShown() {
        ShadowActivity.PermissionsRequest request = shadowOf(activity).getLastRequestedPermission();
        if (request != null && request.requestCode == Permissions.REQUEST_NEARBY) {
            bridge.onPermissionsResult(Permissions.REQUEST_NEARBY, request.requestedPermissions,
                    new int[] {PackageManager.PERMISSION_DENIED});
            Fixtures.idle();
        }
    }

    @Test
    public void infoSaysRttOnlyWithApiAndFeature() throws Exception {
        deviceLacksRtt();
        assertEquals(false, new JSONObject(bridge.call("info", "{}")).get("rtt"));
        deviceSupportsRtt();
        assertEquals(Build.VERSION.SDK_INT >= 28, new JSONObject(bridge.call("info", "{}")).get("rtt"));
    }

    @Test
    public void withoutTheFeatureResultsAreEmpty() throws Exception {
        deviceLacksRtt();
        scanShows(ap(AP_MC, true));
        assertEquals(0, rtt(1, AP_MC).length());
        assertNull("nem pede permissão", shadowOf(activity).getLastRequestedPermission());
    }

    @Test
    public void oldAndroidResultsAreEmptyEvenIfTheFeatureFlagIsSet() throws Exception {
        if (Build.VERSION.SDK_INT >= 28) return;
        deviceSupportsRtt();
        scanShows(ap(AP_MC, true));
        assertEquals(0, rtt(1, AP_MC).length());
    }

    @Test
    public void malformedArgumentsAreErrorsNotCrashes() throws Exception {
        deviceSupportsRtt();
        for (String args : new String[] {"{}", "{\"bssids\":\"aa:bb\"}", "{\"bssids\":5}", "{\"bssids\":null}"}) {
            bridge.callAsync(50, "rtt", args);
            Fixtures.idle();
            JSONObject r = page.resolved(50);
            assertTrue(args, r.has("error"));
            page.clear();
        }
        // lista vazia ou com lixo dentro: resposta vazia
        assertEquals(0, rtt(51).length());
        bridge.callAsync(52, "rtt", "{\"bssids\":[1,null,{}]}");
        Fixtures.idle();
        assertEquals(0, page.resolved(52).getJSONArray("results").length());
    }

    @Test
    public void measuresRespondersAndFlagsTheRest() throws Exception {
        if (Build.VERSION.SDK_INT < 28) return;
        deviceSupportsRtt();
        scanShows(ap(AP_MC, true), ap(AP_PLAIN, false), ap(AP_MC_2, true));
        WifiRttManager manager = (WifiRttManager) activity.getSystemService(Context.WIFI_RTT_RANGING_SERVICE);
        List<RangingResult> measured = new ArrayList<>();
        measured.add(new RangingResultBuilder(RangingResult.STATUS_SUCCESS, MacAddress.fromString(AP_MC), 1000L, 4321)
                .setDistanceStandardDeviation(150).setRssi(-48).setNumAttemptedMeasurements(8).setNumSuccessfulMeasurements(7).build());
        measured.add(new RangingResultBuilder(RangingResult.STATUS_FAIL, MacAddress.fromString(AP_MC_2), 1000L, 0).build());
        shadowOf(manager).setRangeResults(measured);

        JSONArray results = rtt(1, AP_MC.toUpperCase(), AP_PLAIN, AP_GONE, AP_MC_2);
        assertEquals("uma resposta por BSSID pedido, na ordem do pedido", 4, results.length());

        JSONObject ok = results.getJSONObject(0);
        assertEquals(AP_MC, ok.get("bssid"));
        assertEquals(true, ok.get("ok"));
        assertEquals("milímetros viram metros", 4.321, ok.getDouble("distM"), 1e-9);
        assertEquals(0.15, ok.getDouble("stdM"), 1e-9);
        assertEquals(-48, ok.get("rssi"));
        assertEquals(8, ok.get("attempts"));
        assertEquals(7, ok.get("successes"));
        assertEquals(new HashSet<>(Arrays.asList("bssid", "ok", "distM", "stdM", "rssi", "attempts", "successes")), Fixtures.keys(ok));

        for (int i = 1; i < 4; i++) {
            JSONObject failed = results.getJSONObject(i);
            assertEquals(false, failed.get("ok"));
            assertEquals("falha não traz medidas (os getters do Android lançariam)",
                    new HashSet<>(Arrays.asList("bssid", "ok")), Fixtures.keys(failed));
        }
        assertEquals(AP_PLAIN, results.getJSONObject(1).get("bssid"));
        assertEquals(AP_GONE, results.getJSONObject(2).get("bssid"));
        assertEquals(AP_MC_2, results.getJSONObject(3).get("bssid"));
    }

    @Test
    public void rangingFailureMarksEveryTargetAsFailed() throws Exception {
        if (Build.VERSION.SDK_INT < 28) return;
        deviceSupportsRtt();
        scanShows(ap(AP_MC, true));
        // sem resultados configurados o Robolectric chama onRangingFailure
        JSONArray results = rtt(1, AP_MC);
        assertEquals(1, results.length());
        assertEquals(false, results.getJSONObject(0).get("ok"));
    }

    @Test
    public void noScanPermissionMeansNothingToRange() throws Exception {
        if (Build.VERSION.SDK_INT < 28) return;
        deviceSupportsRtt();
        Fixtures.wifi().setScanResults(null);
        JSONArray results = rtt(1, AP_MC);
        assertEquals(1, results.length());
        assertEquals(false, results.getJSONObject(0).get("ok"));
        assertNull("sem alvo não há por que pedir permissão", shadowOf(activity).getLastRequestedPermission());
    }

    @Test
    public void android13AsksNearbyDevicesOnceAndResolvesWhateverTheAnswer() throws Exception {
        if (Build.VERSION.SDK_INT < 28) return;
        deviceSupportsRtt();
        scanShows(ap(AP_MC, true));
        bridge.callAsync(1, "rtt", "{\"bssids\":[\"" + AP_MC + "\"]}");
        Fixtures.idle();
        ShadowActivity.PermissionsRequest request = shadowOf(activity).getLastRequestedPermission();
        if (Build.VERSION.SDK_INT < 33) {
            assertNull("a permissão só existe do Android 13 em diante", request);
            assertNotNull(page.resolved(1));
            return;
        }
        assertNotNull(request);
        assertEquals(Permissions.REQUEST_NEARBY, request.requestCode);
        assertArrayEquals(new String[] {"android.permission.NEARBY_WIFI_DEVICES"}, request.requestedPermissions);
        assertNull("espera a resposta do usuário", page.resolved(1));

        bridge.onPermissionsResult(Permissions.REQUEST_NEARBY, request.requestedPermissions, new int[] {PackageManager.PERMISSION_DENIED});
        Fixtures.idle();
        assertEquals(1, page.resolved(1).getJSONArray("results").length());

        // segunda medição: não pergunta de novo
        Activity fresh = Fixtures.activity();
        Bridge second = Fixtures.bridge(fresh, page);
        second.callAsync(2, "rtt", "{\"bssids\":[\"" + AP_MC + "\"]}");
        Fixtures.idle();
        assertNull(shadowOf(fresh).getLastRequestedPermission());
        assertNotNull(page.resolved(2));
    }

    @Test
    public void unansweredRequestTimesOut() throws Exception {
        if (Build.VERSION.SDK_INT < 33) return; // só dá para segurar a medição pelo diálogo do Android 13+
        deviceSupportsRtt();
        scanShows(ap(AP_MC, true));
        bridge.callAsync(1, "rtt", "{\"bssids\":[\"" + AP_MC + "\"]}");
        Fixtures.idle();
        assertNull(page.resolved(1));
        // enquanto a pessoa lê o diálogo de permissão o prazo é longo
        ShadowLooper.idleMainLooper(RttRanger.TIMEOUT_MS + 5000, TimeUnit.MILLISECONDS);
        assertNull(page.resolved(1));
        ShadowLooper.idleMainLooper(RttRanger.DIALOG_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        JSONObject r = page.resolved(1);
        assertNotNull("depois do prazo a promessa resolve de qualquer jeito", r);
        assertEquals(false, r.getJSONArray("results").getJSONObject(0).get("ok"));

        // a resposta atrasada do diálogo não gera segunda resposta nem medição
        bridge.onPermissionsResult(Permissions.REQUEST_NEARBY, new String[] {"android.permission.NEARBY_WIFI_DEVICES"},
                new int[] {PackageManager.PERMISSION_GRANTED});
        Fixtures.idle();
        assertNotNull(page.resolved(1));
    }

    @Test
    public void destroyResolvesPendingRanging() throws Exception {
        if (Build.VERSION.SDK_INT < 33) return;
        deviceSupportsRtt();
        scanShows(ap(AP_MC, true));
        bridge.callAsync(1, "rtt", "{\"bssids\":[\"" + AP_MC + "\"]}");
        Fixtures.idle();
        assertNull(page.resolved(1));
        bridge.onDestroy();
        assertFalse(page.resolved(1).getJSONArray("results").getJSONObject(0).getBoolean("ok"));
    }
}
