package com.wifiraiox.app;

import android.net.MacAddress;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiSsid;

import androidx.annotation.RequiresApi;

import org.json.JSONObject;

import java.util.Locale;

/** Só Android 13 (API 33) em diante. */
@RequiresApi(33)
final class Api33 {

    private Api33() {}

    /** Nome pelos bytes crus (ScanResult.SSID foi aposentado no 33). null = o aparelho não informou. */
    static String ssid(ScanResult r) {
        try {
            WifiSsid ssid = r.getWifiSsid();
            return ssid == null ? null : WifiText.fromBytes(ssid.getBytes());
        } catch (RuntimeException e) {
            return null;
        }
    }

    static void scanExtras(ScanResult r, JSONObject o) {
        try {
            MacAddress mld = r.getApMldMacAddress();
            if (mld != null) Json.put(o, "mld", mld.toString().toLowerCase(Locale.ROOT));
        } catch (RuntimeException ignored) {
            // campo opcional
        }
    }
}
