package com.wifiraiox.app;

import android.content.Context;
import android.net.MacAddress;
import android.net.wifi.ScanResult;
import android.net.wifi.rtt.RangingRequest;
import android.net.wifi.rtt.RangingResult;
import android.net.wifi.rtt.RangingResultCallback;
import android.net.wifi.rtt.WifiRttManager;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Só Android 9 (API 28) em diante: Wi-Fi RTT (medição de distância até roteadores 802.11mc). */
@RequiresApi(28)
final class Api28 {

    interface RangingSink {
        /** bssid (minúsculo) -> RttResult. Pontos de acesso que não vieram na resposta ficam de fora. */
        void onResults(Map<String, JSONObject> byBssid);
    }

    private Api28() {}

    static int maxPeers() {
        return RangingRequest.getMaxPeers();
    }

    /**
     * Dispara a medição. As respostas chegam na thread da interface. Lança SecurityException sem a
     * permissão de localização; devolve false quando o RTT está indisponível (modo avião, Localização desligada).
     */
    static boolean range(Context context, List<ScanResult> targets, final RangingSink sink) throws SecurityException {
        WifiRttManager rtt = (WifiRttManager) context.getSystemService(Context.WIFI_RTT_RANGING_SERVICE);
        if (rtt == null || !rtt.isAvailable()) return false;
        RangingRequest request = new RangingRequest.Builder().addAccessPoints(targets).build();
        rtt.startRanging(request, context.getMainExecutor(), new RangingResultCallback() {
            @Override
            public void onRangingFailure(int code) {
                sink.onResults(new HashMap<>());
            }

            @Override
            public void onRangingResults(@NonNull List<RangingResult> results) {
                Map<String, JSONObject> out = new HashMap<>();
                for (RangingResult r : results) {
                    JSONObject o = toJson(r);
                    if (o != null) out.put(o.optString("bssid"), o);
                }
                sink.onResults(out);
            }
        });
        return true;
    }

    /** Os getters de medida lançam IllegalStateException quando o status não é SUCCESS: só lê depois de conferir. */
    static JSONObject toJson(RangingResult r) {
        try {
            MacAddress mac = r == null ? null : r.getMacAddress();
            if (mac == null) return null;
            JSONObject o = new JSONObject();
            Json.put(o, "bssid", mac.toString().toLowerCase(Locale.ROOT));
            boolean ok = r.getStatus() == RangingResult.STATUS_SUCCESS;
            Json.put(o, "ok", ok);
            if (ok) {
                Json.put(o, "distM", r.getDistanceMm() / 1000.0);
                Json.put(o, "stdM", r.getDistanceStdDevMm() / 1000.0);
                Json.put(o, "rssi", r.getRssi());
                Json.put(o, "attempts", r.getNumAttemptedMeasurements());
                Json.put(o, "successes", r.getNumSuccessfulMeasurements());
            }
            return o;
        } catch (RuntimeException e) {
            return null;
        }
    }
}
