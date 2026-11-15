package com.wifiraiox.app;

import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import androidx.annotation.RequiresApi;
import androidx.webkit.WebViewAssetLoader;

/**
 * Android 8+: quando o sistema mata o processo de renderização do WebView (falta de memória), o
 * app inteiro cairia junto se ninguém tratasse. Fica numa classe à parte porque
 * RenderProcessGoneDetail não existe no Android 7.
 */
@RequiresApi(26)
final class WebClientApi26 extends WebClient {

    WebClientApi26(WebViewAssetLoader loader, Host host) {
        super(loader, host);
    }

    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        try {
            host.onRendererGone(view);
        } catch (RuntimeException e) {
            Log.e("WifiRaioX", "falha ao tratar a morte do renderizador", e);
        }
        return true; // false (ou uma exceção) faria o Android encerrar o app
    }
}
