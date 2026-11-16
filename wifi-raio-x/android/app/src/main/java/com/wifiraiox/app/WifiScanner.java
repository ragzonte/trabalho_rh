package com.wifiraiox.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

/**
 * Varredura de redes. Pedir uma varredura é só um pedido: o Android pode recusar (limite de 4 a
 * cada 2 minutos) e a lista sempre chega pelo aviso SCAN_RESULTS, venha ele de um pedido nosso
 * ou de uma varredura que o próprio sistema fez.
 */
final class WifiScanner {

    interface Listener {
        void onScan(JSONObject scanEvent);
    }

    /**
     * Um aviso que chega até este tempo depois de um pedido nosso é atribuído ao pedido. Uma varredura
     * completa leva de 2 a 5 s num celular comum, mas passa de 10 s em aparelhos lentos (12,5 s medidos
     * num Android 11 emulado): com uma janela curta a lista pedida pelo app saía rotulada como "do sistema".
     */
    static final long REQUEST_WINDOW_MS = 30_000;

    private final Context context;
    private final Permissions permissions;
    private final Executor worker;
    private final Listener listener;
    private final Object lock = new Object();
    private BroadcastReceiver receiver;
    private long requestedAt = -1; // elapsedRealtime do último startScan() ainda sem aviso; -1 = nenhum
    private long lastFreshAt = -1; // elapsedRealtime da última lista nova lida; -1 = nenhuma ainda

    WifiScanner(Context context, Permissions permissions, Executor worker, Listener listener) {
        this.context = context.getApplicationContext();
        this.permissions = permissions;
        this.worker = worker;
        this.listener = listener;
    }

    /** Começa a ouvir os avisos de lista pronta (chamar em onStart). */
    void start() {
        synchronized (lock) {
            if (receiver != null) return;
            receiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent intent) {
                    if (intent == null || !WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(intent.getAction())) return;
                    // Na ausência do extra (não deveria acontecer do Android 6 em diante), o aviso significa lista nova.
                    onResults(intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, true));
                }
            };
            // Aviso protegido do sistema: EXPORTED é o correto (e obrigatório dizer, mirando o Android 14).
            ContextCompat.registerReceiver(context, receiver,
                    new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), ContextCompat.RECEIVER_EXPORTED);
        }
    }

    /** Para de ouvir (chamar em onStop). */
    void stop() {
        synchronized (lock) {
            if (receiver == null) return;
            try {
                context.unregisterReceiver(receiver);
            } catch (RuntimeException ignored) {
                // já tinha sido removido
            }
            receiver = null;
        }
    }

    boolean listening() {
        synchronized (lock) {
            return receiver != null;
        }
    }

    /** Pede uma varredura nova. Resposta: {accepted, reason?}. A lista chega depois, pelo evento 'scan'. */
    JSONObject request() {
        JSONObject out = new JSONObject();
        String reason = null;
        boolean accepted = false;
        WifiManager wifi = Sys.wifi(context);
        try {
            if (wifi == null) {
                reason = "failed";
            } else if (!permissions.hasFineLocation()) {
                reason = "no-permission";
            } else if (!Sys.locationEnabled(context)) {
                reason = "location-off";
            } else if (!wifi.isWifiEnabled() && !wifi.isScanAlwaysAvailable()) {
                reason = "wifi-off";
            } else {
                synchronized (lock) {
                    requestedAt = SystemClock.elapsedRealtime();
                }
                accepted = startScan(wifi);
                if (!accepted) reason = refusalReason(wifi);
            }
        } catch (SecurityException e) {
            reason = "no-permission";
        } catch (RuntimeException e) {
            reason = "failed";
        }
        Json.put(out, "accepted", accepted);
        if (!accepted) Json.put(out, "reason", reason);
        return out;
    }

    /** startScan() está marcado como obsoleto desde o Android 9, mas não há substituto e continua funcionando. */
    @SuppressWarnings("deprecation")
    private static boolean startScan(WifiManager wifi) {
        return wifi.startScan();
    }

    /** O Android só devolve false; o motivo é deduzido do que dá para observar. */
    private static String refusalReason(WifiManager wifi) {
        if (!wifi.isWifiEnabled()) return "wifi-off";
        if (Build.VERSION.SDK_INT >= 30) return Api30.scanThrottleEnabled(wifi) ? "throttled" : "failed";
        // Android 9 e 10: o limite existe e não pode ser consultado; com o resto em ordem, é a causa provável.
        if (Build.VERSION.SDK_INT >= 28) return "throttled";
        return "failed";
    }

    /** A lista que o Android tem guardada, sem varrer. */
    JSONObject lastScan() {
        return event(false, "cache");
    }

    private void onResults(final boolean fresh) {
        final String source;
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            boolean ours = requestedAt >= 0 && now - requestedAt <= REQUEST_WINDOW_MS;
            requestedAt = -1; // cada pedido responde por um aviso só
            source = ours ? "request" : "system";
        }
        try {
            // Ler e converter centenas de redes fora da thread da interface.
            worker.execute(() -> {
                try {
                    listener.onScan(event(fresh, source));
                } catch (Throwable t) {
                    Log.e("WifiRaioX", "falha ao ler a lista de redes", t); // perde-se uma lista, não o app
                }
            });
        } catch (RejectedExecutionException ignored) {
            // app encerrando
        }
    }

    private JSONObject event(boolean fresh, String source) {
        List<ScanResult> results = Collections.emptyList();
        try {
            WifiManager wifi = Sys.wifi(context);
            if (wifi != null) {
                List<ScanResult> got = wifi.getScanResults();
                if (got != null) results = got;
            }
        } catch (SecurityException ignored) {
            // sem permissão o Android costuma devolver lista vazia, mas a documentação promete esta exceção
        } catch (RuntimeException ignored) {
            // serviço de Wi-Fi indisponível
        }
        long now = SystemClock.elapsedRealtime();
        long sinceFresh;
        synchronized (lock) {
            if (fresh) lastFreshAt = now;
            sinceFresh = lastFreshAt >= 0 ? now - lastFreshAt : now;
        }
        JSONObject o = new JSONObject();
        Json.put(o, "ts", System.currentTimeMillis());
        Json.put(o, "fresh", fresh);
        Json.put(o, "source", source);
        Json.put(o, "aps", ScanMapper.list(results, now, fresh, sinceFresh));
        return o;
    }
}
