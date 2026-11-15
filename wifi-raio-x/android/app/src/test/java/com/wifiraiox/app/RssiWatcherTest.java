package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.net.wifi.WifiInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/** watchRssi: amostras periódicas só com a tela em primeiro plano. */
public class RssiWatcherTest extends AllSdks {

    private Fixtures.Page page;
    private Bridge bridge;

    @Before
    public void setUp() {
        Activity activity = Fixtures.activity();
        page = new Fixtures.Page();
        bridge = Fixtures.bridge(activity, page);
        Fixtures.grantLocation();
        WifiInfo info = Fixtures.wifiInfo("Casa", "A4:91:B1:00:11:22", -52, 433, 5180);
        if (Build.VERSION.SDK_INT >= 29) {
            ReflectionHelpers.callInstanceMethod(info, "setTxLinkSpeedMbps", ClassParameter.from(int.class, 866));
            ReflectionHelpers.callInstanceMethod(info, "setRxLinkSpeedMbps", ClassParameter.from(int.class, 780));
        }
        Fixtures.wifi().setConnectionInfo(info);
    }

    private void advance(long ms) {
        ShadowLooper.idleMainLooper(ms, TimeUnit.MILLISECONDS);
    }

    @Test
    public void sampleShapeMatchesTheContract() throws Exception {
        bridge.onResume();
        assertEquals("{\"ok\":true}", bridge.call("watchRssi", "{\"intervalMs\":1000}"));
        advance(0);
        JSONObject s = page.lastEvent("rssi");
        assertEquals(-52, s.get("rssi"));
        assertEquals("a4:91:b1:00:11:22", s.get("bssid"));
        assertEquals(5180, s.get("frequency"));
        assertEquals(433, s.get("linkSpeed"));
        assertTrue(s.getLong("ts") > 0);
        Set<String> expected = new HashSet<>(Arrays.asList("ts", "rssi", "bssid", "frequency", "linkSpeed"));
        if (Build.VERSION.SDK_INT >= 29) {
            expected.addAll(Arrays.asList("txSpeed", "rxSpeed"));
            assertEquals(866, s.get("txSpeed"));
            assertEquals(780, s.get("rxSpeed"));
        }
        assertEquals(expected, Fixtures.keys(s));
    }

    @Test
    public void emitsAtTheRequestedIntervalWhileResumed() throws Exception {
        bridge.onResume();
        bridge.call("watchRssi", "{\"intervalMs\":500}");
        advance(0);
        assertEquals("a primeira amostra sai logo", 1, page.events("rssi").size());
        advance(1600);
        assertEquals(4, page.events("rssi").size());

        bridge.onPause();
        advance(3000);
        assertEquals("pausado: nada", 4, page.events("rssi").size());

        bridge.onResume();
        advance(0);
        assertEquals("voltou: retoma", 5, page.events("rssi").size());

        assertEquals("{\"ok\":true}", bridge.call("unwatchRssi", "{}"));
        advance(3000);
        assertEquals(5, page.events("rssi").size());
    }

    @Test
    public void watchWhilePausedStartsOnResume() throws Exception {
        bridge.call("watchRssi", "{}");
        advance(5000);
        assertTrue(page.events("rssi").isEmpty());
        bridge.onResume();
        advance(0);
        assertEquals(1, page.events("rssi").size());
        advance(1000); // intervalo padrão: 1 s
        assertEquals(2, page.events("rssi").size());
    }

    @Test
    public void intervalIsClamped() throws Exception {
        assertEquals(250, RssiWatcher.clampInterval(1));
        assertEquals(250, RssiWatcher.clampInterval(-5000));
        assertEquals(60_000, RssiWatcher.clampInterval(1e12));
        assertEquals(1000, RssiWatcher.clampInterval(Double.NaN));
        assertEquals(750, RssiWatcher.clampInterval(750.2));

        bridge.onResume();
        bridge.call("watchRssi", "{\"intervalMs\":1}");
        advance(0);
        advance(1000);
        assertEquals("1 ms vira 250 ms: 5 amostras em 1 s, não mil", 5, page.events("rssi").size());
    }

    @Test
    public void noSignalNoSample() throws Exception {
        Fixtures.wifi().setConnectionInfo(org.robolectric.shadows.ShadowWifiInfo.newInstance());
        bridge.onResume();
        bridge.call("watchRssi", "{\"intervalMs\":250}");
        advance(2000);
        assertTrue(page.events("rssi").isEmpty());
    }

    @Test
    public void redactedBssidBecomesEmptyString() throws Exception {
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo(null, "02:00:00:00:00:00", -60, 100, 2412));
        bridge.onResume();
        bridge.call("watchRssi", "{}");
        advance(0);
        JSONObject s = page.lastEvent("rssi");
        assertEquals("", s.get("bssid"));
        assertEquals(-60, s.get("rssi"));
    }

    @Test
    public void destroyStopsTheTimer() throws Exception {
        bridge.onResume();
        bridge.call("watchRssi", "{\"intervalMs\":250}");
        advance(0);
        bridge.onDestroy();
        int before = page.events("rssi").size();
        advance(5000);
        assertEquals(before, page.events("rssi").size());
    }

    @Test
    public void badIntervalTypeIsAnError() throws Exception {
        JSONObject r = new JSONObject(bridge.call("watchRssi", "{\"intervalMs\":\"rápido\"}"));
        assertTrue(r.has("error"));
        assertFalse(r.has("ok"));
    }

    @Test
    public void watcherAloneFollowsWatchAndResumeFlags() {
        final int[] count = {0};
        RssiWatcher w = new RssiWatcher(new Handler(Looper.getMainLooper()), JSONObject::new, s -> count[0]++);
        w.watch(300);
        w.setResumed(true);
        advance(650);
        assertEquals(3, count[0]);
        assertTrue(w.ticking());
        w.setResumed(false);
        assertFalse(w.ticking());
        List<Integer> none = Arrays.asList();
        assertTrue(none.isEmpty());
    }
}
