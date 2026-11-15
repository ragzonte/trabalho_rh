package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.robolectric.Shadows.shadowOf;

import android.content.res.Configuration;
import android.webkit.WebView;

import org.junit.Test;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;

/**
 * O tamanho de fonte do sistema chega à página, inclusive quando muda com o app aberto (a tela não
 * é recriada, e o WebView só lê esse valor ao nascer: visto num Android 11 com o WebView 83).
 */
public class WebTextZoomTest extends AllSdks {

    private static Configuration scale(float fontScale) {
        Configuration c = new Configuration();
        c.fontScale = fontScale;
        return c;
    }

    @Test
    public void percentFollowsTheSystemFontScale() {
        assertEquals(100, WebTextZoom.percentFor(scale(1f)));
        assertEquals(130, WebTextZoom.percentFor(scale(1.3f)));
        assertEquals(85, WebTextZoom.percentFor(scale(0.85f)));
        assertEquals(200, WebTextZoom.percentFor(scale(2f)));
    }

    @Test
    public void absurdValuesNeverReachThePage() {
        assertEquals(100, WebTextZoom.percentFor(null));
        assertEquals(100, WebTextZoom.percentFor(scale(0f)));
        assertEquals(100, WebTextZoom.percentFor(scale(-1f)));
        assertEquals(100, WebTextZoom.percentFor(scale(Float.NaN)));
        assertEquals(WebTextZoom.MAX_PERCENT, WebTextZoom.percentFor(scale(40f)));
        assertEquals(WebTextZoom.MIN_PERCENT, WebTextZoom.percentFor(scale(0.01f)));
        WebTextZoom.apply(null, scale(1.3f)); // sem página: nada a fazer, sem lançar
    }

    @Test
    public void aPhoneWithLargeTextStartsThePageEnlarged() {
        RuntimeEnvironment.setFontScale(1.3f);
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertEquals(130, activity.webView().getSettings().getTextZoom());
    }

    @Test
    public void changingTheFontSizeWithTheAppOpenReachesThePageWithoutReloadingIt() {
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity activity = controller.get();
        WebView web = activity.webView();
        assertEquals(100, web.getSettings().getTextZoom());

        RuntimeEnvironment.setFontScale(1.3f);
        controller.configurationChange();
        assertSame("fontScale está em configChanges: a mesma página continua", web, activity.webView());
        assertEquals(130, web.getSettings().getTextZoom());
        assertEquals(0, shadowOf(web).getReloadInvocations());

        RuntimeEnvironment.setFontScale(1f);
        controller.configurationChange();
        assertEquals(100, web.getSettings().getTextZoom());
    }

    @Test
    public void rotatingKeepsTheTextSize() {
        RuntimeEnvironment.setFontScale(1.15f);
        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).setup();
        assertEquals(115, controller.get().webView().getSettings().getTextZoom());
        RuntimeEnvironment.setQualifiers("+land");
        controller.configurationChange();
        assertEquals(115, controller.get().webView().getSettings().getTextZoom());
    }
}
