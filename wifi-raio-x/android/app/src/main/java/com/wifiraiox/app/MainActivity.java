package com.wifiraiox.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
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
    /** Evita um vaivém infinito caso a página inicial insista, ela mesma, em navegar para fora. */
    private static final long RESTORE_WINDOW_MS = 10_000;
    private static final int MAX_RESTORES = 3;
    private static final long RESTORE_CHECK_MS = 400;
    /** Uma página refeita que morre de novo antes disto está em laço: melhor fechar do que insistir. */
    static final long RENDERER_LOOP_MS = 10_000;
    /** A interface monta em 1 ou 2 segundos; passado este prazo sem sinal dela, algo a impede de rodar. */
    static final long PAGE_START_MS = 10_000;
    static final long PAGE_RECHECK_MS = 3_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    /** Só na thread da interface. null = sem página (WebView ausente, tela encerrada ou renderizador morto). */
    private WebView web;
    /** volatile: as threads do WebView também leem (pedido da página principal). */
    private volatile Bridge bridge;
    private boolean started;
    private boolean resumed;
    /** O processo de renderização morreu e a página ainda não foi refeita. */
    private boolean pageLost;
    /** elapsedRealtime da última vez em que a página foi refeita; -1 = ainda é a primeira. */
    private long pageRebuiltAt = -1;
    private boolean backPending;
    private long restoreWindowStart = -RESTORE_WINDOW_MS;
    private int restores;
    /** A página atual já mostrou que está rodando (ver checkPageStarted). */
    private boolean pageAlive;
    private boolean startProblemShown;
    private AlertDialog startProblem;
    private final Runnable pageStartCheck = this::checkPageStarted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!buildPage()) closeWithoutWebView();
    }

    /**
     * Cria o WebView e a ponte e manda carregar a interface. false = o WebView do sistema não pôde
     * ser criado (ausente, desativado ou no meio de uma atualização).
     */
    private boolean buildPage() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        final WebView view;
        try {
            // Inspeção remota (chrome://inspect) só em versão de desenvolvimento.
            WebView.setWebContentsDebuggingEnabled(debuggable);
            view = new WebView(this);
        } catch (RuntimeException | LinkageError e) {
            // LinkageError: a biblioteca nativa do WebView some por instantes enquanto a loja o atualiza.
            Log.e(TAG, "WebView indisponível", e);
            return false;
        }
        configure(view, debuggable);
        // A ponte fala só com o WebView em que nasceu: nada dela chega a uma página refeita depois.
        Bridge created = new Bridge(this, script -> evalOn(view, script));
        view.addJavascriptInterface(created, Bridge.JS_NAME);
        web = view;
        bridge = created;
        setContentView(view, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        created.setPageUrl(WebClient.START_URL);
        view.loadUrl(WebClient.START_URL);
        pageAlive = false;
        startProblemShown = false;
        watchPageStart(PAGE_START_MS);
        return true;
    }

    private void closeWithoutWebView() {
        Toast.makeText(this, R.string.webview_missing, Toast.LENGTH_LONG).show();
        finish();
    }

    /**
     * Encerra a ponte e o WebView atuais (tela fechando ou renderizador morto). A ponte vai
     * primeiro: quem esperava resposta ainda a recebe pela página que está de saída.
     */
    private void dropPage() {
        Bridge old = bridge;
        if (old != null) old.onDestroy();
        bridge = null;
        WebView view = web;
        web = null;
        backPending = false;
        main.removeCallbacksAndMessages(null);
        dismissStartProblem();
        if (view == null) return;
        try {
            if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
            view.removeJavascriptInterface(Bridge.JS_NAME);
            view.stopLoading();
            view.destroy();
        } catch (RuntimeException e) {
            Log.w(TAG, "falha ao encerrar o WebView", e);
        }
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
        // WebViews antigos só contam à página que o celular está no modo escuro se o app pedir.
        WebDarkMode.apply(settings, getResources().getConfiguration());
        WebTextZoom.apply(settings, getResources().getConfiguration());

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

    /**
     * Girar a tela, trocar o modo claro/escuro ou o tamanho da fonte não recria a tela (veja
     * configChanges no manifesto); o que precisa acompanhar a mudança é atualizado aqui.
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        WebView view = web;
        if (view == null) return;
        try {
            WebSettings settings = view.getSettings();
            WebDarkMode.apply(settings, newConfig);
            WebTextZoom.apply(settings, newConfig); // o WebView só lê o tamanho da fonte ao nascer
        } catch (RuntimeException ignored) {
            // WebView em encerramento
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        started = true;
        if (pageLost) restorePage(); // o renderizador morreu enquanto o app estava fora da tela
        else startPage();
        if (web != null && !pageAlive) watchPageStart(PAGE_START_MS); // a conferência não roda fora da tela
    }

    /** WebView e ponte passam a acompanhar a tela visível. */
    private void startPage() {
        Bridge current = bridge;
        if (web == null || current == null) return;
        web.onResume();
        current.onStart();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        Bridge current = bridge;
        if (current != null) current.onResume();
    }

    @Override
    protected void onPause() {
        resumed = false; // a ponte não se importa: pausado ainda é visível (tela dividida, diálogo por cima)
        super.onPause();
    }

    @Override
    protected void onStop() {
        started = false;
        Bridge current = bridge;
        if (web != null && current != null) {
            current.onStop();
            web.onPause(); // só aqui: em tela dividida o app pausado continua visível e animando
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        pageLost = false;
        dropPage();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        Bridge current = bridge;
        if (current != null) current.onPermissionsResult(requestCode, permissions, grantResults);
    }

    /**
     * Botão/gesto "voltar": primeiro a página decide (fechar um painel, voltar de tela); só sai do
     * app quando ela responde que não tratou. Um segundo "voltar" sem resposta da página sai direto.
     */
    @Override
    @SuppressWarnings("deprecation") // mirando o Android 14, onBackPressed continua sendo chamado
    public void onBackPressed() {
        final WebView asked = web;
        if (asked == null || backPending) {
            leave();
            return;
        }
        backPending = true;
        try {
            asked.evaluateJavascript(Js.BACK_SCRIPT, value -> {
                if (!backPending || asked != web) return; // resposta atrasada de uma página que já se foi
                backPending = false;
                if (!"true".equals(value)) leave();
            });
        } catch (RuntimeException e) {
            leave();
        }
    }

    /**
     * Sai do app. Pode rodar bem depois do toque (a resposta da página é assíncrona), quando a tela
     * já foi para o segundo plano: no Android 7 o onBackPressed() do sistema lança
     * IllegalStateException se o estado da tela já foi salvo, então nesse caso fecha direto.
     */
    @SuppressWarnings("deprecation")
    private void leave() {
        backPending = false;
        if (isFinishing() || isDestroyed()) return;
        try {
            super.onBackPressed();
        } catch (IllegalStateException e) {
            finish();
        }
    }

    // ------------------------------------------------------------------ a página abriu?

    /*
     * Ninguém garante que a página consiga rodar: num aparelho com o WebView parado numa versão
     * antiga (comum em Android 7 a 9 sem atualizações da loja) os módulos da interface nem são
     * interpretados e a tela ficaria para sempre na abertura, sem explicação. Depois de um prazo
     * folgado perguntamos à página se ela está de pé; se não estiver, um aviso diz o que fazer.
     */

    private void watchPageStart(long delayMs) {
        main.removeCallbacks(pageStartCheck);
        main.postDelayed(pageStartCheck, delayMs);
    }

    private void checkPageStarted() {
        final WebView asked = web;
        if (asked == null || pageAlive || !started || isFinishing() || isDestroyed()) return;
        try {
            asked.evaluateJavascript(Js.ALIVE_SCRIPT, value -> onPageAliveAnswer(asked, "true".equals(value)));
        } catch (RuntimeException ignored) {
            // WebView em encerramento
        }
    }

    private void onPageAliveAnswer(WebView asked, boolean alive) {
        if (asked != web || isFinishing() || isDestroyed()) return;
        if (alive) {
            pageAlive = true;
            dismissStartProblem(); // demorou, mas abriu
            return;
        }
        showStartProblem();
        if (startProblem != null) watchPageStart(PAGE_RECHECK_MS); // se a página acordar, o aviso some sozinho
    }

    private void showStartProblem() {
        if (startProblemShown || !started) return;
        startProblemShown = true;
        try {
            int theme = getResources().getBoolean(R.bool.light_theme)
                    ? android.R.style.Theme_Material_Light_Dialog_Alert
                    : android.R.style.Theme_Material_Dialog_Alert;
            startProblem = new AlertDialog.Builder(this, theme)
                    .setTitle(R.string.page_stuck_title)
                    .setMessage(getString(R.string.page_stuck_message, webViewVersion()))
                    .setPositiveButton(R.string.page_stuck_update, (dialog, which) -> openWebViewInStore())
                    .setNegativeButton(R.string.page_stuck_wait, null)
                    .setOnDismissListener(dialog -> startProblem = null)
                    .show();
        } catch (RuntimeException e) {
            startProblem = null; // a janela já não aceita diálogos (tela de saída)
        }
    }

    private void dismissStartProblem() {
        AlertDialog dialog = startProblem;
        startProblem = null;
        if (dialog == null) return;
        try {
            dialog.dismiss();
        } catch (RuntimeException ignored) {
            // janela já destruída
        }
    }

    /** Versão do motor do WebView ("51", "119"...), tirada do texto com que ele se identifica. */
    private String webViewVersion() {
        try {
            String agent = web == null ? null : web.getSettings().getUserAgentString();
            int at = agent == null ? -1 : agent.indexOf("Chrome/");
            if (at >= 0) {
                int end = at + 7;
                while (end < agent.length() && Character.isDigit(agent.charAt(end))) end++;
                if (end > at + 7) return agent.substring(at + 7, end);
            }
        } catch (RuntimeException ignored) {
            // sem versão: o aviso sai do mesmo jeito
        }
        return getString(R.string.page_stuck_unknown_version);
    }

    /** Abre a página do componente na loja. No Android 7 o WebView é o próprio Chrome, quando ele está ativo. */
    private void openWebViewInStore() {
        String pkg = Build.VERSION.SDK_INT >= 26 ? Api26.webViewPackage() : null;
        if (pkg == null) pkg = Build.VERSION.SDK_INT < 26 && chromeEnabled() ? "com.android.chrome" : "com.google.android.webview";
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)));
        } catch (RuntimeException noStore) {
            openExternal(Uri.parse("https://play.google.com/store/apps/details?id=" + pkg));
        }
    }

    private boolean chromeEnabled() {
        try {
            return getPackageManager().getApplicationInfo("com.android.chrome", 0).enabled;
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ JsSink

    /** Executa na página atual, seja ela qual for (a ponte usa evalOn, presa ao próprio WebView). */
    @Override
    public void eval(final String script) {
        if (Looper.myLooper() == Looper.getMainLooper()) evalNow(web, script);
        else main.post(() -> evalNow(web, script));
    }

    private void evalOn(final WebView view, final String script) {
        if (Looper.myLooper() == Looper.getMainLooper()) evalNow(view, script);
        else main.post(() -> evalNow(view, script));
    }

    private void evalNow(WebView view, String script) {
        if (view == null || view != web) return; // página já destruída ou trocada: descarta
        try {
            view.evaluateJavascript(script, null);
        } catch (RuntimeException ignored) {
            // WebView em encerramento
        }
    }

    // ------------------------------------------------------------------ WebClient.Host

    @Override
    public void onPageUrl(String url) {
        Bridge current = bridge;
        if (current != null) current.setPageUrl(url);
        if (WebClient.isAppUrl(url)) {
            pageAlive = false; // recarga: a página nova ainda tem de mostrar que roda
            watchPageStart(PAGE_START_MS);
        }
        // Um site externo ocupou a página principal (o conteúdo dele foi barrado, sobrou uma página vazia): volta para o app.
        if (url != null && (url.startsWith("http:") || url.startsWith("https:")) && !WebClient.isAppUrl(url)) reloadAppPage();
    }

    /** Recarrega a interface do app, a menos que isso já tenha acontecido várias vezes em poucos segundos. */
    private void reloadAppPage() {
        if (web == null) return;
        long now = SystemClock.elapsedRealtime();
        if (now - restoreWindowStart > RESTORE_WINDOW_MS) {
            restoreWindowStart = now;
            restores = 0;
        }
        if (++restores > MAX_RESTORES) return;
        web.stopLoading();
        web.loadUrl(WebClient.START_URL);
    }

    @Override
    public void onAppPageRequested() {
        Bridge current = bridge;
        if (current != null) current.onNewPage();
    }

    @Override
    public void onForeignMainFrame(final Uri uri) {
        main.post(() -> {
            if (web == null) return;
            openExternal(uri);
            web.stopLoading(); // se ainda der tempo, a página do app nem chega a sair
            // Se não deu, o WebView ficou numa página de erro com o endereço de fora: confere e recarrega.
            main.postDelayed(() -> {
                if (web != null && !WebClient.isAppUrl(web.getUrl())) reloadAppPage();
            }, RESTORE_CHECK_MS);
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

    /**
     * O Android matou (ou o próprio WebView derrubou) o processo que desenha a página. O WebView
     * fica inutilizável e tem de ser destruído; a página é refeita aqui mesmo, sem recriar a tela,
     * e só quando o app está visível: refazê-la em segundo plano gastaria a memória que o sistema
     * acabou de recuperar e ele a mataria de novo.
     */
    @Override
    public void onRendererGone(WebView view) {
        if (view == null || view != web) return; // WebView que já foi descartado
        long now = SystemClock.elapsedRealtime();
        boolean loop = started && pageRebuiltAt >= 0 && now - pageRebuiltAt < RENDERER_LOOP_MS;
        dropPage();
        if (isFinishing() || isDestroyed()) return;
        if (loop) {
            Log.e(TAG, "a página refeita morreu de novo em seguida; fechando");
            Toast.makeText(this, R.string.page_crashed, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        Log.w(TAG, "processo do WebView encerrado; a página será refeita");
        pageLost = true;
        main.post(this::restorePage); // fora do callback do WebView
    }

    /** Refaz a página perdida, se a tela estiver visível; senão fica para o próximo onStart. */
    private void restorePage() {
        if (!pageLost || !started || isFinishing() || isDestroyed()) return;
        pageLost = false;
        if (!buildPage()) {
            closeWithoutWebView();
            return;
        }
        pageRebuiltAt = SystemClock.elapsedRealtime();
        startPage();
        Bridge current = bridge;
        if (resumed && current != null) current.onResume();
    }

    Bridge bridge() {
        return bridge;
    }

    WebView webView() {
        return web;
    }

    boolean pageLost() {
        return pageLost;
    }

    AlertDialog startProblemDialog() {
        return startProblem;
    }
}
