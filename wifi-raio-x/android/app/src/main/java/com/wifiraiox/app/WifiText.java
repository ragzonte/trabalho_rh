package com.wifiraiox.app;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Limpeza dos textos que o Android entrega sobre redes: SSID com aspas, sentinelas, MAC em maiúsculas. */
final class WifiText {

    /** O que o Android devolve quando não pode (ou não consegue) dizer o nome da rede. */
    static final String UNKNOWN_SSID = "<unknown ssid>";
    /** MAC de mentira que o Android devolve quando falta permissão. */
    static final String REDACTED_MAC = "02:00:00:00:00:00";
    private static final String ZERO_MAC = "00:00:00:00:00:00";

    private WifiText() {}

    /**
     * SSID de um resultado de varredura (campo ScanResult.SSID).
     * "" = rede oculta; null = o Android não conseguiu decodificar o nome.
     */
    static String scanSsid(String raw) {
        if (raw == null || raw.isEmpty() || allNul(raw)) return "";
        if (UNKNOWN_SSID.equals(raw)) return null;
        return unquote(raw);
    }

    /** SSID da conexão atual (WifiInfo.getSSID): null quando ausente, oculto pela falta de permissão ou vazio. */
    static String connectionSsid(String raw) {
        if (raw == null || raw.isEmpty() || UNKNOWN_SSID.equals(raw) || allNul(raw)) return null;
        if (raw.length() >= 2 && raw.charAt(0) == '"' && raw.charAt(raw.length() - 1) == '"') {
            String inner = raw.substring(1, raw.length() - 1);
            return inner.isEmpty() || allNul(inner) ? null : inner;
        }
        // Sem aspas = nome que não é UTF-8, em hexadecimal ("0x4a6f..." até o Android 12, só os dígitos depois).
        byte[] bytes = hexBytes(raw.startsWith("0x") ? raw.substring(2) : raw);
        if (bytes != null) {
            String text = fromBytes(bytes);
            return text.isEmpty() ? null : text;
        }
        return raw;
    }

    /** Nome a partir dos bytes crus: UTF-8 quando é válido, senão Latin-1 (roteadores antigos com acentos). */
    static String fromBytes(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return "";
        boolean zero = true;
        for (byte b : bytes) {
            if (b != 0) {
                zero = false;
                break;
            }
        }
        if (zero) return ""; // rede oculta anuncia o nome preenchido com zeros
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            return new String(bytes, StandardCharsets.ISO_8859_1);
        }
    }

    /** MAC em minúsculas; null quando ausente ou quando é um dos valores falsos do Android. */
    static String mac(String raw) {
        if (raw == null) return null;
        String m = raw.trim().toLowerCase(Locale.ROOT);
        if (m.isEmpty() || REDACTED_MAC.equals(m) || ZERO_MAC.equals(m)) return null;
        return m;
    }

    static String hex(byte[] bytes) {
        final char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[2 * i] = digits[(bytes[i] >> 4) & 0xF];
            out[2 * i + 1] = digits[bytes[i] & 0xF];
        }
        return new String(out);
    }

    private static String unquote(String s) {
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    private static boolean allNul(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) != 0) return false;
        }
        return true;
    }

    private static byte[] hexBytes(String s) {
        if (s.isEmpty() || (s.length() & 1) != 0) return null;
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16);
            int lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) return null;
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }
}
