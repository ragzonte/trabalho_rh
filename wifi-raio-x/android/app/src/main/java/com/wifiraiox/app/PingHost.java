package com.wifiraiox.app;

/**
 * Validação do destino de um ping. O texto vem da página e acaba como argumento de um programa
 * (/system/bin/ping): só passa o que é claramente um IPv4, um IPv6 ou um nome de host, e nunca
 * algo que comece com '-' (seria lido como opção).
 */
final class PingHost {

    static final int MAX_LENGTH = 253;

    private PingHost() {}

    static boolean isValid(String host) {
        if (host == null) return false;
        int n = host.length();
        if (n == 0 || n > MAX_LENGTH) return false;
        if (host.charAt(0) == '-') return false;
        return isIpv4(host) || isIpv6(host) || isHostname(host);
    }

    static boolean isIpv4(String s) {
        return LanRange.parse(s) != 0 || "0.0.0.0".equals(s);
    }

    /** Dígitos hexadecimais, ':' e, no fim, um IPv4 embutido ou um escopo ("%wlan0"). */
    static boolean isIpv6(String s) {
        String address = s;
        int percent = s.indexOf('%');
        if (percent >= 0) {
            String scope = s.substring(percent + 1);
            if (scope.isEmpty() || scope.length() > 16) return false;
            for (int i = 0; i < scope.length(); i++) {
                if (!isAlnum(scope.charAt(i))) return false;
            }
            address = s.substring(0, percent);
        }
        if (address.length() < 2 || address.length() > 45) return false;
        int colons = 0;
        for (int i = 0; i < address.length(); i++) {
            char c = address.charAt(i);
            if (c == ':') colons++;
            else if (c != '.' && !isHex(c)) return false;
        }
        if (colons < 2 || colons > 7) return false;
        int lastColon = address.lastIndexOf(':');
        String tail = address.substring(lastColon + 1);
        if (tail.indexOf('.') >= 0) return LanRange.parse(tail) != 0 && address.indexOf('.') > lastColon;
        return address.indexOf('.') < 0;
    }

    /** Rótulos de letras, dígitos, '-' e '_' separados por ponto; nenhum começa ou termina com '-'. */
    static boolean isHostname(String s) {
        String name = s.endsWith(".") ? s.substring(0, s.length() - 1) : s;
        if (name.isEmpty()) return false;
        String[] labels = name.split("\\.", -1);
        for (String label : labels) {
            int n = label.length();
            if (n == 0 || n > 63) return false;
            if (label.charAt(0) == '-' || label.charAt(n - 1) == '-') return false;
            for (int i = 0; i < n; i++) {
                char c = label.charAt(i);
                if (!isAlnum(c) && c != '-' && c != '_') return false;
            }
        }
        // Só números e pontos que não formam um IPv4 ("1.2.3", "999.1.1.1") seriam lidos de formas
        // surpreendentes pelo ping; um nome de verdade nunca termina num rótulo numérico.
        String last = labels[labels.length - 1];
        boolean numeric = true;
        for (int i = 0; i < last.length(); i++) {
            if (last.charAt(i) < '0' || last.charAt(i) > '9') {
                numeric = false;
                break;
            }
        }
        return !numeric;
    }

    /** Só ASCII: Character.digit aceitaria também os algarismos de outros alfabetos (árabes, de largura cheia...). */
    static boolean isHex(char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }

    private static boolean isAlnum(char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }
}
