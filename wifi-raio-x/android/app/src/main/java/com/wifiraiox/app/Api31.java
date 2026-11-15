package com.wifiraiox.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Vibrator;
import android.os.VibratorManager;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;

/** Só Android 12 (API 31) em diante. */
@RequiresApi(31)
final class Api31 {

    private Api31() {}

    static boolean is60GHzSupported(WifiManager wifi) {
        return wifi.is60GHzBandSupported();
    }

    static int securityType(WifiInfo info) {
        return info.getCurrentSecurityType();
    }

    static Vibrator vibrator(Context context) {
        VibratorManager manager = (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
        return manager == null ? null : manager.getDefaultVibrator();
    }

    /**
     * Do Android 12 em diante o nome e o BSSID da rede só chegam inteiros num callback criado com
     * FLAG_INCLUDE_LOCATION_INFO; sem ela vêm apagados mesmo com a permissão concedida.
     */
    static ConnectivityManager.NetworkCallback locationAwareCallback(final ConnectionTracker.NetEvents events) {
        return new ConnectivityManager.NetworkCallback(ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO) {
            @Override
            public void onAvailable(@NonNull Network network) {
                events.available(network);
            }

            @Override
            public void onLost(@NonNull Network network) {
                events.lost(network);
            }

            @Override
            public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities caps) {
                events.capabilities(network, caps);
            }

            @Override
            public void onLinkPropertiesChanged(@NonNull Network network, @NonNull LinkProperties link) {
                events.link(network, link);
            }
        };
    }
}
