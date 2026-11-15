package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** O texto que vai para evaluateJavascript tem de ser JavaScript válido com qualquer conteúdo. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class JsTest {

    private static final String NASTY = "linha\u2028separada\u2029aqui \"aspas\" \\barra\\ </script> 'simples' \n\t ção 日本 \uD83D\uDCF6";

    @Test
    public void escapeReplacesLineSeparatorsOnly() {
        assertEquals("a\\u2028b\\u2029c", Js.escape("a\u2028b\u2029c"));
        assertEquals("{\"a\":1}", Js.escape("{\"a\":1}"));
        assertEquals("null", Js.escape(null));
    }

    @Test
    public void androidJsonLeavesLineSeparatorsRaw() throws Exception {
        // É por isto que escape() existe: o org.json do Android não escapa U+2028/U+2029.
        String json = new JSONObject().put("s", "\u2028").toString();
        assertTrue(json.indexOf('\u2028') >= 0);
    }

    @Test
    public void resolveCarriesPayloadIntact() throws Exception {
        JSONObject payload = new JSONObject().put("ssid", NASTY).put("n", 3);
        String script = Js.resolve(17, payload.toString());
        assertFalse(script.indexOf('\u2028') >= 0);
        assertFalse(script.indexOf('\u2029') >= 0);
        String prefix = "window.__wrx&&window.__wrx.resolve&&window.__wrx.resolve(17,";
        assertTrue(script.startsWith(prefix));
        assertTrue(script.endsWith(")"));
        // O argumento continua sendo JSON e volta ao texto original, com os separadores e as aspas.
        JSONObject back = new JSONObject(script.substring(prefix.length(), script.length() - 1));
        assertEquals(NASTY, back.getString("ssid"));
        assertEquals(3, back.getInt("n"));
    }

    @Test
    public void emitQuotesEventNameAndGuardsMissingPage() throws Exception {
        String script = Js.emit("scan", new JSONObject().put("x", "\u2029\"").toString());
        assertTrue(script.startsWith("window.__wrx&&window.__wrx.emit&&window.__wrx.emit(\"scan\",{"));
        assertFalse(script.indexOf('\u2029') >= 0);
        // Um nome de evento malicioso não escapa da string.
        String odd = Js.emit("a\");alert(1);(\"\u2028", "{}");
        assertTrue(odd.contains("emit(\"a\\\");alert(1);(\\\"\\u2028\",{})"));
    }

    @Test
    public void backScriptIsTheContractExpression() {
        assertEquals("window.__wrx && window.__wrx.back ? window.__wrx.back() : false", Js.BACK_SCRIPT);
    }

    @Test
    public void errorJsonIsWellFormed() throws Exception {
        JSONObject e = new JSONObject(Json.error("falhou \"feio\"\u2028").toString());
        assertEquals("falhou \"feio\"\u2028", e.getString("error"));
        assertEquals("erro", new JSONObject(Json.error(null).toString()).getString("error"));
    }
}
