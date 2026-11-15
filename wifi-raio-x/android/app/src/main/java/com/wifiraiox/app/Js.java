package com.wifiraiox.app;

import org.json.JSONObject;

/** Monta os trechos de JavaScript que o lado nativo executa na página. */
final class Js {

    /** Pergunta à página se ela tratou o "voltar"; só o literal true conta como sim. */
    static final String BACK_SCRIPT =
            "window.__wrx && window.__wrx.back ? window.__wrx.back() : false";

    private Js() {}

    /**
     * JSON é quase JavaScript: U+2028 e U+2029 são válidos dentro de uma string JSON, mas
     * encerram a linha num programa JS antigo. Como só aparecem dentro de strings, trocar
     * pelo escape é sempre seguro.
     */
    static String escape(String json) {
        if (json == null) return "null";
        if (json.indexOf(' ') < 0 && json.indexOf(' ') < 0) return json;
        StringBuilder sb = new StringBuilder(json.length() + 16);
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == ' ') sb.append("\\u2028");
            else if (c == ' ') sb.append("\\u2029");
            else sb.append(c);
        }
        return sb.toString();
    }

    /** Resposta de um callAsync. Antes de a página carregar, não faz nada (e não lança). */
    static String resolve(int id, String json) {
        return "window.__wrx&&window.__wrx.resolve&&window.__wrx.resolve(" + id + "," + escape(json) + ")";
    }

    /** Evento para a página. */
    static String emit(String name, String json) {
        return "window.__wrx&&window.__wrx.emit&&window.__wrx.emit("
                + escape(JSONObject.quote(name)) + "," + escape(json) + ")";
    }
}
