package com.wifiraiox.app;

import static org.robolectric.util.reflector.Reflector.reflector;

import android.app.Activity;

import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.util.reflector.Direct;
import org.robolectric.util.reflector.ForType;

/**
 * O Robolectric troca Activity.onBackPressed() por um simples finish(). Com esta variante roda o
 * código de verdade de cada versão do Android, que é onde mora o problema do Android 7: ali o
 * "voltar" lança IllegalStateException se o estado da tela já foi salvo.
 * Ativar com @Config(shadows = RealBackActivity.class), só até o Android 9: nas versões seguintes
 * o caminho de verdade consulta serviços do sistema que não existem no teste.
 */
@Implements(Activity.class)
public class RealBackActivity extends ShadowActivity {

    @ForType(Activity.class)
    interface RealActivity {
        @Direct
        void onBackPressed();
    }

    @Implementation
    @Override
    protected void onBackPressed() {
        reflector(RealActivity.class, realActivity).onBackPressed();
    }
}
