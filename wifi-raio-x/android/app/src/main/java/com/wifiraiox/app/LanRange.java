package com.wifiraiox.app;

/** Contas de endereço IPv4 para a varredura da rede local. Endereços são inteiros big-endian (a.b.c.d). */
final class LanRange {

    /** Sub-redes maiores que /22 (mais de 1022 aparelhos) são varridas só no /24 em volta do celular. */
    static final int WIDEST_PREFIX = 22;

    private LanRange() {}

    /** Só redes privadas (RFC 1918): não se varre a rede de uma operadora ou a internet. */
    static boolean isPrivate(int ip) {
        int a = (ip >>> 24) & 0xFF;
        int b = (ip >>> 16) & 0xFF;
        return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
    }

    /** O prefixo realmente varrido para a máscara informada. */
    static int effectivePrefix(int prefix) {
        if (prefix < WIDEST_PREFIX || prefix > 32) return 24;
        return prefix;
    }

    /**
     * Endereços a sondar (inclui o do próprio celular), em ordem crescente, sem o endereço de rede
     * e o de broadcast. Vazio para endereços não privados e para enlaces ponto a ponto (/31, /32).
     */
    static int[] hosts(int ip, int prefix) {
        if (!isPrivate(ip)) return new int[0];
        int p = effectivePrefix(prefix);
        if (p >= 31) return new int[0];
        int mask = -1 << (32 - p);
        int network = ip & mask;
        int broadcast = network | ~mask;
        int count = broadcast - network - 1;
        int[] out = new int[count];
        for (int i = 0; i < count; i++) out[i] = network + 1 + i;
        return out;
    }

    /** O endereço pertence à sub-rede (ip/prefix) declarada pela máscara de verdade? */
    static boolean sameSubnet(int ip, int prefix, int other) {
        if (prefix <= 0) return true;
        if (prefix >= 32) return ip == other;
        int mask = -1 << (32 - prefix);
        return (ip & mask) == (other & mask);
    }

    static int toInt(byte[] b) {
        if (b == null || b.length != 4) return 0;
        return ((b[0] & 0xFF) << 24) | ((b[1] & 0xFF) << 16) | ((b[2] & 0xFF) << 8) | (b[3] & 0xFF);
    }

    static byte[] toBytes(int ip) {
        return new byte[] {(byte) (ip >>> 24), (byte) (ip >>> 16), (byte) (ip >>> 8), (byte) ip};
    }

    static String format(int ip) {
        return ((ip >>> 24) & 0xFF) + "." + ((ip >>> 16) & 0xFF) + "." + ((ip >>> 8) & 0xFF) + "." + (ip & 0xFF);
    }

    /** "192.168.0.10" -> inteiro; 0 quando não é um IPv4 escrito por extenso. */
    static int parse(String dotted) {
        if (dotted == null) return 0;
        String[] parts = dotted.split("\\.", -1);
        if (parts.length != 4) return 0;
        int out = 0;
        for (String part : parts) {
            if (part.isEmpty() || part.length() > 3) return 0;
            int v = 0;
            for (int i = 0; i < part.length(); i++) {
                char c = part.charAt(i);
                if (c < '0' || c > '9') return 0;
                v = v * 10 + (c - '0');
            }
            if (v > 255) return 0;
            out = (out << 8) | v;
        }
        return out;
    }
}
