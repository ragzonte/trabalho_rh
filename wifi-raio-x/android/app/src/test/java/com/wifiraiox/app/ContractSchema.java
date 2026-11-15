package com.wifiraiox.app;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * O contrato de app/js/bridge.js escrito como esquema: cada typedef (ScanAp, Status, Connection...)
 * e cada linha da tabela de métodos vira um conferidor que recebe o JSON que o lado nativo mandou
 * e devolve a lista de problemas (vazia = dentro do contrato).
 *
 * Confere o que o cabeçalho de bridge.js promete: nome exato dos campos (campo desconhecido é
 * erro), tipo JSON (número x texto x booleano), obrigatório x opcional, opcional AUSENTE em vez
 * de null, MAC em minúsculas, listas nunca nulas, unidades plausíveis e as regras que cruzam
 * campos (canScan, ms só com ok, estatísticas só com respostas...). É o par, em Java, de
 * tests/helpers/contract.mjs, que confere o simulador.
 */
final class ContractSchema {

    private ContractSchema() {}

    interface Check {
        void check(Object value, String path, List<String> out);
    }

    interface Rule {
        void check(JSONObject value, String path, List<String> out) throws JSONException;
    }

    static final Pattern BSSID = Pattern.compile("^[0-9a-f]{2}(:[0-9a-f]{2}){5}$");
    private static final Pattern MAC_ANY = Pattern.compile("^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$");
    private static final Pattern HEX = Pattern.compile("^([0-9a-fA-F]{2})*$");
    private static final Pattern CAPABILITIES = Pattern.compile("^(\\[[^\\[\\]]+\\])*$");
    private static final Pattern IPV4 = Pattern.compile("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$");
    private static final Pattern IPV6 = Pattern.compile("^[0-9a-fA-F:.]+$");
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;

    // ------------------------------------------------------------------ peças

    private static String show(Object v) {
        if (v == null) return "ausente";
        if (v == JSONObject.NULL) return "null";
        String s = String.valueOf(v);
        return v.getClass().getSimpleName() + " " + (s.length() > 60 ? s.substring(0, 60) + "…" : s);
    }

    private static boolean isInteger(Object v) {
        if (v instanceof Integer || v instanceof Long) return true;
        if (v instanceof Double) {
            double d = (Double) v;
            return !Double.isNaN(d) && !Double.isInfinite(d) && d == Math.rint(d);
        }
        return false;
    }

    static final Check BOOL = (v, path, out) -> {
        if (!(v instanceof Boolean)) out.add(path + ": esperava boolean, veio " + show(v));
    };

    static Check number(final double min, final double max) {
        return (v, path, out) -> {
            if (!(v instanceof Number)) {
                out.add(path + ": esperava um número, veio " + show(v));
                return;
            }
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) out.add(path + ": número não finito");
            else if (d < min || d > max) out.add(path + ": " + d + " fora da faixa " + min + ".." + max);
        };
    }

    static Check integer(final long min, final long max) {
        return (v, path, out) -> {
            if (!isInteger(v)) {
                out.add(path + ": esperava um inteiro, veio " + show(v));
                return;
            }
            long n = ((Number) v).longValue();
            if (n < min || n > max) out.add(path + ": " + n + " fora da faixa " + min + ".." + max);
        };
    }

    static final Check STRING = (v, path, out) -> {
        if (!(v instanceof String)) out.add(path + ": esperava texto, veio " + show(v));
    };

    static final Check NON_EMPTY = (v, path, out) -> {
        if (!(v instanceof String)) out.add(path + ": esperava texto, veio " + show(v));
        else if (((String) v).isEmpty()) out.add(path + ": texto vazio");
    };

    static Check matching(final Pattern pattern, final String what) {
        return (v, path, out) -> {
            if (!(v instanceof String)) out.add(path + ": esperava texto, veio " + show(v));
            else if (!pattern.matcher((String) v).matches()) out.add(path + ": " + show(v) + " não é " + what);
        };
    }

    static Check oneOf(final Object... values) {
        final Set<Object> allowed = new HashSet<>();
        for (Object o : values) allowed.add(o instanceof Integer ? (Object) Long.valueOf((Integer) o) : o);
        return (v, path, out) -> {
            Object key = isInteger(v) ? (Object) Long.valueOf(((Number) v).longValue()) : v;
            if (!allowed.contains(key)) out.add(path + ": " + show(v) + " não é um de " + Arrays.toString(values));
        };
    }

    static Check list(final Check item) {
        return (v, path, out) -> {
            if (!(v instanceof JSONArray)) {
                out.add(path + ": esperava uma lista, veio " + show(v));
                return;
            }
            JSONArray a = (JSONArray) v;
            for (int i = 0; i < a.length(); i++) item.check(a.opt(i), path + "[" + i + "]", out);
        };
    }

    /** Só para os campos que o contrato declara como "X | null". */
    private static final class Nullable implements Check {
        final Check inner;

        Nullable(Check inner) {
            this.inner = inner;
        }

        @Override
        public void check(Object v, String path, List<String> out) {
            if (v != JSONObject.NULL) inner.check(v, path, out);
        }
    }

    private static final class Field {
        final String name;
        final boolean required;
        final Check check;

        Field(String name, boolean required, Check check) {
            this.name = name;
            this.required = required;
            this.check = check;
        }
    }

    private static Field req(String name, Check check) {
        return new Field(name, true, check);
    }

    private static Field opt(String name, Check check) {
        return new Field(name, false, check);
    }

    /** Objeto só com campos conhecidos; as regras cruzadas rodam quando os campos em si estão certos. */
    static Check shape(final Field[] fields, final Rule... rules) {
        final Map<String, Field> byName = new LinkedHashMap<>();
        for (Field f : fields) byName.put(f.name, f);
        return (v, path, out) -> {
            if (!(v instanceof JSONObject)) {
                out.add(path + ": esperava um objeto, veio " + show(v));
                return;
            }
            JSONObject o = (JSONObject) v;
            int before = out.size();
            for (Field f : byName.values()) {
                if (!o.has(f.name)) {
                    if (f.required) out.add(path + "." + f.name + ": campo obrigatório ausente");
                    continue;
                }
                Object value = o.opt(f.name);
                if (value == JSONObject.NULL && !(f.check instanceof Nullable)) {
                    out.add(path + "." + f.name + ": veio null; campo "
                            + (f.required ? "obrigatório precisa de valor" : "opcional sem valor tem de ficar AUSENTE"));
                    continue;
                }
                f.check.check(value, path + "." + f.name, out);
            }
            for (Iterator<String> it = o.keys(); it.hasNext();) {
                String key = it.next();
                if (!byName.containsKey(key)) out.add(path + "." + key + ": campo fora do contrato");
            }
            if (out.size() != before) return;
            for (Rule rule : rules) {
                try {
                    rule.check(o, path, out);
                } catch (JSONException e) {
                    out.add(path + ": " + e.getMessage());
                }
            }
        };
    }

    private static Field[] fields(Field... fields) {
        return fields;
    }

    private static boolean isIpv4(String s) {
        java.util.regex.Matcher m = IPV4.matcher(s);
        if (!m.matches()) return false;
        for (int i = 1; i <= 4; i++) {
            String part = m.group(i);
            if (Integer.parseInt(part) > 255 || !String.valueOf(Integer.parseInt(part)).equals(part)) return false;
        }
        return true;
    }

    /** IPv6 sem escopo ("%wlan0"): o contrato manda o endereço limpo. */
    private static boolean isIpv6(String s) {
        if (!IPV6.matcher(s).matches() || s.indexOf(':') < 0) return false;
        int doubles = s.split("::", -1).length - 1;
        if (doubles > 1) return false;
        int groups = 0;
        for (String g : s.split(":")) {
            if (g.isEmpty()) continue;
            if (!g.matches("[0-9a-fA-F]{1,4}") && !isIpv4(g)) return false;
            groups++;
        }
        return doubles == 1 ? groups <= 7 : groups == 8;
    }

    private static final Check IP4 = (v, path, out) -> {
        if (!(v instanceof String) || !isIpv4((String) v)) out.add(path + ": " + show(v) + " não é um endereço IPv4");
    };
    private static final Check IP6 = (v, path, out) -> {
        if (!(v instanceof String) || !isIpv6((String) v)) out.add(path + ": " + show(v) + " não é um endereço IPv6 (sem escopo)");
    };
    private static final Check IP_ANY = (v, path, out) -> {
        if (!(v instanceof String) || !(isIpv4((String) v) || isIpv6((String) v))) out.add(path + ": " + show(v) + " não é um endereço IP");
    };
    private static final Check SSID = (v, path, out) -> {
        if (!(v instanceof String)) out.add(path + ": esperava texto, veio " + show(v));
        else if (((String) v).getBytes(StandardCharsets.UTF_8).length > 64) out.add(path + ": SSID longo demais");
        else if (((String) v).startsWith("\"") && ((String) v).endsWith("\"") && ((String) v).length() >= 2) {
            out.add(path + ": o nome veio com as aspas do Android");
        } else if ("<unknown ssid>".equals(v)) out.add(path + ": sentinela do Android no lugar do nome");
    };
    private static final Check MAC = matching(BSSID, "um MAC minúsculo aa:bb:cc:dd:ee:ff");
    private static final Check REAL_MAC = (v, path, out) -> {
        MAC.check(v, path, out);
        if ("02:00:00:00:00:00".equals(v) || "00:00:00:00:00:00".equals(v)) out.add(path + ": MAC de mentira do Android");
    };
    private static final Check TIMESTAMP = integer(1_500_000_000_000L, 8_640_000_000_000_000L); // ms desde 1970
    private static final Check DBM = integer(-126, -1);
    private static final Check MBPS = integer(1, 100_000);
    private static final Check MHZ = integer(2400, 71_000);

    private static boolean isWifiFrequency(long f) {
        return (f >= 2400 && f <= 2500) || (f >= 5150 && f <= 5900) || (f >= 5925 && f <= 7125) || (f >= 57_000 && f <= 71_000);
    }

    // ------------------------------------------------------------------ typedefs de bridge.js

    static final Check RAW_IE = shape(fields(
            req("id", integer(0, 255)),
            req("ext", integer(0, 255)),
            req("hex", matching(HEX, "hexadecimal com número par de dígitos"))),
            (ie, path, out) -> {
                if (ie.getString("hex").length() > 510) out.add(path + ".hex: mais de 255 bytes");
                if (ie.getInt("ext") != 0 && ie.getInt("id") != 255) out.add(path + ".ext: só faz sentido quando id = 255");
            });

    static final Check SCAN_AP = shape(fields(
            req("bssid", REAL_MAC),
            req("ssid", SSID),
            req("level", integer(-150, 50)),
            req("frequency", integer(0, 71_000)),
            req("channelWidth", oneOf(-1, 0, 1, 2, 3, 4, 5)),
            req("centerFreq0", integer(0, 71_000)),
            req("centerFreq1", integer(0, 71_000)),
            req("capabilities", matching(CAPABILITIES, "blocos entre colchetes")),
            req("ageMs", integer(0, Long.MAX_VALUE)),
            opt("wifiStandard", oneOf(0, 1, 4, 5, 6, 7, 8)),
            opt("rttResponder", BOOL),
            opt("passpoint", BOOL),
            opt("venueName", NON_EMPTY),
            opt("operatorName", NON_EMPTY),
            opt("mld", MAC),
            opt("ies", list(RAW_IE))),
            (ap, path, out) -> {
                if (ap.has("ies") && ap.getJSONArray("ies").length() == 0) out.add(path + ".ies: lista vazia tem de ficar ausente");
            });

    static final Check SCAN_EVENT = shape(fields(
            req("ts", TIMESTAMP),
            req("fresh", BOOL),
            req("source", oneOf("request", "system", "cache")),
            req("aps", list(SCAN_AP))),
            (ev, path, out) -> {
                if (ev.getBoolean("fresh") && "cache".equals(ev.getString("source"))) out.add(path + ": fresh = true com source = 'cache'");
                Set<String> seen = new HashSet<>();
                JSONArray aps = ev.getJSONArray("aps");
                for (int i = 0; i < aps.length(); i++) {
                    String bssid = aps.getJSONObject(i).getString("bssid");
                    if (!seen.add(bssid)) out.add(path + ".aps: BSSID repetido " + bssid);
                }
            });

    static final Check LAST_SCAN = (v, path, out) -> {
        SCAN_EVENT.check(v, path, out);
        if (v instanceof JSONObject && (((JSONObject) v).optBoolean("fresh", true) || !"cache".equals(((JSONObject) v).optString("source")))) {
            out.add(path + ": lastScan devolve source = 'cache' e fresh = false");
        }
    };

    static final Check DEVICE_INFO = shape(fields(
            req("platform", oneOf("android")),
            req("sdk", integer(24, 1000)),
            req("release", STRING),
            req("manufacturer", STRING),
            req("model", STRING),
            req("appVersion", NON_EMPTY),
            req("bands", shape(fields(req("b24", BOOL), req("b5", BOOL), req("b6", BOOL), req("b60", BOOL)))),
            req("standards", list(oneOf(0, 1, 4, 5, 6, 7, 8))),
            req("rtt", BOOL)));

    static final Check STATUS = shape(fields(
            req("wifiEnabled", BOOL),
            req("locationEnabled", BOOL),
            req("permission", oneOf("granted", "denied", "blocked")),
            req("throttled", new Nullable(BOOL)),
            req("canScan", BOOL)),
            (s, path, out) -> {
                boolean expected = s.getBoolean("wifiEnabled") && s.getBoolean("locationEnabled") && "granted".equals(s.getString("permission"));
                if (s.getBoolean("canScan") != expected) out.add(path + ".canScan: não bate com wifiEnabled && locationEnabled && permission === 'granted'");
            });

    static final Check CONNECTION = shape(fields(
            req("connected", BOOL),
            opt("ssid", (v, path, out) -> {
                SSID.check(v, path, out);
                if ("".equals(v)) out.add(path + ": nome vazio tem de ficar ausente");
            }),
            opt("bssid", REAL_MAC),
            opt("rssi", DBM),
            opt("frequency", MHZ),
            opt("linkSpeed", MBPS),
            opt("txSpeed", MBPS),
            opt("rxSpeed", MBPS),
            opt("maxTxSpeed", MBPS),
            opt("maxRxSpeed", MBPS),
            opt("wifiStandard", oneOf(0, 1, 4, 5, 6, 7, 8)),
            opt("securityType", integer(-1, 13)),
            opt("hidden", BOOL),
            opt("ip", IP4),
            opt("prefix", integer(0, 32)),
            opt("gateway", IP4),
            opt("dns", list(IP_ANY)),
            opt("ipv6", list(IP6)),
            opt("iface", NON_EMPTY),
            opt("mtu", integer(1, 65_535)),
            opt("leaseSec", integer(1, Integer.MAX_VALUE)),
            opt("validated", BOOL),
            opt("metered", BOOL)),
            (c, path, out) -> {
                if (c.has("frequency") && !isWifiFrequency(c.getLong("frequency"))) out.add(path + ".frequency: não é uma frequência de Wi-Fi");
                if (!c.getBoolean("connected") && c.length() != 1) out.add(path + ": desconectado só traz connected = false");
                for (String listKey : new String[] {"dns", "ipv6"}) {
                    if (c.has(listKey) && c.getJSONArray(listKey).length() == 0) out.add(path + "." + listKey + ": lista vazia tem de ficar ausente");
                }
                if (c.has("prefix") && !c.has("ip")) out.add(path + ".prefix: sem o ip a que pertence");
            });

    static final Check RSSI_SAMPLE = shape(fields(
            req("ts", TIMESTAMP),
            req("rssi", DBM),
            req("bssid", (v, path, out) -> {
                if (!"".equals(v)) REAL_MAC.check(v, path, out); // "" = o Android escondeu (falta permissão)
            }),
            req("frequency", integer(0, 71_000)),
            opt("linkSpeed", MBPS),
            opt("txSpeed", MBPS),
            opt("rxSpeed", MBPS)),
            (s, path, out) -> {
                long f = s.getLong("frequency");
                if (f != 0 && !isWifiFrequency(f)) out.add(path + ".frequency: não é 0 nem uma frequência de Wi-Fi");
            });

    static final Check RTT_RESULT = shape(fields(
            req("bssid", MAC),
            req("ok", BOOL),
            opt("distM", number(-10, 1000)),
            opt("stdM", number(0, 1000)),
            opt("rssi", integer(-127, 0)),
            opt("attempts", integer(0, 1000)),
            opt("successes", integer(0, 1000))),
            (r, path, out) -> {
                boolean ok = r.getBoolean("ok");
                if (ok && !r.has("distM")) out.add(path + ".distM: ausente numa medição com ok = true");
                if (!ok && r.length() != 2) out.add(path + ": medição que falhou só traz bssid e ok");
                if (r.has("successes") && r.has("attempts") && r.getInt("successes") > r.getInt("attempts")) out.add(path + ".successes: maior do que attempts");
            });

    static final Check RTT_ANSWER = shape(fields(req("results", list(RTT_RESULT))), (r, path, out) -> {
        Set<String> seen = new HashSet<>();
        JSONArray results = r.getJSONArray("results");
        for (int i = 0; i < results.length(); i++) {
            if (!seen.add(results.getJSONObject(i).getString("bssid"))) out.add(path + ".results: BSSID repetido");
        }
    });

    static final Check PING_REPLY = shape(fields(
            req("host", NON_EMPTY),
            req("seq", integer(1, 1_000_000)),
            req("ok", BOOL),
            opt("ms", number(0, 600_000))),
            (r, path, out) -> {
                if (r.getBoolean("ok") != r.has("ms")) out.add(path + ".ms: presente só (e sempre) quando ok = true");
            });

    static final Check PING_SUMMARY = shape(fields(
            req("host", NON_EMPTY),
            req("method", oneOf("icmp", "tcp")),
            req("sent", integer(0, 1_000_000)),
            req("received", integer(0, 1_000_000)),
            req("lossPct", number(0, 100)),
            opt("min", number(0, 600_000)),
            opt("avg", number(0, 600_000)),
            opt("max", number(0, 600_000)),
            opt("jitter", number(0, 600_000))),
            (s, path, out) -> {
                int sent = s.getInt("sent");
                int received = s.getInt("received");
                if (received > sent) out.add(path + ".received: maior do que sent");
                double loss = sent == 0 ? 0 : 100.0 * (sent - received) / sent;
                if (Math.abs(s.getDouble("lossPct") - loss) > 0.051) out.add(path + ".lossPct: não bate com sent/received");
                boolean stats = s.has("min") && s.has("avg") && s.has("max");
                boolean anyStat = s.has("min") || s.has("avg") || s.has("max");
                if (received == 0 && (anyStat || s.has("jitter"))) out.add(path + ": estatísticas sem nenhuma resposta");
                if (received > 0 && !stats) out.add(path + ": com respostas, min, avg e max vêm juntos");
                if (s.has("jitter") != (received > 1)) out.add(path + ".jitter: presente só com duas respostas ou mais");
                if (stats && !(s.getDouble("min") <= s.getDouble("avg") + 0.001 && s.getDouble("avg") <= s.getDouble("max") + 0.001)) {
                    out.add(path + ": esperava min <= avg <= max");
                }
            });

    static final Check LAN_DEVICE = shape(fields(
            req("ip", IP4),
            opt("host", NON_EMPTY),
            opt("mac", (v, path, out) -> {
                if (!(v instanceof String) || !MAC_ANY.matcher((String) v).matches()) out.add(path + ": " + show(v) + " não é um MAC");
                else if (!((String) v).equals(((String) v).toLowerCase(java.util.Locale.ROOT))) out.add(path + ": MAC com maiúsculas");
            }),
            opt("ms", number(0, 600_000)),
            opt("self", oneOf(true)),
            opt("gateway", oneOf(true))));

    static final Check LAN_ANSWER = shape(fields(req("devices", list(LAN_DEVICE))), (r, path, out) -> {
        Set<String> ips = new HashSet<>();
        int self = 0;
        int gateway = 0;
        JSONArray devices = r.getJSONArray("devices");
        for (int i = 0; i < devices.length(); i++) {
            JSONObject d = devices.getJSONObject(i);
            if (!ips.add(d.getString("ip"))) out.add(path + ".devices: IP repetido " + d.getString("ip"));
            if (d.has("self")) self++;
            if (d.has("gateway")) gateway++;
        }
        if (self > 1) out.add(path + ".devices: mais de um aparelho marcado como self");
        if (gateway > 1) out.add(path + ".devices: mais de um aparelho marcado como gateway");
    });

    static final Check LAN_PROGRESS = shape(fields(
            req("done", integer(0, 16_777_216)),
            req("total", integer(0, 16_777_216))),
            (p, path, out) -> {
                if (p.getInt("done") > p.getInt("total")) out.add(path + ".done: maior do que total");
            });

    static final Check SPEED_PROGRESS = shape(fields(
            req("phase", oneOf("latency", "download", "upload")),
            req("progress", number(0, 1)),
            opt("mbps", number(0, 100_000)),
            opt("ms", number(0, 600_000)),
            req("bytes", integer(0, MAX_SAFE_INTEGER))),
            (p, path, out) -> {
                boolean latency = "latency".equals(p.getString("phase"));
                if (latency && p.has("mbps")) out.add(path + ".mbps: só existe nas fases de download e upload");
                if (!latency && p.has("ms")) out.add(path + ".ms: só existe na fase de latência");
                if (!latency && !p.has("mbps")) out.add(path + ".mbps: ausente numa fase de transferência");
            });

    static final Check SPEED_SUMMARY = shape(fields(
            req("ok", BOOL),
            opt("error", oneOf("offline", "cancelled", "failed")),
            opt("latencyMs", number(0, 600_000)),
            opt("jitterMs", number(0, 600_000)),
            opt("downMbps", number(0, 100_000)),
            opt("upMbps", number(0, 100_000)),
            req("bytesDown", integer(0, MAX_SAFE_INTEGER)),
            req("bytesUp", integer(0, MAX_SAFE_INTEGER)),
            opt("server", NON_EMPTY)),
            (r, path, out) -> {
                boolean ok = r.getBoolean("ok");
                if (ok == r.has("error")) out.add(path + ".error: presente só (e sempre) quando ok = false");
                if (ok && !(r.has("downMbps") && r.has("upMbps") && r.has("latencyMs"))) out.add(path + ": teste que deu certo sem as medidas");
                if (!ok && (r.has("downMbps") || r.has("upMbps") || r.has("latencyMs") || r.has("server"))) out.add(path + ": teste que falhou não traz medidas");
            });

    static final Check OK_TRUE = shape(fields(req("ok", oneOf(true))));
    static final Check OK_ANY = shape(fields(req("ok", BOOL)));

    static final Check SCAN_ANSWER = shape(fields(
            req("accepted", BOOL),
            opt("reason", oneOf("no-permission", "location-off", "wifi-off", "throttled", "failed"))),
            (r, path, out) -> {
                if (r.getBoolean("accepted") == r.has("reason")) out.add(path + ".reason: presente só (e sempre) numa recusa");
            });

    /** Falha de qualquer método: {error:"..."} e mais nada. */
    static final Check ERROR = shape(fields(req("error", NON_EMPTY)));

    // ------------------------------------------------------------------ tabela dos métodos e eventos

    /** Método -> forma da resposta, na ordem da tabela de bridge.js. */
    static final Map<String, Check> RESULTS = new LinkedHashMap<>();
    /** Os que respondem depois (callAsync). */
    static final Set<String> ASYNC = new HashSet<>(Arrays.asList("requestPermission", "scan", "rtt", "ping", "lanScan", "speedTest"));
    /** Evento -> forma dos dados. */
    static final Map<String, Check> EVENTS = new LinkedHashMap<>();

    static {
        RESULTS.put("info", DEVICE_INFO);
        RESULTS.put("status", STATUS);
        RESULTS.put("lastScan", LAST_SCAN);
        RESULTS.put("connection", CONNECTION);
        RESULTS.put("watchRssi", OK_TRUE);
        RESULTS.put("unwatchRssi", OK_TRUE);
        RESULTS.put("openSettings", OK_ANY);
        RESULTS.put("keepAwake", OK_TRUE);
        RESULTS.put("vibrate", OK_TRUE);
        RESULTS.put("setBars", OK_TRUE);
        RESULTS.put("share", OK_ANY);
        RESULTS.put("saveFile", OK_ANY);
        RESULTS.put("cancel", OK_TRUE);
        RESULTS.put("requestPermission", STATUS);
        RESULTS.put("scan", SCAN_ANSWER);
        RESULTS.put("rtt", RTT_ANSWER);
        RESULTS.put("ping", PING_SUMMARY);
        RESULTS.put("lanScan", LAN_ANSWER);
        RESULTS.put("speedTest", SPEED_SUMMARY);

        EVENTS.put("scan", SCAN_EVENT);
        EVENTS.put("rssi", RSSI_SAMPLE);
        EVENTS.put("status", STATUS);
        EVENTS.put("connection", CONNECTION);
        EVENTS.put("ping", PING_REPLY);
        EVENTS.put("lan", LAN_DEVICE);
        EVENTS.put("lanProgress", LAN_PROGRESS);
        EVENTS.put("speed", SPEED_PROGRESS);
    }

    // ------------------------------------------------------------------ uso

    private static List<String> run(Check check, String json, String label) {
        List<String> out = new ArrayList<>();
        if (json == null) {
            out.add(label + ": resposta nula");
            return out;
        }
        Object value;
        try {
            value = new JSONObject(json);
        } catch (JSONException e) {
            out.add(label + ": não é um objeto JSON (" + json + ")");
            return out;
        }
        if (json.contains("NaN") && json.matches(".*[:\\[,]\\s*-?(NaN|Infinity).*")) out.add(label + ": NaN/Infinity não existem em JSON");
        check.check(value, label, out);
        return out;
    }

    /** Problemas da resposta (bem-sucedida) de um método. */
    static List<String> checkResult(String method, String json) {
        Check check = RESULTS.get(method);
        if (check == null) return new ArrayList<>(Arrays.asList("método fora do contrato: " + method));
        return run(check, json, method + "()");
    }

    static List<String> checkEvent(String name, String json) {
        Check check = EVENTS.get(name);
        if (check == null) return new ArrayList<>(Arrays.asList("evento fora do contrato: " + name));
        return run(check, json, "evento '" + name + "'");
    }

    static List<String> checkError(String json) {
        return run(ERROR, json, "erro");
    }

    static void assertResult(String method, String json) {
        raise(checkResult(method, json), json);
    }

    static void assertEvent(String name, String json) {
        raise(checkEvent(name, json), json);
    }

    static void assertError(String json) {
        raise(checkError(json), json);
    }

    private static void raise(List<String> problems, String json) {
        if (problems.isEmpty()) return;
        StringBuilder sb = new StringBuilder("fora do contrato da ponte:");
        for (String p : problems) sb.append("\n  - ").append(p);
        sb.append("\n  valor: ").append(json != null && json.length() > 900 ? json.substring(0, 900) + "…" : json);
        throw new AssertionError(sb.toString());
    }
}
