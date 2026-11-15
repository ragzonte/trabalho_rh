package com.wifiraiox.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.wifi.WifiManager;
import android.os.Build;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowSystemClock;

import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.TimeUnit;

/** Status (o que falta para varrer) e o vaivém da permissão de localização. */
public class StatusTest extends AllSdks {

    private static final int[] DENIED = {PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_DENIED};
    private static final int[] GRANTED = {PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_GRANTED};
    private static final String[] BOTH = {Fixtures.FINE, Fixtures.COARSE};

    private Activity activity;
    private Fixtures.Page page;
    private Bridge bridge;

    @Before
    public void setUp() {
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        bridge = Fixtures.bridge(activity, page);
        Fixtures.denyLocation();
        rationale(false);
    }

    private JSONObject status() throws Exception {
        return new JSONObject(bridge.call("status", "{}"));
    }

    private void rationale(boolean show) {
        shadowOf(activity.getPackageManager()).setShouldShowRequestPermissionRationale(Fixtures.FINE, show);
    }

    /** O usuário responde ao diálogo depois de `afterMs`. */
    private void answer(int[] results, long afterMs) {
        ShadowSystemClock.advanceBy(afterMs, TimeUnit.MILLISECONDS);
        bridge.onPermissionsResult(Permissions.REQUEST_LOCATION, BOTH, results);
        Fixtures.idle();
    }

    @Test
    public void shapeMatchesTheContract() throws Exception {
        JSONObject s = status();
        assertEquals(new HashSet<>(Arrays.asList("wifiEnabled", "locationEnabled", "permission", "throttled", "canScan")),
                Fixtures.keys(s));
        assertTrue(s.get("wifiEnabled") instanceof Boolean);
        assertTrue(s.get("locationEnabled") instanceof Boolean);
        assertTrue(s.get("canScan") instanceof Boolean);
        assertTrue(s.get("permission") instanceof String);
        if (Build.VERSION.SDK_INT >= 30) {
            assertTrue("do Android 11 em diante dá para consultar o limite", s.get("throttled") instanceof Boolean);
        } else {
            assertTrue("antes do Android 11 não dá para saber", s.isNull("throttled"));
            assertTrue(s.has("throttled"));
        }
    }

    @Test
    public void grantedPreciseLocationAllowsScanning() throws Exception {
        Fixtures.grantLocation();
        JSONObject s = status();
        assertEquals("granted", s.get("permission"));
        assertEquals(true, s.get("wifiEnabled"));
        assertEquals(true, s.get("locationEnabled"));
        assertEquals(true, s.get("canScan"));
    }

    @Test
    public void approximateOnlyCountsAsDenied() throws Exception {
        shadowOf(Fixtures.app()).grantPermissions(Fixtures.COARSE);
        shadowOf(Fixtures.app()).denyPermissions(Fixtures.FINE);
        JSONObject s = status();
        assertEquals("denied", s.get("permission"));
        assertEquals(false, s.get("canScan"));
    }

    @Test
    public void neverAskedIsDeniedNotBlocked() throws Exception {
        // shouldShowRequestPermissionRationale também é false antes do primeiro pedido.
        assertEquals("denied", status().get("permission"));
        assertEquals(false, status().get("canScan"));
    }

    @Test
    public void wifiOffAndLocationOffBlockScanning() throws Exception {
        Fixtures.grantLocation();
        Fixtures.wifiManager().setWifiEnabled(false);
        JSONObject s = status();
        assertEquals(false, s.get("wifiEnabled"));
        assertEquals(false, s.get("canScan"));
        assertEquals("granted", s.get("permission"));

        Fixtures.wifiManager().setWifiEnabled(true);
        Fixtures.setLocationEnabled(false);
        s = status();
        assertEquals(true, s.get("wifiEnabled"));
        assertEquals(false, s.get("locationEnabled"));
        assertEquals(false, s.get("canScan"));
    }

    @Test
    public void requestAsksFineAndCoarseTogetherAndResolvesWithStatus() throws Exception {
        bridge.callAsync(1, "requestPermission", "{}");
        Fixtures.idle();
        ShadowActivity.PermissionsRequest request = shadowOf(activity).getLastRequestedPermission();
        assertNotNull(request);
        assertEquals(Permissions.REQUEST_LOCATION, request.requestCode);
        assertArrayEquals(BOTH, request.requestedPermissions);
        assertNull("a resposta só vem depois do diálogo", page.resolved(1));

        Fixtures.grantLocation();
        page.clear();
        answer(GRANTED, 2500);
        JSONObject s = page.resolved(1);
        assertEquals("granted", s.get("permission"));
        assertEquals(true, s.get("canScan"));
        assertEquals("granted", page.lastEvent("status").get("permission"));
        assertEquals(0, bridge.pendingCalls());
    }

    @Test
    public void alreadyGrantedResolvesWithoutDialog() throws Exception {
        Fixtures.grantLocation();
        bridge.callAsync(2, "requestPermission", "{}");
        Fixtures.idle();
        assertNull(shadowOf(activity).getLastRequestedPermission());
        assertEquals("granted", page.resolved(2).get("permission"));
    }

    @Test
    public void firstDenialIsDeniedSecondIsBlocked() throws Exception {
        bridge.callAsync(1, "requestPermission", "{}");
        rationale(true); // depois da primeira negativa o Android aceita explicar e perguntar de novo
        answer(DENIED, 3000);
        assertEquals("denied", page.resolved(1).get("permission"));

        bridge.callAsync(2, "requestPermission", "{}");
        rationale(false); // segunda negativa (ou "não perguntar de novo"): acabou
        answer(DENIED, 3000);
        assertEquals("blocked", page.resolved(2).get("permission"));
        assertEquals("blocked", status().get("permission"));
        assertEquals(false, status().get("canScan"));

        // Sobrevive ao reinício do app...
        Bridge again = Fixtures.bridge(Fixtures.activity(), new Fixtures.Page());
        assertEquals("blocked", new JSONObject(again.call("status", "{}")).get("permission"));
        // ...e some quando o usuário libera pelas configurações.
        Fixtures.grantLocation();
        assertEquals("granted", status().get("permission"));
        // De vez: se a permissão for retirada mais tarde o Android volta a perguntar, então o
        // estado é "negada" (com o botão de pedir), e não o "bloqueada" que ficou para trás.
        Fixtures.denyLocation();
        assertEquals("denied", status().get("permission"));
        assertEquals("denied", new JSONObject(Fixtures.bridge(Fixtures.activity(), new Fixtures.Page()).call("status", "{}")).get("permission"));
    }

    @Test
    public void instantDenialMeansTheSystemRefusedWithoutAsking() throws Exception {
        bridge.callAsync(1, "requestPermission", "{}");
        answer(DENIED, 40);
        assertEquals("blocked", page.resolved(1).get("permission"));
    }

    @Test
    public void dismissedDialogIsNotABlockUntilItRepeats() throws Exception {
        // Android 11+: fechar o diálogo sem escolher volta "negado" sem marcar nada no sistema.
        bridge.callAsync(1, "requestPermission", "{}");
        answer(DENIED, 4000);
        assertEquals("denied", page.resolved(1).get("permission"));

        bridge.callAsync(2, "requestPermission", "{}");
        answer(DENIED, 4000);
        assertEquals("na segunda vez seguida mandamos às configurações", "blocked", page.resolved(2).get("permission"));
    }

    @Test
    public void blockedClearsWhenAndroidOffersTheDialogAgain() throws Exception {
        bridge.callAsync(1, "requestPermission", "{}");
        answer(DENIED, 40);
        assertEquals("blocked", status().get("permission"));
        rationale(true);
        assertEquals("denied", status().get("permission"));
    }

    @Test
    public void cancelledRequestStillResolves() throws Exception {
        bridge.callAsync(1, "requestPermission", "{}");
        ShadowSystemClock.advanceBy(10, TimeUnit.MILLISECONDS);
        bridge.onPermissionsResult(Permissions.REQUEST_LOCATION, new String[0], new int[0]); // pedido interrompido
        Fixtures.idle();
        assertEquals("denied", page.resolved(1).get("permission"));
        assertEquals("interrupção não é bloqueio", "denied", status().get("permission"));
    }

    @Test
    public void concurrentRequestsShareOneDialog() throws Exception {
        bridge.callAsync(1, "requestPermission", "{}");
        bridge.callAsync(2, "requestPermission", "{}");
        Fixtures.idle();
        Fixtures.grantLocation();
        answer(GRANTED, 1500);
        assertEquals("granted", page.resolved(1).get("permission"));
        assertEquals("granted", page.resolved(2).get("permission"));
    }

    @Test
    public void destroyResolvesAPendingRequestWithTheCurrentStatus() throws Exception {
        bridge.callAsync(9, "requestPermission", "{}");
        Fixtures.idle();
        assertEquals(1, bridge.pendingCalls());
        bridge.onDestroy();
        JSONObject s = page.resolved(9);
        assertNotNull("a promessa da página não pode ficar pendurada", s);
        assertEquals("denied", s.get("permission"));
        assertEquals(0, bridge.pendingCalls());
    }

    @Test
    public void resultForAnUnknownRequestIsIgnored() throws Exception {
        page.clear();
        bridge.onPermissionsResult(999, BOTH, GRANTED);
        Fixtures.idle();
        assertTrue(page.events("status").isEmpty());
    }

    @Test
    public void statusEventOnResumeAndOnSystemBroadcasts() throws Exception {
        bridge.onStart();
        Fixtures.idle();
        page.clear();
        bridge.onResume();
        assertEquals(1, page.events("status").size());

        // Wi-Fi desligado pelo usuário.
        page.clear();
        Fixtures.wifiManager().setWifiEnabled(false);
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        Fixtures.idle();
        assertEquals(false, page.lastEvent("status").get("wifiEnabled"));

        // Aviso repetido sem mudança: nada de evento.
        page.clear();
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        Fixtures.idle();
        assertTrue(page.events("status").isEmpty());

        // Localização desligada.
        Fixtures.setLocationEnabled(false);
        activity.sendBroadcast(new Intent(LocationManager.MODE_CHANGED_ACTION));
        Fixtures.idle();
        assertEquals(false, page.lastEvent("status").get("locationEnabled"));

        page.clear();
        Fixtures.setLocationEnabled(true);
        activity.sendBroadcast(new Intent(LocationManager.PROVIDERS_CHANGED_ACTION));
        Fixtures.idle();
        assertEquals(true, page.lastEvent("status").get("locationEnabled"));

        // Fora da tela (onStop) ninguém escuta mais.
        bridge.onStop();
        page.clear();
        Fixtures.wifiManager().setWifiEnabled(true);
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        Fixtures.idle();
        assertTrue(page.events("status").isEmpty());
        assertFalse(page.scripts().toString().contains("status"));
    }
}
