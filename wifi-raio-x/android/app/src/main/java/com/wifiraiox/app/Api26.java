package com.wifiraiox.app;

import android.content.pm.PackageInfo;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.webkit.WebView;

import androidx.annotation.RequiresApi;
import androidx.annotation.RequiresPermission;

/** Só Android 8 (API 26) em diante. */
@RequiresApi(26)
final class Api26 {

    private Api26() {}

    /** Pacote que fornece o WebView neste aparelho (o próprio WebView ou o Chrome), ou null. */
    static String webViewPackage() {
        try {
            PackageInfo info = WebView.getCurrentWebViewPackage();
            return info == null ? null : info.packageName;
        } catch (RuntimeException e) {
            return null;
        }
    }

    @RequiresPermission(android.Manifest.permission.VIBRATE)
    static void vibrate(Vibrator vibrator, long ms) {
        vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
    }
}
