package com.wifiraiox.app;

import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.annotation.RequiresApi;
import androidx.annotation.RequiresPermission;

/** Só Android 8 (API 26) em diante. */
@RequiresApi(26)
final class Api26 {

    private Api26() {}

    @RequiresPermission(android.Manifest.permission.VIBRATE)
    static void vibrate(Vibrator vibrator, long ms) {
        vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
    }
}
