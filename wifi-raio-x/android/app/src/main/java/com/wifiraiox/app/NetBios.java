package com.wifiraiox.app;

import android.net.Network;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;

/**
 * Pergunta o nome de uma máquina pelo NetBIOS (consulta "node status", UDP 137). Computadores
 * com Windows, NAS e várias impressoras respondem mesmo quando o roteador não sabe o nome deles.
 */
final class NetBios {

    private static final int PORT = 137;
    private static final int NAME_ENTRY = 18;  // 15 de nome + 1 de tipo + 2 de flags
    private static final int GROUP_FLAG = 0x80;

    private NetBios() {}

    /** Nome da máquina, ou null (sem resposta dentro do prazo, resposta estranha...). Bloqueia até timeoutMs. */
    static String query(InetAddress address, int timeoutMs, Network network) {
        try (DatagramSocket socket = new DatagramSocket()) {
            if (network != null) network.bindSocket(socket);
            socket.setSoTimeout(timeoutMs);
            byte[] request = request();
            socket.send(new DatagramPacket(request, request.length, address, PORT));
            byte[] buffer = new byte[1024];
            DatagramPacket response = new DatagramPacket(buffer, buffer.length);
            socket.receive(response);
            if (!address.equals(response.getAddress())) return null;
            return parse(buffer, response.getLength());
        } catch (Exception e) {
            return null;
        }
    }

    /** Consulta NBSTAT pelo nome curinga "*". */
    static byte[] request() {
        byte[] p = new byte[50];
        p[0] = 0x57; // identificador da transação (qualquer valor)
        p[1] = 0x52;
        p[5] = 1;    // uma pergunta
        p[12] = 0x20; // nome de 32 caracteres: cada byte vira duas letras 'A'..'P'
        p[13] = 'C';  // '*' = 0x2A -> "CK"
        p[14] = 'K';
        for (int i = 15; i < 45; i++) p[i] = 'A'; // 15 zeros -> "AA"
        p[45] = 0;
        p[47] = 0x21; // tipo NBSTAT
        p[49] = 0x01; // classe IN
        return p;
    }

    /** Primeiro nome único do tipo 0x00 (estação de trabalho) da tabela devolvida. */
    static String parse(byte[] data, int length) {
        if (data == null || length < 12 || length > data.length) return null;
        if ((data[2] & 0x80) == 0) return null; // não é resposta
        int pos = 12;
        // nome da pergunta repetido: rótulos até o zero (ou um ponteiro de compressão)
        while (pos < length) {
            int len = data[pos] & 0xFF;
            if (len == 0) {
                pos++;
                break;
            }
            if ((len & 0xC0) == 0xC0) {
                pos += 2;
                break;
            }
            pos += len + 1;
        }
        pos += 10; // tipo, classe, TTL e tamanho dos dados
        if (pos >= length) return null;
        int names = data[pos++] & 0xFF;
        for (int i = 0; i < names; i++) {
            int at = pos + i * NAME_ENTRY;
            if (at + NAME_ENTRY > length) return null;
            int type = data[at + 15] & 0xFF;
            int flags = data[at + 16] & 0xFF;
            if (type != 0x00 || (flags & GROUP_FLAG) != 0) continue;
            String name = clean(new String(data, at, 15, StandardCharsets.US_ASCII));
            if (name != null) return name;
        }
        return null;
    }

    /** Só caracteres imprimíveis; nomes vazios ou curingas não servem. */
    private static String clean(String raw) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c >= 0x21 && c < 0x7F) sb.append(c);
            else if (c == ' ' && sb.length() > 0) sb.append(c);
        }
        String name = sb.toString().trim();
        return name.isEmpty() || name.startsWith("*") ? null : name;
    }
}
