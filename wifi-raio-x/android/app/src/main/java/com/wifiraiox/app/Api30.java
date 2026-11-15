package com.wifiraiox.app;

import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;

import androidx.annotation.RequiresApi;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.ByteBuffer;

/** Tudo o que só existe do Android 11 (API 30) em diante. Só é carregada em aparelhos que têm essas APIs. */
@RequiresApi(30)
final class Api30 {

    private static final int MAX_ELEMENTS = 128;
    private static final int EID_SSID = 0;

    private Api30() {}

    static void scanExtras(ScanResult r, JSONObject o) {
        try {
            o.put("wifiStandard", r.getWifiStandard());
        } catch (RuntimeException | JSONException ignored) {
            // campo opcional
        }
        try {
            JSONArray ies = new JSONArray();
            for (ScanResult.InformationElement ie : r.getInformationElements()) {
                if (ies.length() >= MAX_ELEMENTS) break;
                byte[] body = body(ie);
                if (body == null) continue;
                JSONObject e = new JSONObject();
                e.put("id", ie.getId());
                e.put("ext", ie.getIdExt());
                e.put("hex", WifiText.hex(body));
                ies.put(e);
            }
            if (ies.length() > 0) o.put("ies", ies);
        } catch (RuntimeException | JSONException ignored) {
            // alguns aparelhos entregam a lista nula por dentro; a rede segue sem os elementos
        }
    }

    /** Nome da rede direto do elemento SSID do beacon, para quando o Android não soube decodificar. */
    static String ssidFromElements(ScanResult r) {
        try {
            for (ScanResult.InformationElement ie : r.getInformationElements()) {
                if (ie != null && ie.getId() == EID_SSID) {
                    byte[] body = body(ie);
                    return body == null ? null : WifiText.fromBytes(body);
                }
            }
        } catch (RuntimeException ignored) {
            // sem elementos, sem nome
        }
        return null;
    }

    /** O buffer do Android é somente leitura (array() lança): copia. */
    private static byte[] body(ScanResult.InformationElement ie) {
        try {
            if (ie == null) return null;
            ByteBuffer buffer = ie.getBytes();
            if (buffer == null) return null;
            byte[] out = new byte[buffer.remaining()];
            buffer.get(out);
            return out;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static boolean scanThrottleEnabled(WifiManager wifi) {
        return wifi.isScanThrottleEnabled();
    }

    static boolean is6GHzSupported(WifiManager wifi) {
        return wifi.is6GHzBandSupported();
    }

    static boolean standardSupported(WifiManager wifi, int standard) {
        return wifi.isWifiStandardSupported(standard);
    }

    static void connectionExtras(WifiInfo info, JSONObject o) {
        int maxTx = info.getMaxSupportedTxLinkSpeedMbps();
        int maxRx = info.getMaxSupportedRxLinkSpeedMbps();
        if (maxTx > 0) Json.put(o, "maxTxSpeed", maxTx);
        if (maxRx > 0) Json.put(o, "maxRxSpeed", maxRx);
        Json.put(o, "wifiStandard", info.getWifiStandard());
    }
}
