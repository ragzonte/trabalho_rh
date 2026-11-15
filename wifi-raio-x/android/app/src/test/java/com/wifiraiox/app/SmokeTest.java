package com.wifiraiox.app;

import static org.junit.Assert.assertNotNull;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** A tela abre em cada geração do Android que o app aceita. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {24, 26, 28, 29, 30, 31, 33, 34})
public class SmokeTest {
    @Test
    public void activityStarts() {
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertNotNull(activity);
    }
}
