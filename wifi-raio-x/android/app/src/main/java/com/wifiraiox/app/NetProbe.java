package com.wifiraiox.app;

import android.net.Network;

import java.io.IOException;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Locale;

/** Sondas de "tem alguém neste endereço?" que não dependem do programa ping. Nunca na thread da interface. */
final class NetProbe {

    private NetProbe() {}

    /**
     * InetAddress.isReachable: no Android tenta um eco ICMP e, se falhar, uma conexão TCP na porta 7.
     * Devolve o tempo em ms, ou -1 sem resposta.
     */
    static double reach(InetAddress address, int timeoutMs) {
        long t0 = System.nanoTime();
        try {
            if (address.isReachable(timeoutMs)) return elapsedMs(t0);
        } catch (IOException | RuntimeException ignored) {
            // sem rota, sem permissão de rede...
        }
        return -1;
    }

    /**
     * Tempo de uma conexão TCP. Porta fechada também conta: quem recusa a conexão está vivo, e o
     * tempo até a recusa é uma ida e volta na rede. `network` (opcional) prende o socket ao Wi-Fi,
     * para funcionar mesmo quando os dados móveis são a rede padrão.
     */
    static double tcp(InetAddress address, int port, int timeoutMs, Network network) {
        long t0 = System.nanoTime();
        Socket socket = new Socket();
        try {
            if (network != null) network.bindSocket(socket);
            socket.connect(new InetSocketAddress(address, port), timeoutMs);
            return elapsedMs(t0);
        } catch (ConnectException e) {
            String message = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
            return message.contains("refused") ? elapsedMs(t0) : -1;
        } catch (IOException | RuntimeException e) {
            return -1;
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // nada a fazer
            }
        }
    }

    private static double elapsedMs(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000.0;
    }
}
