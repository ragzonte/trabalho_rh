package com.wifiraiox.app;

import org.json.JSONException;
import org.json.JSONObject;

/** Atalhos para montar e ler JSON sem espalhar try/catch pelo código. */
final class Json {

    private Json() {}

    /** Põe um valor; null e números não finitos são simplesmente omitidos. */
    static JSONObject put(JSONObject o, String key, Object value) {
        if (value == null) return o;
        if (value instanceof Double && (((Double) value).isNaN() || ((Double) value).isInfinite())) return o;
        if (value instanceof Float && (((Float) value).isNaN() || ((Float) value).isInfinite())) return o;
        try {
            o.put(key, value);
        } catch (JSONException ignored) {
            // só acontece com chave nula ou número inválido, já filtrados acima
        }
        return o;
    }

    static JSONObject ok() {
        return ok(true);
    }

    static JSONObject ok(boolean value) {
        return put(new JSONObject(), "ok", value);
    }

    static JSONObject error(String message) {
        return put(new JSONObject(), "error", message == null || message.isEmpty() ? "erro" : message);
    }

    /** Só devolve texto de verdade: número, objeto ou null viram null (optString inventaria "null"). */
    static String string(JSONObject o, String key) {
        Object v = o == null ? null : o.opt(key);
        return v instanceof String ? (String) v : null;
    }

    static double number(JSONObject o, String key, double fallback) {
        Object v = o == null ? null : o.opt(key);
        if (!(v instanceof Number)) return fallback;
        double d = ((Number) v).doubleValue();
        return Double.isNaN(d) || Double.isInfinite(d) ? fallback : d;
    }

    static boolean bool(JSONObject o, String key, boolean fallback) {
        Object v = o == null ? null : o.opt(key);
        return v instanceof Boolean ? (Boolean) v : fallback;
    }

    static int clamp(double value, int min, int max) {
        if (value < min) return min;
        if (value > max) return max;
        return (int) Math.round(value);
    }

    static double round(double value, int decimals) {
        double f = Math.pow(10, decimals);
        return Math.round(value * f) / f;
    }
}
