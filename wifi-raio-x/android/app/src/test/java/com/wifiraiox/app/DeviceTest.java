package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.ShadowVibrator;

import java.util.List;

/** O que mexe no aparelho: telas de configuração, tela ligada, vibração e cor das barras. */
public class DeviceTest extends AllSdks {

    private Activity activity;
    private Bridge bridge;

    @Before
    public void setUp() {
        activity = Fixtures.activity();
        bridge = Fixtures.bridge(activity, new Fixtures.Page());
    }

    private JSONObject call(String method, String args) throws Exception {
        return new JSONObject(bridge.call(method, args));
    }

    private Intent nextStarted() {
        return shadowOf(activity).getNextStartedActivity();
    }

    // ------------------------------------------------------------ openSettings

    @Test
    public void eachSettingsScreenOpensTheExpectedAction() throws Exception {
        String[][] table = {
            {"wifi", Settings.ACTION_WIFI_SETTINGS},
            {"location", Settings.ACTION_LOCATION_SOURCE_SETTINGS},
            {"app", Settings.ACTION_APPLICATION_DETAILS_SETTINGS},
            {"developer", Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS},
            {"panel", Build.VERSION.SDK_INT >= 29 ? "android.settings.panel.action.WIFI" : Settings.ACTION_WIFI_SETTINGS},
        };
        for (String[] row : table) {
            JSONObject r = call("openSettings", "{\"which\":\"" + row[0] + "\"}");
            assertEquals(row[0], true, r.get("ok"));
            Intent started = nextStarted();
            assertNotNull(row[0], started);
            assertEquals(row[0], row[1], started.getAction());
            if (row[0].equals("app")) assertEquals("package:com.wifiraiox.app", started.getDataString());
            assertNull("uma tela só por pedido", nextStarted());
        }
    }

    @Test
    public void unknownSettingsScreenIsAnError() throws Exception {
        for (String args : new String[] {"{}", "{\"which\":\"bluetooth\"}", "{\"which\":5}", "{\"which\":null}", "{\"which\":\"\"}"}) {
            assertTrue(args, call("openSettings", args).has("error"));
        }
        assertNull(nextStarted());
    }

    private void onlyThisScreenExists(String action) {
        shadowOf(Fixtures.app()).checkActivities(true); // telas inexistentes passam a lançar ActivityNotFoundException
        ResolveInfo info = new ResolveInfo();
        info.activityInfo = new ActivityInfo();
        info.activityInfo.packageName = "com.android.settings";
        info.activityInfo.name = "com.android.settings.Settings";
        info.activityInfo.exported = true;
        shadowOf(activity.getPackageManager()).addResolveInfoForIntent(new Intent(action), info);
    }

    @Test
    public void missingScreenFallsBackToGeneralSettings() throws Exception {
        onlyThisScreenExists(Settings.ACTION_SETTINGS);
        for (String which : new String[] {"developer", "panel", "wifi", "location", "app"}) {
            assertEquals(which, true, call("openSettings", "{\"which\":\"" + which + "\"}").get("ok"));
            assertEquals(which, Settings.ACTION_SETTINGS, nextStarted().getAction());
        }
    }

    @Test
    public void panelFallsBackToWifiSettings() throws Exception {
        onlyThisScreenExists(Settings.ACTION_WIFI_SETTINGS);
        assertEquals(true, call("openSettings", "{\"which\":\"panel\"}").get("ok"));
        assertEquals(Settings.ACTION_WIFI_SETTINGS, nextStarted().getAction());
    }

    @Test
    public void noSettingsAppAtAllGivesOkFalse() throws Exception {
        shadowOf(Fixtures.app()).checkActivities(true);
        for (String which : new String[] {"wifi", "location", "app", "developer", "panel"}) {
            assertEquals(which, false, call("openSettings", "{\"which\":\"" + which + "\"}").get("ok"));
        }
        assertNull(nextStarted());
    }

    @Test
    public void candidateListsEndWithGeneralSettings() {
        for (String which : new String[] {"wifi", "location", "app", "developer", "panel"}) {
            List<Intent> c = SettingsOpener.candidates(activity, which);
            assertTrue(which, c.size() >= 2);
            assertEquals(Settings.ACTION_SETTINGS, c.get(c.size() - 1).getAction());
        }
        assertTrue(SettingsOpener.candidates(activity, "x").isEmpty());
        assertTrue(SettingsOpener.candidates(activity, null).isEmpty());
        assertFalse(SettingsOpener.open(activity, "x"));
    }

    // ------------------------------------------------------------ keepAwake

    @Test
    public void keepAwakeTogglesTheWindowFlag() throws Exception {
        Window window = activity.getWindow();
        assertEquals(0, window.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        assertEquals(true, call("keepAwake", "{\"on\":true}").get("ok"));
        assertTrue((window.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0);
        assertEquals(true, call("keepAwake", "{\"on\":false}").get("ok"));
        assertEquals(0, window.getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        for (String args : new String[] {"{}", "{\"on\":\"sim\"}", "{\"on\":1}"}) {
            assertTrue(args, call("keepAwake", args).has("error"));
        }
    }

    @Test
    public void keepAwakeFromTheBridgeThreadIsAppliedOnTheUiThread() throws Exception {
        final String[] answer = new String[1];
        Thread worker = new Thread(() -> answer[0] = bridge.call("keepAwake", "{\"on\":true}"));
        worker.start();
        worker.join(5000);
        assertEquals("responde sem esperar a interface", "{\"ok\":true}", answer[0]);
        assertEquals("a janela só muda na thread da interface", 0,
                activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Fixtures.idle();
        assertTrue((activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) != 0);
    }

    // ------------------------------------------------------------ vibrate

    private ShadowVibrator vibrator() {
        Vibrator v;
        if (Build.VERSION.SDK_INT >= 31) {
            v = Api31.vibrator(Fixtures.app());
        } else {
            v = (Vibrator) Fixtures.app().getSystemService(Context.VIBRATOR_SERVICE);
        }
        return shadowOf(v);
    }

    @Test
    public void vibrateUsesTheApiOfEachAndroidVersion() throws Exception {
        assertEquals(true, call("vibrate", "{\"ms\":35}").get("ok"));
        assertTrue(vibrator().isVibrating());
        assertEquals(35, vibrator().getMilliseconds());
    }

    @Test
    public void vibrateClampsTheDuration() throws Exception {
        call("vibrate", "{\"ms\":60000}");
        assertEquals(500, vibrator().getMilliseconds());
        call("vibrate", "{\"ms\":0}");
        assertEquals(1, vibrator().getMilliseconds());
        call("vibrate", "{\"ms\":-40}");
        assertEquals(1, vibrator().getMilliseconds());
        call("vibrate", "{}");
        assertEquals("padrão do contrato", 20, vibrator().getMilliseconds());
        assertTrue(call("vibrate", "{\"ms\":\"forte\"}").has("error"));
    }

    @Test
    public void deviceWithoutVibratorIsIgnored() throws Exception {
        vibrator().setHasVibrator(false);
        assertEquals(true, call("vibrate", "{\"ms\":35}").get("ok"));
        assertFalse(vibrator().isVibrating());
    }

    // ------------------------------------------------------------ setBars

    @Test
    public void colourParsing() {
        assertEquals(Integer.valueOf(0xFF0B1220), SystemBars.parseColor("#0B1220"));
        assertEquals(Integer.valueOf(0xFFFFFFFF), SystemBars.parseColor("#ffffff"));
        assertEquals(Integer.valueOf(0xFFAABBCC), SystemBars.parseColor("#abc"));
        assertEquals(Integer.valueOf(0xFF000000), SystemBars.parseColor(" #000 "));
        for (String bad : new String[] {null, "", "#", "0B1220", "#0B122", "#0B12200", "#GGGGGG", "red", "rgb(1,2,3)",
                "#80FFFFFF", "#-12345", "#+12345", "# 12345"}) {
            assertNull(String.valueOf(bad), SystemBars.parseColor(bad));
        }
    }

    @Test
    @SuppressWarnings("deprecation")
    public void darkThemePaintsBarsAndKeepsLightIcons() throws Exception {
        assertEquals(true, call("setBars", "{\"color\":\"#0B1220\",\"dark\":true}").get("ok"));
        Window window = activity.getWindow();
        assertEquals(0xFF0B1220, window.getStatusBarColor());
        assertEquals(0xFF0B1220, window.getNavigationBarColor());
        assertTrue(window.getDecorView().getBackground() instanceof ColorDrawable);
        assertEquals(0xFF0B1220, ((ColorDrawable) window.getDecorView().getBackground()).getColor());
        if (Build.VERSION.SDK_INT < 30) {
            int ui = window.getDecorView().getSystemUiVisibility();
            assertEquals(0, ui & View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            if (Build.VERSION.SDK_INT >= 26) assertEquals(0, ui & View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    @Test
    @SuppressWarnings("deprecation")
    public void lightThemeAsksForDarkIconsWhereTheVersionCan() throws Exception {
        assertEquals(true, call("setBars", "{\"color\":\"#F4F6FA\",\"dark\":false}").get("ok"));
        Window window = activity.getWindow();
        assertEquals(0xFFF4F6FA, window.getStatusBarColor());
        if (Build.VERSION.SDK_INT >= 26) {
            assertEquals(0xFFF4F6FA, window.getNavigationBarColor());
        } else {
            assertEquals("Android 7: botões brancos fixos, a barra de navegação fica preta", Color.BLACK, window.getNavigationBarColor());
        }
        if (Build.VERSION.SDK_INT < 30) {
            int ui = window.getDecorView().getSystemUiVisibility();
            assertTrue((ui & View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) != 0);
            if (Build.VERSION.SDK_INT >= 26) assertTrue((ui & View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR) != 0);
        }
        // e de volta ao escuro
        call("setBars", "{\"color\":\"#000000\",\"dark\":true}");
        assertEquals(0xFF000000, window.getStatusBarColor());
        if (Build.VERSION.SDK_INT < 30) {
            assertEquals(0, window.getDecorView().getSystemUiVisibility() & View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    @Test
    public void badColourIsAnErrorAndChangesNothing() throws Exception {
        int before = activity.getWindow().getStatusBarColor();
        for (String args : new String[] {"{}", "{\"color\":\"azul\"}", "{\"color\":123456}", "{\"color\":\"#12345\",\"dark\":true}"}) {
            assertTrue(args, call("setBars", args).has("error"));
        }
        assertEquals(before, activity.getWindow().getStatusBarColor());
        // "dark" ausente ou torto: vale false, sem erro
        assertEquals(true, call("setBars", "{\"color\":\"#ffffff\",\"dark\":\"x\"}").get("ok"));
        assertEquals(0xFFFFFFFF, activity.getWindow().getStatusBarColor());
    }
}
