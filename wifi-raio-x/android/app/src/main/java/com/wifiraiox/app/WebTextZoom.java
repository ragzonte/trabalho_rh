package com.wifiraiox.app;

import android.content.res.Configuration;
import android.webkit.WebSettings;

/**
 * O "tamanho da fonte" escolhido no Android vale também para a página.
 *
 * O WebView já nasce com o texto ampliado pelo tamanho de fonte do sistema, mas não acompanha uma
 * mudança feita com o app aberto: como a tela não é recriada (fontScale está em configChanges, para
 * não perder um mapeamento em andamento), o texto ficaria no tamanho antigo até o app ser fechado.
 * Aqui o mesmo cálculo é refeito a cada mudança de configuração (e ao criar a página, para não
 * depender de cada versão do WebView fazer a conta sozinha).
 */
final class WebTextZoom {

    /** Fora desta faixa o valor do sistema é tratado como defeito (o Android vai de 0,85 a 2,0). */
    static final int MIN_PERCENT = 50;
    static final int MAX_PERCENT = 200;

    private WebTextZoom() {}

    /** 1,0 -> 100; 1,3 -> 130. Valores ausentes ou absurdos viram 100. */
    static int percentFor(Configuration config) {
        float scale = config == null ? 1f : config.fontScale;
        if (Float.isNaN(scale) || scale <= 0f) return 100;
        return Math.max(MIN_PERCENT, Math.min(MAX_PERCENT, Math.round(scale * 100f)));
    }

    /** Nunca lança: é só aparência. */
    static void apply(WebSettings settings, Configuration config) {
        if (settings == null) return;
        try {
            int percent = percentFor(config);
            if (settings.getTextZoom() != percent) settings.setTextZoom(percent);
        } catch (RuntimeException ignored) {
            // WebView em encerramento
        }
    }
}
