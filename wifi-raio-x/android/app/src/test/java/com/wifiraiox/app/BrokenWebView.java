package com.wifiraiox.app;

import android.content.Context;
import android.webkit.WebView;

import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowWebView;

/**
 * WebView que não consegue nascer, como num aparelho em que o "Android System WebView" está
 * ausente, desativado ou no meio de uma atualização. Ativar com @Config(shadows = BrokenWebView.class).
 */
@Implements(WebView.class)
public class BrokenWebView extends ShadowWebView {

    /** O que o construtor lança; null = funciona. */
    static volatile Throwable failure;

    @Implementation
    protected void __constructor__(Context context) {
        Throwable t = failure;
        if (t instanceof Error) throw (Error) t;
        if (t instanceof RuntimeException) throw (RuntimeException) t;
    }
}
