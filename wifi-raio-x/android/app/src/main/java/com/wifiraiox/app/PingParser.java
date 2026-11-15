package com.wifiraiox.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lê a saída do ping do Android, linha a linha. Dois dialetos existem por aí:
 *   iputils: "64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms"
 *   toybox:  "64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14 ms"
 * e as linhas de erro ("From 192.168.0.1 icmp_seq=2 Destination Host Unreachable") não têm tempo.
 */
final class PingParser {

    /** Uma linha que fala de um pacote: respondido (ok, ms) ou dado como perdido. */
    static final class Reply {
        final int seq;
        final boolean ok;
        final double ms;

        Reply(int seq, boolean ok, double ms) {
            this.seq = seq;
            this.ok = ok;
            this.ms = ms;
        }
    }

    // Versões antigas do iputils escreviam icmp_req em vez de icmp_seq.
    private static final Pattern SEQ = Pattern.compile("icmp_(?:seq|req)=(\\d{1,9})");
    private static final Pattern TIME = Pattern.compile("time[=<]\\s*(\\d+(?:[.,]\\d+)?)\\s*(ms|usec|us|s)?");
    private static final Pattern TRANSMITTED = Pattern.compile("(\\d{1,9}) packets transmitted");

    private PingParser() {}

    /** null quando a linha não é sobre um pacote (cabeçalho, estatísticas, linha vazia). */
    static Reply parseLine(String line) {
        if (line == null) return null;
        Matcher seq = SEQ.matcher(line);
        if (!seq.find()) return null;
        int n = Integer.parseInt(seq.group(1));
        Matcher time = TIME.matcher(line);
        if (!line.contains("bytes from") || !time.find()) return new Reply(n, false, -1);
        double value;
        try {
            value = Double.parseDouble(time.group(1).replace(',', '.'));
        } catch (NumberFormatException e) {
            return new Reply(n, false, -1);
        }
        String unit = time.group(2);
        if ("usec".equals(unit) || "us".equals(unit)) value /= 1000.0;
        else if ("s".equals(unit)) value *= 1000.0;
        return new Reply(n, true, value);
    }

    /** "10 packets transmitted, 9 received, ..." -> 10; -1 quando a linha não é o resumo. */
    static int parseTransmitted(String line) {
        if (line == null) return -1;
        Matcher m = TRANSMITTED.matcher(line);
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }
}
