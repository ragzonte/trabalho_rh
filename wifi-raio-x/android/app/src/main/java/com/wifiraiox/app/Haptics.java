package com.wifiraiox.app;

import android.content.Context;
import android.os.Build;
import android.os.Vibrator;

/** Vibração curta de retorno ao toque (ex.: ponto marcado no mapeamento). */
final class Haptics {

    static final int MIN_MS = 1;
    static final int MAX_MS = 500;

    private final Context context;

    Haptics(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Vibra por `ms` (contido em 1..500). Aparelho sem motor de vibração: não faz nada. */
    void vibrate(double ms) {
        if (Double.isNaN(ms)) return;
        int duration = Json.clamp(ms, MIN_MS, MAX_MS);
        try {
            Vibrator vibrator = vibrator();
            if (vibrator == null || !vibrator.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26) Api26.vibrate(vibrator, duration);
            else legacyVibrate(vibrator, duration);
        } catch (RuntimeException ignored) {
            // vibrar nunca é motivo para falhar uma chamada
        }
    }

    @SuppressWarnings("deprecation") // VIBRATOR_SERVICE direto é o caminho até o Android 11
    private Vibrator vibrator() {
        if (Build.VERSION.SDK_INT >= 31) return Api31.vibrator(context);
        return (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
    }

    @SuppressWarnings("deprecation") // vibrate(long) é a única forma antes do Android 8
    private static void legacyVibrate(Vibrator vibrator, long ms) {
        vibrator.vibrate(ms);
    }
}
