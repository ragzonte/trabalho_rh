package com.wifiraiox.app;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.os.Build;

import org.json.JSONObject;

/** Monta o Status do contrato: o que falta para o Android entregar a lista de redes. */
final class StatusReader {

    private final Context context;
    private final Permissions permissions;

    StatusReader(Context context, Permissions permissions) {
        this.context = context.getApplicationContext();
        this.permissions = permissions;
    }

    JSONObject read() {
        WifiManager wifi = Sys.wifi(context);
        boolean wifiEnabled = false;
        Object throttled = JSONObject.NULL; // antes do Android 11 o limite não pode ser consultado
        try {
            wifiEnabled = wifi != null && wifi.isWifiEnabled();
            if (wifi != null && Build.VERSION.SDK_INT >= 30) throttled = Api30.scanThrottleEnabled(wifi);
        } catch (RuntimeException ignored) {
            // serviço de Wi-Fi indisponível: segue como desligado
        }
        boolean locationEnabled = Sys.locationEnabled(context);
        String permission = permissions.locationState();

        JSONObject o = new JSONObject();
        Json.put(o, "wifiEnabled", wifiEnabled);
        Json.put(o, "locationEnabled", locationEnabled);
        Json.put(o, "permission", permission);
        Json.put(o, "throttled", throttled);
        Json.put(o, "canScan", wifiEnabled && locationEnabled && Permissions.GRANTED.equals(permission));
        return o;
    }
}
