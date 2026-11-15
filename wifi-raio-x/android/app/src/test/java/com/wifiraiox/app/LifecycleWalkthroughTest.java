package com.wifiraiox.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.WebView;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.shadows.ShadowSystemClock;
import org.robolectric.shadows.ShadowWifiInfo;
import org.robolectric.util.ReflectionHelpers;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Roteiros de uso do começo ao fim, na tela de verdade (MainActivity + ponte de verdade), em cada
 * versão do Android: o que acontece com permissões, rotação, saída do app, Wi-Fi desligado no meio
 * do caminho e aparelhos sem Wi-Fi. Cada resposta e evento que chegaria à página é conferido.
 */
@Config(shadows = RecordingWebView.class)
public class LifecycleWalkthroughTest extends AllSdks {

    private static final String[] BOTH = {Fixtures.FINE, Fixtures.COARSE};
    private static final int[] GRANTED = {PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_GRANTED};
    private static final int[] DENIED = {PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_DENIED};

    private ActivityController<MainActivity> controller;
    private MainActivity activity;
    private int receiversBefore;
    private int callbacksBefore;

    @Before
    public void setUp() {
        RecordingWebView.page = new Fixtures.Page();
        ShadowSystemClock.advanceBy(1, TimeUnit.HOURS); // um celular ligado há algum tempo
        Fixtures.denyLocation();
        receiversBefore = ourReceivers().size();
        callbacksBefore = Fixtures.shadowConnectivity().getNetworkCallbacks().size();
    }

    // ------------------------------------------------------------ apoio

    private static Fixtures.Page page() {
        return RecordingWebView.page;
    }

    private static List<BroadcastReceiver> ourReceivers() {
        List<BroadcastReceiver> out = new ArrayList<>();
        for (ShadowApplication.Wrapper w : shadowOf(Fixtures.app()).getRegisteredReceivers()) {
            if (w.broadcastReceiver.getClass().getName().startsWith("com.wifiraiox.app.")) out.add(w.broadcastReceiver);
        }
        return out;
    }

    private MainActivity launch() {
        controller = Robolectric.buildActivity(MainActivity.class).setup();
        activity = controller.get();
        return activity;
    }

    /** Volta para a frente depois de um onStop, como o Android faz: onRestart, onStart, onResume. */
    private void comeBack() {
        controller.restart().resume();
    }

    private void rationale(boolean show) {
        shadowOf(activity.getPackageManager()).setShouldShowRequestPermissionRationale(Fixtures.FINE, show);
    }

    /** O usuário responde ao diálogo: o Android encerra o pedido em aberto da Activity e entrega o resultado. */
    private void dialogAnswered(int requestCode, String[] names, int[] results, long afterMs) {
        ShadowSystemClock.advanceBy(afterMs, TimeUnit.MILLISECONDS);
        ReflectionHelpers.setField(Activity.class, activity, "mHasCurrentPermissionsRequest", false);
        activity.onRequestPermissionsResult(requestCode, names, results);
        Fixtures.idle();
    }

    private JSONObject call(String method, String args) throws Exception {
        return new JSONObject(activity.bridge().call(method, args));
    }

    /** Chamada assíncrona cuja resposta sai sem esperar thread de trabalho. */
    private JSONObject async(int id, String method, String args) throws Exception {
        activity.bridge().callAsync(id, method, args);
        Fixtures.idle();
        return page().resolved(id);
    }

    /** Resposta que vem de uma thread de trabalho e ainda passa pela fila da thread da interface. */
    private JSONObject awaitResolved(int id) throws Exception {
        for (int i = 0; i < 500; i++) {
            Fixtures.idle();
            JSONObject r = page().resolved(id);
            if (r != null) return r;
            Thread.sleep(20);
        }
        throw new AssertionError("sem resposta para o id " + id);
    }

    private JSONObject awaitEvent(String name) throws Exception {
        for (int i = 0; i < 500; i++) {
            Fixtures.idle();
            JSONObject e = page().lastEvent(name);
            if (e != null) return e;
            Thread.sleep(20);
        }
        throw new AssertionError("o evento " + name + " não chegou");
    }

    /** O Android termina a varredura: a lista passa a existir e o aviso chega. Devolve o evento 'scan' entregue. */
    private JSONObject scanFinishes(List<ScanResult> results) throws Exception {
        int before = page().events("scan").size();
        Fixtures.wifi().setScanResults(results);
        Intent done = new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
        done.putExtra(WifiManager.EXTRA_RESULTS_UPDATED, true);
        activity.sendBroadcast(done);
        JSONObject event = awaitEvent("scan");
        assertEquals("um aviso, um evento", before + 1, page().events("scan").size());
        return event;
    }

    private static void settle() {
        ShadowLooper.idleMainLooper(1, TimeUnit.SECONDS);
    }

    private static List<ScanResult> twoNetworks() {
        ScanResult a = Fixtures.scanResult("Casa", "AA:AA:AA:AA:AA:01", "[WPA2-PSK-CCMP][ESS]", -48, 2437);
        a.timestamp = (SystemClock.elapsedRealtime() - 700) * 1000;
        ScanResult b = Fixtures.scanResult("", "AA:AA:AA:AA:AA:02", "[ESS]", -80, 5500);
        b.timestamp = (SystemClock.elapsedRealtime() - 900) * 1000;
        return Arrays.asList(a, b);
    }

    private Network connectHomeWifi() throws Exception {
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo("Casa", "A4:91:B1:00:11:22", -52, 433, 5180));
        return Fixtures.wifiNetwork(
                Fixtures.linkProperties("wlan0", new String[] {"192.168.15.37/24"}, "192.168.15.1", "192.168.15.1"),
                NetworkCapabilities.NET_CAPABILITY_INTERNET, NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private void wifiGoesAway(Network network) {
        Fixtures.wifiManager().setWifiEnabled(false);
        Fixtures.wifi().setIsScanAlwaysAvailable(false);
        Fixtures.wifi().setConnectionInfo(ShadowWifiInfo.newInstance());
        Fixtures.noNetworks();
        for (ConnectivityManager.NetworkCallback cb : Fixtures.shadowConnectivity().getNetworkCallbacks()) cb.onLost(network);
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        settle();
    }

    private void assertListening() {
        assertEquals("varredura + estado do Wi-Fi/Localização", receiversBefore + 2, ourReceivers().size());
        assertEquals(callbacksBefore + 1, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
    }

    private void assertNothingRegistered() {
        assertEquals(receiversBefore, ourReceivers().size());
        assertEquals(callbacksBefore, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
    }

    // ------------------------------------------------------------ permissões

    @Test
    public void coldStartWithoutPermissionThenRequestAndGrant() throws Exception {
        launch();
        // a tela nasce avisando o estado; sem permissão não há varredura nem lista
        assertEquals("denied", page().lastEvent("status").get("permission"));
        assertEquals(false, call("status", "{}").get("canScan"));
        assertEquals("no-permission", async(1, "scan", "{}").get("reason"));
        assertEquals(0, call("lastScan", "{}").getJSONArray("aps").length());
        assertListening();

        assertNull("a resposta só vem depois do diálogo", async(2, "requestPermission", "{}"));
        assertArrayEquals(BOTH, shadowOf(activity).getLastRequestedPermission().requestedPermissions);
        controller.pause(); // o diálogo do Android cobre a tela
        assertListening();

        Fixtures.grantLocation();
        page().clear();
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, GRANTED, 3000);
        controller.resume();
        Fixtures.idle();
        JSONObject status = page().resolved(2);
        assertEquals("granted", status.get("permission"));
        assertEquals(true, status.get("canScan"));
        assertEquals("granted", page().lastEvent("status").get("permission"));
        assertEquals(0, activity.bridge().pendingCalls());
        assertListening(); // o callback de rede foi registrado de novo, não duplicado

        assertEquals(true, async(3, "scan", "{}").get("accepted"));
        JSONObject scan = scanFinishes(twoNetworks());
        assertEquals("request", scan.get("source"));
        assertEquals(2, scan.getJSONArray("aps").length());
    }

    @Test
    public void denyTwiceEndsBlockedAndTheSettingsScreenUnblocks() throws Exception {
        launch();
        assertNull(async(1, "requestPermission", "{}"));
        controller.pause();
        rationale(true); // primeira negativa: o Android ainda aceita perguntar de novo
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, DENIED, 3000);
        controller.resume();
        assertEquals("denied", page().resolved(1).get("permission"));

        assertNull(async(2, "requestPermission", "{}"));
        controller.pause();
        rationale(false); // segunda negativa: acabou
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, DENIED, 3000);
        controller.resume();
        assertEquals("blocked", page().resolved(2).get("permission"));
        assertEquals("blocked", page().lastEvent("status").get("permission"));

        // pedir de novo: o Android recusa na hora, sem diálogo; a página recebe a resposta do mesmo jeito
        assertNull(async(3, "requestPermission", "{}"));
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, DENIED, 30);
        assertEquals("blocked", page().resolved(3).get("permission"));
        assertEquals(0, activity.bridge().pendingCalls());

        // a saída é a tela de configurações do app; ao voltar com a permissão, o estado muda sozinho
        assertEquals(true, call("openSettings", "{\"which\":\"app\"}").get("ok"));
        Intent settings = shadowOf(activity).getNextStartedActivity();
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, settings.getAction());
        assertEquals("package:" + activity.getPackageName(), settings.getDataString());
        controller.pause().stop();
        assertNothingRegistered();
        Fixtures.grantLocation();
        page().clear();
        comeBack();
        Fixtures.idle();
        assertEquals("granted", page().lastEvent("status").get("permission"));
        assertEquals(true, page().lastEvent("status").get("canScan"));
        assertListening();

        // e o bloqueio antigo não volta a assombrar se a permissão for retirada depois
        Fixtures.denyLocation();
        assertEquals("denied", call("status", "{}").get("permission"));
    }

    @Test
    public void approximateOnlyGrantKeepsScanningClosedUntilPreciseIsGiven() throws Exception {
        launch();
        assertNull(async(1, "requestPermission", "{}"));
        controller.pause();
        shadowOf(Fixtures.app()).grantPermissions(Fixtures.COARSE); // Android 12+: "Aproximada"
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH,
                new int[] {PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_GRANTED}, 4000);
        controller.resume();
        JSONObject status = page().resolved(1);
        assertEquals("só a precisa libera a varredura", "denied", status.get("permission"));
        assertEquals(false, status.get("canScan"));
        assertEquals("no-permission", async(2, "scan", "{}").get("reason"));

        // pedir de novo mostra o diálogo de "mudar para precisa"
        assertNull(async(3, "requestPermission", "{}"));
        controller.pause();
        Fixtures.grantLocation();
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, GRANTED, 2500);
        controller.resume();
        assertEquals("granted", page().resolved(3).get("permission"));
        assertEquals(true, async(4, "scan", "{}").get("accepted"));
    }

    @Test
    public void permissionRevokedInSettingsRestartsIntoAWorkingScreen() throws Exception {
        Fixtures.grantLocation();
        launch();
        Bridge old = activity.bridge();
        assertEquals("granted", page().lastEvent("status").get("permission"));
        call("watchRssi", "{}");
        call("keepAwake", "{\"on\":true}");

        // o usuário sai, tira a permissão nas configurações; o Android mata o processo e, na volta,
        // recria a tela a partir do estado salvo
        Bundle state = new Bundle();
        controller.pause().saveInstanceState(state).stop().destroy();
        assertTrue(old.isDestroyed());
        assertNothingRegistered();
        Fixtures.denyLocation();
        RecordingWebView.page = new Fixtures.Page();

        controller = Robolectric.buildActivity(MainActivity.class).setup(state);
        activity = controller.get();
        assertEquals(WebClient.START_URL, shadowOf(activity.webView()).getLastLoadedUrl());
        assertEquals("denied", page().lastEvent("status").get("permission"));
        assertEquals("nunca foi negada pelo diálogo: pode pedir", "denied", call("status", "{}").get("permission"));
        assertEquals("no-permission", async(1, "scan", "{}").get("reason"));
        assertNull(async(2, "requestPermission", "{}"));
        assertNotNull(shadowOf(activity).getLastRequestedPermission());
        assertListening();
    }

    @Test
    public void aRequestWhoseAnswerNeverArrivesDoesNotLeaveThePageWaitingForever() throws Exception {
        launch();
        assertNull(async(1, "requestPermission", "{}"));
        // a resposta do pedido se perdeu e a nossa janela continua em foco (não há diálogo por cima)
        ReflectionHelpers.setField(Activity.class, activity, "mHasCurrentPermissionsRequest", false);
        controller.windowFocusChanged(true);
        Fixtures.idle();
        ShadowSystemClock.advanceBy(10, TimeUnit.SECONDS);
        assertTrue(activity.hasWindowFocus());

        // o botão "Permitir" de novo: em vez de pegar carona num diálogo que não existe, pede outra vez
        assertNull(async(2, "requestPermission", "{}"));
        Fixtures.grantLocation();
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, GRANTED, 2000);
        assertEquals("granted", page().resolved(1).get("permission"));
        assertEquals("granted", page().resolved(2).get("permission"));
        assertEquals(0, activity.bridge().pendingCalls());
    }

    @Test
    public void aSecondRequestWhileTheDialogIsStillOpenWaitsForTheSameAnswer() throws Exception {
        launch();
        assertNull(async(1, "requestPermission", "{}"));
        controller.pause();
        controller.windowFocusChanged(false); // o diálogo do Android está com o foco
        Fixtures.idle();
        ShadowSystemClock.advanceBy(60, TimeUnit.SECONDS); // a pessoa demora para responder
        assertFalse(activity.hasWindowFocus());

        assertNull(async(2, "requestPermission", "{}"));
        assertNull("não pede de novo por cima do diálogo aberto", page().resolved(1));
        assertEquals(2, activity.bridge().pendingCalls());

        Fixtures.grantLocation();
        dialogAnswered(Permissions.REQUEST_LOCATION, BOTH, GRANTED, 500);
        assertEquals("granted", page().resolved(1).get("permission"));
        assertEquals("granted", page().resolved(2).get("permission"));
    }

    // ------------------------------------------------------------ tela: rotação, tema, janelas

    @Test
    public void rotatingAndSwitchingDarkModeInTheMiddleOfAScanLosesNothing() throws Exception {
        Fixtures.grantLocation();
        launch();
        WebView web = activity.webView();
        Bridge bridge = activity.bridge();
        List<ScanResult> heard = twoNetworks();
        assertEquals(true, async(1, "scan", "{}").get("accepted"));

        RuntimeEnvironment.setQualifiers("+land");
        controller.configurationChange();
        RuntimeEnvironment.setQualifiers("+night");
        controller.configurationChange();
        RuntimeEnvironment.setQualifiers("+port");
        controller.configurationChange();

        assertSame("a mesma tela", activity, controller.get());
        assertSame("a mesma página", web, activity.webView());
        assertSame(bridge, activity.bridge());
        assertFalse(bridge.isDestroyed());
        assertEquals(0, shadowOf(web).getReloadInvocations());
        assertEquals(WebClient.START_URL, shadowOf(web).getLastLoadedUrl());
        assertListening();

        // a lista pedida antes de girar chega normalmente
        JSONObject scan = scanFinishes(heard);
        assertEquals("request", scan.get("source"));
        assertEquals(true, scan.get("fresh"));
        assertEquals(2, scan.getJSONArray("aps").length());
        long age = scan.getJSONArray("aps").getJSONObject(0).getLong("ageMs");
        assertTrue("idade pelo carimbo do Android (o relógio de teste anda uns ms a cada giro): " + age, age >= 700 && age < 800);
    }

    @Test
    public void splitScreenPausedButVisibleKeepsEverythingRunning() throws Exception {
        Fixtures.grantLocation();
        connectHomeWifi();
        launch();
        WebView web = activity.webView();
        call("watchRssi", "{\"intervalMs\":500}");
        Fixtures.idle();
        assertEquals(1, page().events("rssi").size());

        controller.pause(); // Android 7 a 9: o outro app da tela dividida está com o foco
        assertListening();
        ShadowLooper.idleMainLooper(1000, TimeUnit.MILLISECONDS);
        assertEquals("o sinal continua sendo lido", 3, page().events("rssi").size());
        assertFalse("o WebView só pausa quando a tela some de verdade", shadowOf(web).wasOnPauseCalled());

        RuntimeEnvironment.setQualifiers("+w320dp-h300dp"); // a divisória foi arrastada
        controller.configurationChange();
        assertSame(web, activity.webView());
        assertListening();

        controller.stop(); // agora sim saiu da tela
        assertNothingRegistered();
        int before = page().events("rssi").size();
        ShadowLooper.idleMainLooper(3000, TimeUnit.MILLISECONDS);
        assertEquals(before, page().events("rssi").size());
        assertTrue(shadowOf(web).wasOnPauseCalled());

        comeBack();
        Fixtures.idle();
        assertListening();
        assertEquals("ao voltar, o relógio do sinal retoma", before + 1, page().events("rssi").size());
    }

    @Test
    public void recreationAnswersWhatWasPendingAndStartsAFreshPage() throws Exception {
        launch();
        Bridge old = activity.bridge();
        WebView oldWeb = activity.webView();
        assertNull(async(5, "requestPermission", "{}"));
        call("watchRssi", "{}");

        controller.recreate(); // mudança de configuração que o manifesto não cobre (ex.: troca do papel de parede)
        MainActivity reborn = controller.get();
        assertTrue(reborn != activity);
        assertTrue(old.isDestroyed());
        assertEquals(0, old.pendingCalls());
        assertEquals("a página antiga recebeu a resposta antes de morrer", "denied", page().resolved(5).get("permission"));
        assertTrue(shadowOf(oldWeb).wasDestroyCalled());
        assertFalse(reborn.bridge().isDestroyed());
        assertEquals(WebClient.START_URL, shadowOf(reborn.webView()).getLastLoadedUrl());
        assertListening(); // os registros da tela antiga saíram: não ficaram em dobro
        activity = reborn;
        assertFalse(call("info", "{}").has("error"));
    }

    @Test
    public void destroyedWithCallsPendingAnswersThemAndGoesQuiet() throws Exception {
        Fixtures.grantLocation();
        connectHomeWifi();
        launch();
        Bridge bridge = activity.bridge();
        call("watchRssi", "{\"intervalMs\":250}");
        Fixtures.denyLocation();
        assertNull(async(8, "requestPermission", "{}"));
        assertEquals(1, bridge.pendingCalls());

        controller.destroy(); // o Android pode matar a tela sem passar por pause/stop
        assertEquals(0, bridge.pendingCalls());
        assertEquals("denied", page().resolved(8).get("permission"));
        assertNothingRegistered();
        assertNull(activity.webView());

        // depois disso, nada mais chega (nem o relógio do sinal, nem respostas atrasadas)
        int scripts = page().scripts().size();
        Fixtures.wifiManager().setWifiEnabled(false);
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        bridge.emit("scan", new JSONObject());
        bridge.onPermissionsResult(Permissions.REQUEST_LOCATION, BOTH, DENIED);
        activity.onRequestPermissionsResult(Permissions.REQUEST_LOCATION, BOTH, DENIED);
        ShadowLooper.idleMainLooper(5, TimeUnit.SECONDS);
        assertEquals(scripts, page().scripts().size());
        assertEquals(Bridge.ERR_CLOSED, new JSONObject(bridge.call("info", "{}")).get("error"));
    }

    // ------------------------------------------------------------ Wi-Fi, Localização, modo avião

    @Test
    public void wifiTurnedOffInTheMiddleOfASession() throws Exception {
        Fixtures.grantLocation();
        Network home = connectHomeWifi();
        launch();
        settle();
        assertEquals(true, page().lastEvent("connection").get("connected"));
        assertEquals("Casa", call("connection", "{}").get("ssid"));
        call("watchRssi", "{\"intervalMs\":500}");
        Fixtures.idle();
        assertEquals(-52, page().lastEvent("rssi").get("rssi"));

        page().clear();
        wifiGoesAway(home);
        JSONObject status = page().lastEvent("status");
        assertEquals(false, status.get("wifiEnabled"));
        assertEquals(false, status.get("canScan"));
        assertEquals("granted", status.get("permission"));
        assertEquals(false, page().lastEvent("connection").get("connected"));
        assertEquals(1, call("connection", "{}").length());

        // nada lança e nada inventa dados: cada ferramenta responde que não há Wi-Fi
        page().clear();
        ShadowLooper.idleMainLooper(3, TimeUnit.SECONDS);
        assertTrue("sem sinal não há amostra", page().events("rssi").isEmpty());
        assertEquals("wifi-off", async(1, "scan", "{}").get("reason"));
        activity.bridge().callAsync(2, "lanScan", "{}");
        assertEquals(0, awaitResolved(2).getJSONArray("devices").length());
        activity.bridge().callAsync(3, "speedTest", "{\"mode\":\"light\"}");
        JSONObject speed = awaitResolved(3);
        assertEquals(false, speed.get("ok"));
        assertEquals("offline", speed.get("error"));
        JSONObject rtt = async(4, "rtt", "{\"bssids\":[\"aa:aa:aa:aa:aa:01\"]}");
        assertNotNull(rtt);
        assertTrue(rtt.has("results"));
        assertEquals(0, activity.bridge().pendingCalls());

        // religado: o estado volta sozinho
        Fixtures.wifiManager().setWifiEnabled(true);
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        Fixtures.idle();
        assertEquals(true, page().lastEvent("status").get("canScan"));
    }

    @Test
    public void locationTurnedOffInTheMiddleOfASession() throws Exception {
        Fixtures.grantLocation();
        launch();
        Fixtures.wifi().setScanResults(twoNetworks());
        assertEquals(2, call("lastScan", "{}").getJSONArray("aps").length());

        page().clear();
        Fixtures.setLocationEnabled(false);
        Fixtures.wifi().setScanResults(new ArrayList<>()); // sem Localização o Android devolve lista vazia
        activity.sendBroadcast(new Intent(LocationManager.MODE_CHANGED_ACTION));
        activity.sendBroadcast(new Intent(LocationManager.PROVIDERS_CHANGED_ACTION));
        Fixtures.idle();
        assertEquals("um evento só para os dois avisos", 1, page().events("status").size());
        JSONObject status = page().lastEvent("status");
        assertEquals(false, status.get("locationEnabled"));
        assertEquals(false, status.get("canScan"));
        assertEquals(true, status.get("wifiEnabled"));
        assertEquals("location-off", async(1, "scan", "{}").get("reason"));
        assertEquals(0, call("lastScan", "{}").getJSONArray("aps").length());

        assertEquals(true, call("openSettings", "{\"which\":\"location\"}").get("ok"));
        assertEquals(Settings.ACTION_LOCATION_SOURCE_SETTINGS, shadowOf(activity).getNextStartedActivity().getAction());
        controller.pause().stop();
        Fixtures.setLocationEnabled(true);
        page().clear();
        comeBack();
        Fixtures.idle();
        assertEquals(true, page().lastEvent("status").get("canScan"));
    }

    @Test
    public void airplaneModeAndBack() throws Exception {
        Fixtures.grantLocation();
        Network home = connectHomeWifi();
        launch();
        settle();
        page().clear();

        wifiGoesAway(home); // o modo avião derruba Wi-Fi e dados móveis
        assertEquals(false, page().lastEvent("status").get("wifiEnabled"));
        assertEquals(false, page().lastEvent("connection").get("connected"));
        assertSame("a tela não é recriada", activity, controller.get());
        assertFalse(activity.bridge().isDestroyed());

        // dá para religar só o Wi-Fi com o modo avião ainda ligado
        page().clear();
        Fixtures.wifiManager().setWifiEnabled(true);
        Network again = connectHomeWifi();
        for (ConnectivityManager.NetworkCallback cb : Fixtures.shadowConnectivity().getNetworkCallbacks()) cb.onAvailable(again);
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        settle();
        assertEquals(true, page().lastEvent("status").get("canScan"));
        assertEquals(true, page().lastEvent("connection").get("connected"));
        assertEquals("192.168.15.37", page().lastEvent("connection").get("ip"));
    }

    // ------------------------------------------------------------ aparelhos incomuns

    @Test
    public void deviceWithoutWifiServiceNeverCrashes() throws Exception {
        Fixtures.grantLocation();
        Fixtures.noNetworks();
        shadowOf(Fixtures.app()).removeSystemService(Context.WIFI_SERVICE);
        launch();
        settle();

        JSONObject info = call("info", "{}");
        assertEquals(false, info.getJSONObject("bands").get("b5"));
        assertEquals(0, info.getJSONArray("standards").length());
        JSONObject status = call("status", "{}");
        assertEquals(false, status.get("wifiEnabled"));
        assertEquals(false, status.get("canScan"));
        assertTrue(status.isNull("throttled"));
        assertEquals(0, call("lastScan", "{}").getJSONArray("aps").length());
        assertEquals(false, call("connection", "{}").get("connected"));
        assertEquals("failed", async(1, "scan", "{}").get("reason"));
        assertTrue(async(2, "rtt", "{\"bssids\":[\"aa:aa:aa:aa:aa:01\"]}").has("results"));
        assertEquals(true, call("watchRssi", "{}").get("ok"));
        ShadowLooper.idleMainLooper(3, TimeUnit.SECONDS);
        assertTrue(page().events("rssi").isEmpty());
        activity.bridge().callAsync(3, "lanScan", "{}");
        assertEquals(0, awaitResolved(3).getJSONArray("devices").length());
        activity.bridge().callAsync(4, "speedTest", "{}");
        assertEquals("offline", awaitResolved(4).get("error"));

        activity.sendBroadcast(new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION));
        activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION));
        assertEquals(0, awaitEvent("scan").getJSONArray("aps").length());
        controller.pause().stop().restart().resume().pause().stop().destroy();
        assertNothingRegistered();
    }

    @Test
    public void deviceMissingEverySystemServiceWeUseNeverCrashes() throws Exception {
        Fixtures.grantLocation();
        org.robolectric.shadows.ShadowConnectivityManager connectivity = Fixtures.shadowConnectivity();
        for (String service : new String[] {Context.WIFI_SERVICE, Context.CONNECTIVITY_SERVICE, Context.LOCATION_SERVICE,
                Context.VIBRATOR_SERVICE, "vibrator_manager", "wifirtt"}) {
            shadowOf(Fixtures.app()).removeSystemService(service);
        }
        launch();
        settle();
        for (String method : new String[] {"info", "status", "lastScan", "connection", "unwatchRssi"}) {
            assertFalse(method, call(method, "{}").has("error"));
        }
        assertEquals(false, call("status", "{}").get("locationEnabled"));
        assertEquals(false, call("connection", "{}").get("connected"));
        assertEquals(true, call("vibrate", "{\"ms\":30}").get("ok"));
        assertEquals(true, call("watchRssi", "{}").get("ok"));
        assertEquals(true, call("keepAwake", "{\"on\":true}").get("ok"));
        assertEquals(true, call("setBars", "{\"color\":\"#101820\",\"dark\":true}").get("ok"));
        assertNotNull(async(1, "scan", "{}").get("reason"));
        assertTrue(async(2, "rtt", "{\"bssids\":[\"aa:aa:aa:aa:aa:01\"]}").has("results"));
        activity.bridge().callAsync(3, "lanScan", "{}");
        assertEquals(0, awaitResolved(3).getJSONArray("devices").length());
        activity.bridge().callAsync(4, "speedTest", "{}");
        assertEquals("offline", awaitResolved(4).get("error"));
        ShadowLooper.idleMainLooper(3, TimeUnit.SECONDS);
        assertEquals("sem o serviço de rede não há callback para registrar", callbacksBefore,
                connectivity.getNetworkCallbacks().size());
        controller.pause().stop().restart().resume();
        RuntimeEnvironment.setQualifiers("+land");
        controller.configurationChange();
        controller.pause().stop().destroy();
        assertEquals(receiversBefore, ourReceivers().size());
    }

    @Test
    public void everySdkStartsStopsAndRestartsManyTimesWithoutLeaking() throws Exception {
        Fixtures.grantLocation();
        launch();
        for (int i = 0; i < 5; i++) {
            controller.pause().stop();
            assertNothingRegistered();
            comeBack();
            assertListening();
        }
        // um processo novo por cima do mesmo aparelho: várias telas seguidas não acumulam registros
        for (int i = 0; i < 3; i++) {
            controller.pause().stop().destroy();
            assertNothingRegistered();
            launch();
            assertListening();
        }
        assertEquals(Build.VERSION.SDK_INT, call("info", "{}").get("sdk"));
    }
}
