package com.wifiraiox.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.location.LocationManager;
import android.net.wifi.WifiManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

/** Avisa quando o Wi-Fi ou a Localização são ligados/desligados: o Status da página pode ter mudado. */
final class StatusWatcher {

    private final Context context;
    private final Runnable onChange;
    private BroadcastReceiver receiver;

    StatusWatcher(Context context, Runnable onChange) {
        this.context = context.getApplicationContext();
        this.onChange = onChange;
    }

    /** onStart. */
    void start() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                try {
                    onChange.run();
                } catch (RuntimeException e) {
                    Log.w("WifiRaioX", "falha ao reler o estado", e); // exceção num receiver derruba o app
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiManager.WIFI_STATE_CHANGED_ACTION);
        filter.addAction(LocationManager.MODE_CHANGED_ACTION);
        filter.addAction(LocationManager.PROVIDERS_CHANGED_ACTION);
        // Só avisos protegidos do sistema; EXPORTED é o que a documentação pede para eles.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED);
    }

    /** onStop. */
    void stop() {
        if (receiver == null) return;
        try {
            context.unregisterReceiver(receiver);
        } catch (RuntimeException ignored) {
            // já removido
        }
        receiver = null;
    }

    boolean watching() {
        return receiver != null;
    }
}
