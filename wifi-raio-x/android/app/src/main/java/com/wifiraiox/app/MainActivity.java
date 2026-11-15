package com.wifiraiox.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

/**
 * A única tela do app: um WebView com a interface que vem dentro do APK (assets/www) e a ponte
 * nativa (Bridge) que entrega a ela os dados de Wi-Fi do Android.
 */
public class MainActivity extends Activity implements JsSink, WebClient.Host {

    private static final String TAG = "WifiRaioX";
    /** Evita um vaivém infinito caso a página inicial tente, ela mesma, navegar para fora. */
    private static final long RESTORE_GAP_MS = 3000;
    private static final long RENDERER_LOOP_MS = 10_000;
    /** Estático: precisa sobreviver à recriação da tela. */
    static long lastRendererGoneAt = -1;

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private Bridge bridge;
    private boolean backPending;
    private long lastRestoreAt = -RESTORE_GAP_MS;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        try {
            // Inspeção remota (chrome://inspect) só em versão de desenvolvimento.
            WebView.setWebContentsDebuggingEnabled(debuggable);
            web = new WebView(this);
        } catch (RuntimeException e) {
            // O WebView do sistema pode estar ausente ou no meio de uma atualização.
            Log.e(TAG, "WebView indisponível", e);
            Toast.makeText(this, R.string.webview_missing, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        configure(web, debuggable);
        bridge = new Bridge(this, this);
        web.addJavascriptInterface(bridge, Bridge.JS_NAME);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        bridge.setPageUrl(WebClient.START_URL);
        web.loadUrl(WebClient.START_URL);
    }

    @SuppressLint("SetJavaScriptEnabled") // a página é a interface do próprio app, servida de dentro do APK
    @SuppressWarnings("deprecation") // os dois setAllow...FromFileURLs já nascem false; ficam explícitos por garantia
    private void configure(WebView view, final boolean debuggable) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Nada de file:// nem content://: tudo chega pelo WebViewAssetLoader, em https.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setGeolocationEnabled(false);
        settings.setSupportMultipleWindows(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);

        view.setBackgroundColor(getColor(R.color.page)); // sem clarão branco antes da página pintar
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler(WebAssets.URL_PATH, new WebAssets(this))
                .build();
        view.setWebViewClient(Build.VERSION.SDK_INT >= 26
                ? new WebClientApi26(loader, this)
                : new WebClient(loader, this));
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                if (debuggable && message != null) {
                    Log.d(TAG, message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                }
                return true;
            }
        });
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (web == null) return;
        web.onResume();
        bridge.onStart();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bridge != null) bridge.onResume();
    }

    @Override
    protected void onPause() {
        if (bridge != null) bridge.onPause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        if (web != null) {
            bridge.onStop();
            web.onPause(); // só aqui: em tela dividida o app pausado continua visível e animando
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.onDestroy();
        WebView view = web;
        web = null;
        main.removeCallbacksAndMessages(null);
        if (view != null) {
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.removeJavascriptInterface(Bridge.JS_NAME);
            view.stopLoading();
            view.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (bridge != null) bridge.onPermissionsResult(requestCode, permissions, grantResults);
    }

    /**
     * Botão/gesto "voltar": primeiro a página decide (fechar um painel, voltar de tela); só sai do
     * app quando ela responde que não tratou. Um segundo "voltar" sem resposta da página sai direto.
     */
    @Override
    @SuppressWarnings("deprecation") // mirando o Android 14, onBackPressed continua sendo chamado
    public void onBackPressed() {
        if (web == null || backPending) {
            leave();
            return;
        }
        backPending = true;
        try {
            web.evaluateJavascript(Js.BACK_SCRIPT, value -> {
                if (!backPending) return;
                backPending = false;
                if (!"true".equals(value)) leave();
            });
        } catch (RuntimeException e) {
            leave();
        }
    }

    @SuppressWarnings("deprecation")
    private void leave() {
        backPending = false;
        super.onBackPressed();
    }

    // ------------------------------------------------------------------ JsSink

    @Override
    public void eval(final String script) {
        if (Looper.myLooper() == Looper.getMainLooper()) evalNow(script);
        else main.post(() -> evalNow(script));
    }

    private void evalNow(String script) {
        WebView view = web;
        if (view == null) return; // página já destruída: descarta
        try {
            view.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {
            // WebView em encerramento
        }
    }

    // ------------------------------------------------------------------ WebClient.Host

    @Override
    public void onPageUrl(String url) {
        if (bridge != null) bridge.setPageUrl(url);
        // Um site externo conseguiu ocupar a página principal (o conteúdo dele já foi barrado): volta para o app.
        if (web != null && url != null && (url.startsWith("http:") || url.startsWith("https:")) && !WebClient.isAppUrl(url)) {
            long now = SystemClock.elapsedRealtime();
            if (now - lastRestoreAt < RESTORE_GAP_MS) return;
            lastRestoreAt = now;
            web.stopLoading();
            if (web.canGoBack()) web.goBack();
            else web.loadUrl(WebClient.START_URL);
        }
    }

    @Override
    public void onAppPageRequested() {
        if (bridge != null) bridge.onNewPage();
    }

    @Override
    public void onForeignMainFrame(final Uri uri) {
        main.post(() -> {
            if (web == null) return;
            if (bridge != null) bridge.setPageUrl(uri.toString());
            openExternal(uri);
        });
    }

    @Override
    public void openExternal(Uri uri) {
        String scheme = uri == null ? null : uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme) && !"mailto".equals(scheme) && !"tel".equals(scheme)) {
            return; // intent:, file:, javascript:... nunca saem daqui
        }
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, uri);
            view.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(view);
        } catch (RuntimeException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onRendererGone() {
        long now = SystemClock.elapsedRealtime();
        boolean again = lastRendererGoneAt >= 0 && now - lastRendererGoneAt < RENDERER_LOOP_MS;
        lastRendererGoneAt = now;
        if (again) {
            // Morreu de novo logo em seguida: recriar entraria em laço. Melhor fechar.
            Log.e(TAG, "processo do WebView encerrado duas vezes seguidas; fechando");
            finish();
            return;
        }
        // O WebView ficou inutilizável; recriar a tela devolve o app funcionando em vez de derrubá-lo.
        Log.w(TAG, "processo do WebView encerrado pelo sistema; recriando a tela");
        recreate();
    }

    Bridge bridge() {
        return bridge;
    }

    WebView webView() {
        return web;
    }
}
