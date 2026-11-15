package com.wifiraiox.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/** DeviceInfo do contrato: versão do Android, modelo e o que o rádio Wi-Fi deste celular suporta. */
final class DeviceInfoReader {

    private final Context context;

    DeviceInfoReader(Context context) {
        this.context = context.getApplicationContext();
    }

    JSONObject read() {
        WifiManager wifi = Sys.wifi(context);
        JSONObject o = new JSONObject();
        Json.put(o, "platform", "android");
        Json.put(o, "sdk", Build.VERSION.SDK_INT);
        Json.put(o, "release", text(Build.VERSION.RELEASE));
        Json.put(o, "manufacturer", text(Build.MANUFACTURER));
        Json.put(o, "model", text(Build.MODEL));
        Json.put(o, "appVersion", BuildConfig.VERSION_NAME);

        JSONObject bands = new JSONObject();
        Json.put(bands, "b24", true); // não existe celular com Wi-Fi sem 2,4 GHz
        Json.put(bands, "b5", band5(wifi));
        Json.put(bands, "b6", Build.VERSION.SDK_INT >= 30 && band6(wifi));
        Json.put(bands, "b60", Build.VERSION.SDK_INT >= 31 && band60(wifi));
        Json.put(o, "bands", bands);

        JSONArray standards = new JSONArray();
        if (wifi != null && Build.VERSION.SDK_INT >= 30) {
            // Só pergunta pelos padrões que a versão do Android conhece: 11ad entrou no 31 e 11be no 33.
            int[] known = Build.VERSION.SDK_INT >= 33 ? new int[] {1, 4, 5, 6, 7, 8}
                    : Build.VERSION.SDK_INT >= 31 ? new int[] {1, 4, 5, 6, 7}
                    : new int[] {1, 4, 5, 6};
            for (int standard : known) {
                try {
                    if (Api30.standardSupported(wifi, standard)) standards.put(standard);
                } catch (RuntimeException ignored) {
                    // padrão desconhecido para este aparelho
                }
            }
        }
        Json.put(o, "standards", standards);
        Json.put(o, "rtt", rttSupported(context));
        return o;
    }

    /** O celular mede distância por Wi-Fi RTT (802.11mc)? O recurso e a API nasceram no Android 9. */
    static boolean rttSupported(Context context) {
        if (Build.VERSION.SDK_INT < 28) return false;
        try {
            return context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI_RTT);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static boolean band5(WifiManager wifi) {
        try {
            return wifi != null && wifi.is5GHzBandSupported();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static boolean band6(WifiManager wifi) {
        try {
            return wifi != null && Build.VERSION.SDK_INT >= 30 && Api30.is6GHzSupported(wifi);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static boolean band60(WifiManager wifi) {
        try {
            return wifi != null && Build.VERSION.SDK_INT >= 31 && Api31.is60GHzSupported(wifi);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static String text(String s) {
        return s == null ? "" : s;
    }
}
