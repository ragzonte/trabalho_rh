package com.wifiraiox.app;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

/** Esqueleto: a tela única do app (WebView). A ponte com o Wi-Fi entra aqui. */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);
    }
}
