package com.wifiraiox.app;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/** Pinta as barras do sistema (status e navegação) com a cor do tema da página. */
final class SystemBars {

    private SystemBars() {}

    /** "#rrggbb" ou "#rgb" -> cor opaca; null para qualquer outra coisa. */
    static Integer parseColor(String text) {
        if (text == null) return null;
        String s = text.trim();
        if (s.length() != 7 && s.length() != 4) return null;
        if (s.charAt(0) != '#') return null;
        int rgb = 0;
        for (int i = 1; i < s.length(); i++) {
            int d = Character.digit(s.charAt(i), 16);
            if (d < 0) return null;
            if (s.length() == 4) rgb = (rgb << 8) | (d * 17); // "#abc" = "#aabbcc"
            else rgb = (rgb << 4) | d;
        }
        return 0xFF000000 | rgb;
    }

    /**
     * Aplica a cor e escolhe ícones claros (fundo escuro) ou escuros (fundo claro). Thread da interface.
     *
     * @param dark true = fundo escuro, ícones claros
     */
    @SuppressWarnings("deprecation") // setStatusBarColor/setNavigationBarColor valem enquanto o app mira o Android 14
    static void apply(Activity activity, int color, boolean dark) {
        Window window = activity.getWindow();
        if (window == null) return;
        window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS
                | WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
        window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        window.setStatusBarColor(color);
        // Antes do Android 8 os botões da barra de navegação são sempre brancos: num fundo claro sumiriam.
        boolean lightNavigationPossible = Build.VERSION.SDK_INT >= 26;
        window.setNavigationBarColor(dark || lightNavigationPossible ? color : Color.BLACK);
        window.setBackgroundDrawable(new ColorDrawable(color)); // sem clarão ao girar a tela

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }
}
