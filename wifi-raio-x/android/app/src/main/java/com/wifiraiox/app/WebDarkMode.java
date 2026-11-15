package com.wifiraiox.app;

import android.content.res.Configuration;
import android.util.Log;
import android.webkit.WebSettings;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

/**
 * Faz a página enxergar o modo claro/escuro do celular ("prefers-color-scheme") também nos WebViews
 * antigos.
 *
 * Os WebViews atuais respondem a essa consulta olhando o isLightTheme do tema do app (veja
 * res/values-v29/themes.xml). Os anteriores a essa regra, como o WebView 83 que vem de fábrica no
 * Android 11, só dizem "escuro" à página quando o app liga o "force dark" do WebView; sem isso a
 * consulta não casa nem com claro nem com escuro, e o tema "Sistema" da interface ficava sempre claro,
 * com o celular no modo escuro.
 *
 * Aqui o force dark acompanha o modo do celular, sempre com a estratégia "só o tema da própria
 * página": o WebView avisa a página e nunca recolore nada por conta própria (a interface tem o seu
 * tema escuro). Onde a estratégia não pode ser escolhida (WebView anterior ao 83) nada é ligado:
 * melhor ficar no tema claro do que ter as cores invertidas à força. Nos WebViews atuais, com o app
 * mirando o Android 13+, estas chamadas não têm efeito e quem vale é o isLightTheme.
 */
final class WebDarkMode {

    private static final String TAG = "WifiRaioX";

    /** O que o WebView instalado sabe fazer. Trocado nos testes, onde não há WebView de verdade. */
    interface Engine {
        /** Dá para pedir "só o tema da página" e ligar/desligar o modo escuro? */
        boolean supported();

        /** O WebView só repassa o modo à página; nada de escurecer o conteúdo por algoritmo. */
        void useWebThemeOnly(WebSettings settings);

        void setDark(WebSettings settings, boolean dark);
    }

    @SuppressWarnings("deprecation") // obsoletas só para WebViews novos, onde não fazem nada; nos antigos são o único caminho
    static final Engine WEBKIT = new Engine() {
        @Override
        public boolean supported() {
            return WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)
                    && WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK_STRATEGY);
        }

        @Override
        public void useWebThemeOnly(WebSettings settings) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK_STRATEGY)) {
                WebSettingsCompat.setForceDarkStrategy(settings, WebSettingsCompat.DARK_STRATEGY_WEB_THEME_DARKENING_ONLY);
            }
        }

        @Override
        public void setDark(WebSettings settings, boolean dark) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
                WebSettingsCompat.setForceDark(settings,
                        dark ? WebSettingsCompat.FORCE_DARK_ON : WebSettingsCompat.FORCE_DARK_OFF);
            }
        }
    };

    static volatile Engine engine = WEBKIT;

    private WebDarkMode() {}

    static boolean isNight(Configuration config) {
        return config != null
                && (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * Ajusta o WebView ao modo atual do celular. Chamado ao criar a página e a cada mudança de
     * configuração (a tela não é recriada quando o modo muda). Nunca lança: é só aparência.
     *
     * @return true quando o modo foi repassado ao WebView
     */
    static boolean apply(WebSettings settings, Configuration config) {
        if (settings == null) return false;
        Engine current = engine;
        try {
            if (!current.supported()) return false;
            current.useWebThemeOnly(settings);
            current.setDark(settings, isNight(config));
            return true;
        } catch (RuntimeException | LinkageError e) {
            // WebView no meio de uma atualização, ou um que anuncia o recurso e não o tem
            Log.w(TAG, "não foi possível repassar o modo escuro ao WebView", e);
            return false;
        }
    }
}
