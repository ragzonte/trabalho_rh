package com.wifiraiox.app;

import android.webkit.ValueCallback;
import android.webkit.WebView;

import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Resetter;
import org.robolectric.shadows.ShadowWebView;

/**
 * WebView de teste que guarda TODOS os scripts que a tela de verdade manda executar (o do
 * Robolectric só lembra do último). Com ele os testes da MainActivity conseguem conferir cada
 * resposta e cada evento que chegaria à página. Ativar com @Config(shadows = RecordingWebView.class).
 */
@Implements(WebView.class)
public class RecordingWebView extends ShadowWebView {

    /** Tudo o que qualquer WebView do teste em curso recebeu. */
    static volatile Fixtures.Page page = new Fixtures.Page();

    @Implementation
    @Override
    protected void evaluateJavascript(String script, ValueCallback<String> callback) {
        page.eval(script);
        super.evaluateJavascript(script, callback);
    }

    @Resetter
    public static void reset() {
        page = new Fixtures.Page();
    }
}
