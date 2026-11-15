package com.wifiraiox.app;

import android.net.wifi.ScanResult;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;

/** Converte ScanResult em ScanAp (contrato em app/js/bridge.js), sem interpretar nada. */
final class ScanMapper {

    /** Teto defensivo: uma lista maior que isto só pode ser erro do aparelho e travaria a página. */
    static final int MAX_APS = 400;
    /** Folga para um carimbo "no futuro" (o relógio é o mesmo; só entra o tempo de leitura). */
    static final long FUTURE_SLACK_MS = 5_000;
    /** Uma varredura completa leva poucos segundos: o resultado mais novo de uma lista nova não passa disto. */
    static final long FRESH_NEWEST_MAX_MS = 60_000;

    private ScanMapper() {}

    /** Lista lida do cache, sem saber quando foi a última varredura nova. */
    static JSONArray list(List<ScanResult> results, long nowElapsedMs) {
        return list(results, nowElapsedMs, false, Math.max(0, nowElapsedMs));
    }

    /**
     * @param fresh          a lista é de uma varredura que acabou de terminar
     * @param sinceFreshMs   há quanto tempo chegou a última lista nova (usado só quando os carimbos
     *                       de tempo do aparelho não merecem confiança, ver stampsLookRight)
     */
    static JSONArray list(List<ScanResult> results, long nowElapsedMs, boolean fresh, long sinceFreshMs) {
        JSONArray out = new JSONArray();
        if (results == null) return out;
        // Sem carimbos confiáveis a idade é a da lista: zero se acabou de ser varrida, senão a da última nova.
        boolean stamped = stampsLookRight(results, nowElapsedMs, fresh);
        long listAge = fresh ? 0 : Math.max(0, sinceFreshMs);
        List<ScanResult> src = unique(results);
        if (src.size() > MAX_APS) {
            // ficam as mais fortes
            src = new ArrayList<>(src);
            Collections.sort(src, (a, b) -> Integer.compare(b == null ? Integer.MIN_VALUE : b.level,
                    a == null ? Integer.MIN_VALUE : a.level));
            src = src.subList(0, MAX_APS);
        }
        for (ScanResult r : src) {
            try {
                if (r == null) continue;
                JSONObject ap = build(r, stamped ? ageMs(r.timestamp, nowElapsedMs) : listAge);
                if (ap != null) out.put(ap);
            } catch (RuntimeException | JSONException e) {
                // um resultado estragado não pode derrubar a lista inteira
            }
        }
        return out;
    }

    /**
     * Um ScanAp por BSSID, como o contrato diz. O Android até o 9 entrega a tabela do rádio como
     * ela está, e um roteador que acabou de trocar de canal aparece duas vezes (a leitura antiga
     * ainda não venceu): fica a ouvida por último e, no empate, a mais forte. A ordem da lista não muda.
     */
    static List<ScanResult> unique(List<ScanResult> results) {
        LinkedHashMap<String, ScanResult> byBssid = new LinkedHashMap<>();
        boolean repeated = false;
        for (ScanResult r : results) {
            if (r == null || r.BSSID == null || r.BSSID.isEmpty()) continue;
            String key = r.BSSID.toLowerCase(Locale.ROOT);
            ScanResult seen = byBssid.get(key);
            if (seen == null) {
                byBssid.put(key, r);
            } else {
                repeated = true;
                if (r.timestamp > seen.timestamp || (r.timestamp == seen.timestamp && r.level > seen.level)) {
                    byBssid.put(key, r); // mesma chave: o lugar na ordem continua o do primeiro
                }
            }
        }
        return repeated ? new ArrayList<>(byBssid.values()) : results;
    }

    static JSONObject one(ScanResult r, long nowElapsedMs) throws JSONException {
        return r == null ? null : build(r, ageMs(r.timestamp, nowElapsedMs));
    }

    private static JSONObject build(ScanResult r, long ageMs) throws JSONException {
        if (r.BSSID == null || r.BSSID.isEmpty()) return null;
        JSONObject o = new JSONObject();
        o.put("bssid", r.BSSID.toLowerCase(Locale.ROOT));
        o.put("ssid", ssid(r));
        o.put("level", r.level);
        o.put("frequency", r.frequency);
        o.put("channelWidth", r.channelWidth);
        o.put("centerFreq0", r.centerFreq0);
        o.put("centerFreq1", r.centerFreq1);
        o.put("capabilities", r.capabilities == null ? "" : r.capabilities);
        o.put("ageMs", ageMs);
        o.put("rttResponder", r.is80211mcResponder());
        o.put("passpoint", r.isPasspointNetwork());
        text(o, "venueName", r.venueName);
        text(o, "operatorName", r.operatorFriendlyName);
        if (Build.VERSION.SDK_INT >= 30) Api30.scanExtras(r, o);
        if (Build.VERSION.SDK_INT >= 33) Api33.scanExtras(r, o);
        return o;
    }

    /**
     * ScanResult.timestamp deveria ser "microssegundos desde o boot do celular", mas há aparelhos
     * (kernel antigo, driver sem o ajuste do Android) em que ele é o relógio interno de cada
     * roteador, e outros que o deixam zerado. As idades sairiam aleatórias: redes ouvidas agora
     * pareceriam ter horas e sumiriam do mapeamento. Dá para perceber sem adivinhar:
     *   - um carimbo adiantado em relação ao relógio do celular não pode ser tempo desde o boot;
     *   - nenhum resultado carimbado;
     *   - numa varredura nova, o resultado mais recente tem de ter sido ouvido agora há pouco.
     */
    static boolean stampsLookRight(List<ScanResult> results, long nowElapsedMs, boolean fresh) {
        long now = Math.max(0, nowElapsedMs);
        long newest = -1;
        boolean any = false;
        for (ScanResult r : results) {
            if (r == null) continue;
            any = true;
            if (r.timestamp <= 0) continue;
            long heardAt = r.timestamp / 1000;
            if (heardAt > now + FUTURE_SLACK_MS) return false;
            newest = Math.max(newest, heardAt);
        }
        if (!any) return true; // lista vazia: nada a decidir
        if (newest < 0) return false;
        return !(fresh && now - newest > FRESH_NEWEST_MAX_MS);
    }

    /** Nome da rede: "" quando oculta. */
    static String ssid(ScanResult r) {
        String s = null;
        if (Build.VERSION.SDK_INT >= 33) s = Api33.ssid(r);
        if (s == null) s = WifiText.scanSsid(r.SSID);
        // O Android antigo desiste de nomes que não são UTF-8; o beacon cru ainda tem os bytes.
        if (s == null && Build.VERSION.SDK_INT >= 30) s = Api30.ssidFromElements(r);
        return s == null ? "" : s;
    }

    /** ScanResult.timestamp vem em microssegundos desde o boot; valores absurdos são contidos em [0, agora]. */
    static long ageMs(long timestampMicros, long nowElapsedMs) {
        long now = Math.max(0, nowElapsedMs);
        if (timestampMicros <= 0) return now;
        long age = now - timestampMicros / 1000;
        if (age < 0) return 0;
        return Math.min(age, now);
    }

    private static void text(JSONObject o, String key, CharSequence value) throws JSONException {
        if (value == null) return;
        String s = value.toString().trim();
        if (!s.isEmpty()) o.put(key, s);
    }
}
