package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.net.Network;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowNetwork;

import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * O teste de velocidade contra o serviço DE VERDADE (speed.cloudflare.com), com poucos dados.
 * Só roda quando WRX_LIVE_SPEED=1 (o GitHub Actions liga): confirma que o serviço ainda responde
 * do jeito que o app espera, coisa que o servidor falso dos outros testes não tem como garantir.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class SpeedLiveTest {

    @Test
    public void realServiceAnswersAsTheAppExpects() throws Exception {
        assumeTrue("defina WRX_LIVE_SPEED=1 para testar contra a internet", "1".equals(System.getenv("WRX_LIVE_SPEED")));
        Network wifi = ShadowNetwork.newInstance(7);
        SpeedTester.Openers direct = network -> url -> (HttpURLConnection) url.openConnection();
        // Curto e leve: 2 s por direção, no máximo 8 MB de download e 3 MB de upload.
        SpeedTester.Plan small = new SpeedTester.Plan(2.0, 0.3, 8_000_000L, 3_000_000L, 4, 2, 2, 2_000_000L, 1_000_000L);
        List<JSONObject> events = Collections.synchronizedList(new ArrayList<>());

        JSONObject s = new SpeedTester(SpeedTester.BASE_URL, direct, small).run("light", wifi, events::add);

        System.out.println("teste de velocidade ao vivo: " + s);
        assertEquals(s.toString(), true, s.get("ok"));
        assertTrue("latência medida: " + s, s.getDouble("latencyMs") > 0);
        assertTrue("download medido: " + s, s.getDouble("downMbps") > 0.5);
        assertTrue("upload medido: " + s, s.getDouble("upMbps") > 0.2);
        assertTrue("bytes contados: " + s, s.getLong("bytesDown") > 100_000 && s.getLong("bytesUp") > 50_000);
        assertTrue("houve eventos de andamento", events.size() >= 3);
    }
}
