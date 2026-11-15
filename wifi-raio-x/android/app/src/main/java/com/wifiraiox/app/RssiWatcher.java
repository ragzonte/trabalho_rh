package com.wifiraiox.app;

import android.os.Handler;

import org.json.JSONObject;

/**
 * Emite o sinal da conexão atual em intervalos regulares (evento 'rssi'), só enquanto a tela está
 * visível (entre onStart e onStop). Todo o estado vive na thread da interface.
 */
final class RssiWatcher {

    interface Source {
        /** RssiSample, ou null quando não há sinal para medir. */
        JSONObject sample();
    }

    interface Listener {
        void onSample(JSONObject sample);
    }

    static final int MIN_INTERVAL_MS = 250;
    static final int MAX_INTERVAL_MS = 60_000;
    static final int DEFAULT_INTERVAL_MS = 1000;

    private final Handler main;
    private final Source source;
    private final Listener listener;
    private boolean watching;
    private boolean visible;
    private boolean ticking;
    private int intervalMs = DEFAULT_INTERVAL_MS;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!ticking) return;
            try {
                JSONObject sample = source.sample();
                if (sample != null) listener.onSample(sample);
            } catch (RuntimeException ignored) {
                // uma leitura ruim não para o relógio
            }
            main.postDelayed(this, intervalMs);
        }
    };

    RssiWatcher(Handler main, Source source, Listener listener) {
        this.main = main;
        this.source = source;
        this.listener = listener;
    }

    static int clampInterval(double requested) {
        if (Double.isNaN(requested)) return DEFAULT_INTERVAL_MS;
        return Json.clamp(requested, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    }

    /** watchRssi: começa (ou muda o intervalo). Pode ser chamado de qualquer thread. */
    void watch(final int interval) {
        Sys.runOnMain(main, () -> {
            intervalMs = clampInterval(interval);
            watching = true;
            restart();
        });
    }

    /** unwatchRssi. */
    void unwatch() {
        Sys.runOnMain(main, () -> {
            watching = false;
            restart();
        });
    }

    /** onStart / onStop da Activity. */
    void setVisible(final boolean value) {
        Sys.runOnMain(main, () -> {
            visible = value;
            restart();
        });
    }

    boolean ticking() {
        return ticking;
    }

    private void restart() {
        main.removeCallbacks(tick);
        ticking = watching && visible;
        if (ticking) main.post(tick); // a primeira amostra sai logo
    }
}
