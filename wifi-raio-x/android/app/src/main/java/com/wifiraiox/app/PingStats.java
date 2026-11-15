package com.wifiraiox.app;

import org.json.JSONObject;

import java.util.List;

/** Contas do resumo de um ping (PingSummary do contrato). */
final class PingStats {

    private PingStats() {}

    /**
     * @param sent quantos pacotes foram enviados
     * @param rtts tempos (ms) das respostas, na ordem em que os pacotes foram enviados
     */
    static JSONObject summary(String host, String method, int sent, List<Double> rtts) {
        int received = rtts.size();
        int total = Math.max(sent, received);
        JSONObject o = new JSONObject();
        Json.put(o, "host", host);
        Json.put(o, "method", method);
        Json.put(o, "sent", total);
        Json.put(o, "received", received);
        Json.put(o, "lossPct", total == 0 ? 0 : Json.round(100.0 * (total - received) / total, 1));
        if (received > 0) {
            double min = Double.MAX_VALUE;
            double max = 0;
            double sum = 0;
            for (double v : rtts) {
                min = Math.min(min, v);
                max = Math.max(max, v);
                sum += v;
            }
            Json.put(o, "min", Json.round(min, 3));
            Json.put(o, "avg", Json.round(sum / received, 3));
            Json.put(o, "max", Json.round(max, 3));
        }
        if (received > 1) {
            // jitter = média das diferenças entre respostas seguidas
            double diff = 0;
            for (int i = 1; i < received; i++) diff += Math.abs(rtts.get(i) - rtts.get(i - 1));
            Json.put(o, "jitter", Json.round(diff / (received - 1), 3));
        }
        return o;
    }
}
