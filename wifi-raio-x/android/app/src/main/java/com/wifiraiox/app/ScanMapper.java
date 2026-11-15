package com.wifiraiox.app;

import android.net.wifi.ScanResult;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Converte ScanResult em ScanAp (contrato em app/js/bridge.js), sem interpretar nada. */
final class ScanMapper {

    /** Teto defensivo: uma lista maior que isto só pode ser erro do aparelho e travaria a página. */
    static final int MAX_APS = 400;

    private ScanMapper() {}

    static JSONArray list(List<ScanResult> results, long nowElapsedMs) {
        JSONArray out = new JSONArray();
        if (results == null) return out;
        List<ScanResult> src = results;
        if (src.size() > MAX_APS) {
            // ficam as mais fortes
            src = new ArrayList<>(results);
            Collections.sort(src, (a, b) -> Integer.compare(b == null ? Integer.MIN_VALUE : b.level,
                    a == null ? Integer.MIN_VALUE : a.level));
            src = src.subList(0, MAX_APS);
        }
        for (ScanResult r : src) {
            try {
                JSONObject ap = one(r, nowElapsedMs);
                if (ap != null) out.put(ap);
            } catch (RuntimeException | JSONException e) {
                // um resultado estragado não pode derrubar a lista inteira
            }
        }
        return out;
    }

    static JSONObject one(ScanResult r, long nowElapsedMs) throws JSONException {
        if (r == null || r.BSSID == null || r.BSSID.isEmpty()) return null;
        JSONObject o = new JSONObject();
        o.put("bssid", r.BSSID.toLowerCase(Locale.ROOT));
        o.put("ssid", ssid(r));
        o.put("level", r.level);
        o.put("frequency", r.frequency);
        o.put("channelWidth", r.channelWidth);
        o.put("centerFreq0", r.centerFreq0);
        o.put("centerFreq1", r.centerFreq1);
        o.put("capabilities", r.capabilities == null ? "" : r.capabilities);
        o.put("ageMs", ageMs(r.timestamp, nowElapsedMs));
        o.put("rttResponder", r.is80211mcResponder());
        o.put("passpoint", r.isPasspointNetwork());
        text(o, "venueName", r.venueName);
        text(o, "operatorName", r.operatorFriendlyName);
        if (Build.VERSION.SDK_INT >= 30) Api30.scanExtras(r, o);
        if (Build.VERSION.SDK_INT >= 33) Api33.scanExtras(r, o);
        return o;
    }

    /** Nome da rede: "" quando oculta. */
    static String ssid(ScanResult r) {
        String s = null;
        if (Build.VERSION.SDK_INT >= 33) s = Api33.ssid(r);
        if (s == null) s = WifiText.scanSsid(r.SSID);
        // O Android antigo desiste de nomes que não são UTF-8; o beacon cru ainda tem os bytes.
        if (s == null && Build.VERSION.SDK_INT >= 30) s = Api30.ssidFromElements(r);
        return s == null ? "" : s;
    }

    /** ScanResult.timestamp vem em microssegundos desde o boot; valores absurdos são contidos em [0, agora]. */
    static long ageMs(long timestampMicros, long nowElapsedMs) {
        long now = Math.max(0, nowElapsedMs);
        if (timestampMicros <= 0) return now;
        long age = now - timestampMicros / 1000;
        if (age < 0) return 0;
        return Math.min(age, now);
    }

    private static void text(JSONObject o, String key, CharSequence value) throws JSONException {
        if (value == null) return;
        String s = value.toString().trim();
        if (!s.isEmpty()) o.put(key, s);
    }
}
