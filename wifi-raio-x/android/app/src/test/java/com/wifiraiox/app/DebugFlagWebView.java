package com.wifiraiox.app;

import android.webkit.WebView;

import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Resetter;
import org.robolectric.shadows.ShadowWebView;

/**
 * WebView de teste que lembra o que foi pedido em WebView.setWebContentsDebuggingEnabled (o do
 * Robolectric aceita e esquece). Ativar com @Config(shadows = DebugFlagWebView.class).
 */
@Implements(WebView.class)
public class DebugFlagWebView extends ShadowWebView {

    /** null = ninguém chamou. */
    static volatile Boolean debugging;

    @Implementation
    public static void setWebContentsDebuggingEnabled(boolean enabled) {
        debugging = enabled;
    }

    @Resetter
    public static void reset() {
        debugging = null;
    }
}
