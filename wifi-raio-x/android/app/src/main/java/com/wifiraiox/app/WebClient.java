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
 * abre no navegador do celular, nunca dentro do app (onde teria acesso à ponte nativa), e nenhum
 * recurso (script, imagem, quadro, fetch) é buscado fora do APK.
 */
class WebClient extends WebViewClient {

    interface Host {
        /** A página principal mudou de endereço (thread da interface). */
        void onPageUrl(String url);

        /**
         * O documento principal do app foi pedido: uma página nova vai nascer (primeira carga ou
         * recarga). Chamado antes de qualquer script dela rodar, de uma thread do WebView.
         */
        void onAppPageRequested();

        /** Abrir fora do app (thread da interface). */
        void openExternal(Uri uri);

        /** Um endereço externo tentou ocupar a página principal por um caminho que não avisa antes (qualquer thread). */
        void onForeignMainFrame(Uri uri);

        /** O processo de renderização desse WebView morreu (thread da interface). */
        void onRendererGone(WebView view);
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

    /** Endereços que o próprio WebView resolve na memória, sem tocar na rede nem em arquivos. */
    static boolean isLocalScheme(Uri uri) {
        String scheme = uri == null ? null : uri.getScheme();
        return "data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme);
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
        try {
            Uri uri = request.getUrl();
            if (isAppUrl(uri)) {
                if (request.isForMainFrame()) host.onAppPageRequested();
                WebResourceResponse response = loader.shouldInterceptRequest(uri);
                return response != null ? response : WebAssets.status(404, "Not Found");
            }
            if (request.isForMainFrame()) {
                // shouldOverrideUrlLoading não é consultado em todos os casos (ex.: formulário POST): barra aqui.
                host.onForeignMainFrame(uri);
                return WebAssets.status(403, "Forbidden");
            }
            // A interface é toda local e nada dela sai para a rede (quem fala com a internet é o lado
            // nativo). Um pedido para fora só pode ser conteúdo injetado tentando trazer código ou
            // levar dados embora; data:, blob: e about: não saem do aparelho e seguem normais.
            return isLocalScheme(uri) ? null : WebAssets.status(403, "Forbidden");
        } catch (RuntimeException e) {
            // Roda numa thread do WebView: uma exceção solta aqui derrubaria o app inteiro.
            return WebAssets.status(500, "Internal Error");
        }
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
