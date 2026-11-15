package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.content.res.Configuration;
import android.os.Build;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;

/**
 * O modo claro/escuro do celular chega à página também nos WebViews antigos (visto num Android 11
 * com o WebView 83 de fábrica: "prefers-color-scheme" não casava com nada e o tema "Sistema" da
 * interface ficava sempre claro).
 */
public class WebDarkModeTest extends AllSdks {

    /** WebView de mentira: anota o que foi pedido, em ordem. */
    static final class FakeEngine implements WebDarkMode.Engine {
        boolean supported = true;
        RuntimeException failure;
        final List<String> calls = new ArrayList<>();
        final List<WebSettings> targets = new ArrayList<>();

        @Override
        public boolean supported() {
            return supported;
        }

        @Override
        public void useWebThemeOnly(WebSettings settings) {
            if (failure != null) throw failure;
            calls.add("web-theme-only");
            targets.add(settings);
        }

        @Override
        public void setDark(WebSettings settings, boolean dark) {
            calls.add(dark ? "dark" : "light");
            targets.add(settings);
        }

        String last() {
            return calls.isEmpty() ? null : calls.get(calls.size() - 1);
        }
    }

    private FakeEngine engine;
    private ActivityController<MainActivity> controller;

    @Before
    public void installEngine() {
        engine = new FakeEngine();
        WebDarkMode.engine = engine;
    }

    @After
    public void restoreEngine() {
        WebDarkMode.engine = WebDarkMode.WEBKIT;
    }

    private MainActivity launch() {
        controller = Robolectric.buildActivity(MainActivity.class).setup();
        return controller.get();
    }

    private static Configuration config(boolean night) {
        Configuration c = new Configuration();
        c.uiMode = Configuration.UI_MODE_TYPE_NORMAL | (night ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        return c;
    }

    @Test
    public void nightIsReadFromTheConfiguration() {
        assertTrue(WebDarkMode.isNight(config(true)));
        assertFalse(WebDarkMode.isNight(config(false)));
        assertFalse("modo indefinido conta como claro", WebDarkMode.isNight(new Configuration()));
        assertFalse(WebDarkMode.isNight(null));
    }

    @Test
    public void thePageIsToldAndTheWebViewNeverRecolorsByItself() {
        WebSettings settings = new WebView(RuntimeEnvironment.getApplication()).getSettings();
        assertTrue(WebDarkMode.apply(settings, config(true)));
        // a estratégia vem ANTES de ligar: nunca há um instante com o escurecimento automático valendo
        assertEquals(java.util.Arrays.asList("web-theme-only", "dark"), engine.calls);
        engine.calls.clear();
        assertTrue(WebDarkMode.apply(settings, config(false)));
        assertEquals(java.util.Arrays.asList("web-theme-only", "light"), engine.calls);
    }

    @Test
    public void aWebViewThatCannotChooseTheStrategyIsLeftAlone() {
        engine.supported = false;
        WebSettings settings = new WebView(RuntimeEnvironment.getApplication()).getSettings();
        assertFalse(WebDarkMode.apply(settings, config(true)));
        assertTrue("sem a estratégia, ligar o modo escuro inverteria as cores da página à força", engine.calls.isEmpty());
    }

    @Test
    public void aFailingWebViewNeverTakesTheAppDown() {
        engine.failure = new UnsupportedOperationException("recurso anunciado e ausente");
        WebSettings settings = new WebView(RuntimeEnvironment.getApplication()).getSettings();
        assertFalse(WebDarkMode.apply(settings, config(true)));
        assertFalse(WebDarkMode.apply(null, config(true)));
    }

    @Test
    public void theRealEngineIsHarmlessWhereThereIsNoWebViewSupport() {
        // No teste não há WebView de verdade por trás: o caminho real tem de recusar em silêncio, sem lançar.
        WebDarkMode.engine = WebDarkMode.WEBKIT;
        WebSettings settings = new WebView(RuntimeEnvironment.getApplication()).getSettings();
        WebDarkMode.apply(settings, config(true));
        WebDarkMode.apply(settings, config(false));
    }

    @Test
    public void aLightPhoneStartsThePageInLightMode() {
        MainActivity activity = launch();
        assertEquals("light", engine.last());
        assertSame(activity.webView().getSettings(), engine.targets.get(engine.targets.size() - 1));
    }

    @Test
    @Config(qualifiers = "night")
    public void aDarkPhoneStartsThePageInDarkMode() {
        launch();
        assertEquals("dark", engine.last());
    }

    @Test
    public void switchingThePhoneToDarkAndBackReachesThePageWithoutRecreatingIt() {
        MainActivity activity = launch();
        WebView web = activity.webView();
        assertEquals("light", engine.last());

        RuntimeEnvironment.setQualifiers("+night");
        controller.configurationChange();
        assertSame("uiMode está em configChanges: a mesma tela e a mesma página", web, activity.webView());
        assertEquals("dark", engine.last());
        assertSame(web.getSettings(), engine.targets.get(engine.targets.size() - 1));
        assertEquals(0, shadowOf(web).getReloadInvocations());

        RuntimeEnvironment.setQualifiers("+notnight");
        controller.configurationChange();
        assertSame(web, activity.webView());
        assertEquals("light", engine.last());
    }

    @Test
    public void rotatingKeepsTheCurrentMode() {
        RuntimeEnvironment.setQualifiers("+night");
        launch();
        assertEquals("dark", engine.last());
        RuntimeEnvironment.setQualifiers("+land");
        controller.configurationChange();
        assertEquals("girar a tela não pode devolver a página ao tema claro", "dark", engine.last());
    }

    @Test
    @Config(qualifiers = "night")
    public void aPageRebuiltAfterTheRendererDiedAlsoLearnsTheMode() {
        if (Build.VERSION.SDK_INT < 26) return; // antes do Android 8 o WebView não avisa da morte do renderizador
        MainActivity activity = launch();
        WebView first = activity.webView();
        engine.calls.clear();
        engine.targets.clear();
        assertTrue(shadowOf(first).getWebViewClient().onRenderProcessGone(first, null));
        Fixtures.idle();
        WebView second = activity.webView();
        assertNotNull(second);
        assertTrue(second != first);
        assertEquals("dark", engine.last());
        assertSame(second.getSettings(), engine.targets.get(engine.targets.size() - 1));
    }

    @Test
    public void aConfigurationChangeWithoutAPageIsIgnored() {
        if (Build.VERSION.SDK_INT < 26) return;
        MainActivity activity = launch();
        controller.pause().stop();
        WebView first = activity.webView();
        assertTrue(shadowOf(first).getWebViewClient().onRenderProcessGone(first, null));
        Fixtures.idle();
        assertTrue("em segundo plano a página só é refeita na volta", activity.pageLost());
        engine.calls.clear();
        RuntimeEnvironment.setQualifiers("+night");
        controller.configurationChange();
        assertTrue(engine.calls.isEmpty());
        // na volta, a página nova nasce já no modo atual
        controller.start().resume();
        Fixtures.idle();
        assertNotNull(activity.webView());
        assertEquals("dark", engine.last());
    }
}
