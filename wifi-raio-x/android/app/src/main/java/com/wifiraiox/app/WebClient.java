package com.wifiraiox.app;

import android.graphics.Bitmap;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/**
 * Regras de navegação do WebView: a página do app vem dos assets do APK; qualquer outro endereço
 * abre no navegador do celular, nunca dentro do app (onde teria acesso à ponte nativa).
 */
class WebClient extends WebViewClient {

    interface Host {
        /** A página principal mudou de endereço (thread da interface). */
        void onPageUrl(String url);

        /** Abrir fora do app (thread da interface). */
        void openExternal(Uri uri);

        /** Um endereço externo tentou ocupar a página principal por um caminho que não avisa antes (qualquer thread). */
        void onForeignMainFrame(Uri uri);

        /** O processo de renderização morreu (thread da interface). */
        void onRendererGone();
    }

    static final String HOST = WebViewAssetLoader.DEFAULT_DOMAIN; // appassets.androidplatform.net
    static final String START_URL = "https://" + HOST + WebAssets.URL_PATH + "index.html";

    final Host host;
    private final WebViewAssetLoader loader;

    WebClient(WebViewAssetLoader loader, Host host) {
        this.loader = loader;
        this.host = host;
    }

    /** O endereço é da própria interface (https, domínio reservado, sem porta)? */
    static boolean isAppUrl(Uri uri) {
        return uri != null && "https".equals(uri.getScheme()) && HOST.equals(uri.getHost()) && uri.getPort() == -1;
    }

    static boolean isAppUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            return isAppUrl(Uri.parse(url));
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (isAppUrl(uri)) {
            WebResourceResponse response = loader.shouldInterceptRequest(uri);
            return response != null ? response : WebAssets.status(404, "Not Found");
        }
        if (request.isForMainFrame()) {
            // shouldOverrideUrlLoading não é consultado em todos os casos (ex.: formulário POST): barra aqui.
            host.onForeignMainFrame(uri);
            return WebAssets.status(403, "Forbidden");
        }
        return null; // recursos de outros sites (imagem, fetch) seguem as regras normais da web
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (isAppUrl(uri)) return false;
        if (request.isForMainFrame()) host.openExternal(uri);
        return true;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        host.onPageUrl(url);
    }
}
