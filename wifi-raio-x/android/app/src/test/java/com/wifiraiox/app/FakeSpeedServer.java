package com.wifiraiox.app;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Servidor HTTP mínimo, só para os testes, que imita o speed.cloudflare.com:
 * GET /__down?bytes=N devolve N bytes e POST /__up engole o corpo. Fala HTTP/1.1 com keep-alive.
 */
final class FakeSpeedServer implements Closeable {

    final AtomicLong served = new AtomicLong();
    final AtomicLong received = new AtomicLong();
    final AtomicInteger downRequests = new AtomicInteger(); // só os com corpo (os de latência pedem 0 bytes)
    final AtomicInteger upRequests = new AtomicInteger();
    /** Pausa depois de cada pedaço de 32 KB: simula uma rede lenta. */
    volatile long chunkPauseMs;
    volatile int downStatus = 200;
    volatile int upStatus = 200;

    private final ServerSocket socket;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile boolean closed;

    FakeSpeedServer() throws IOException {
        socket = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        pool.execute(() -> {
            while (!closed) {
                try {
                    final Socket client = socket.accept();
                    pool.execute(() -> serve(client));
                } catch (IOException e) {
                    return;
                }
            }
        });
    }

    String baseUrl() {
        return "http://127.0.0.1:" + socket.getLocalPort();
    }

    @Override
    public void close() {
        closed = true;
        try {
            socket.close();
        } catch (IOException ignored) {
            // já fechado
        }
        pool.shutdownNow();
    }

    private void serve(Socket client) {
        try (Socket s = client; InputStream in = s.getInputStream(); OutputStream out = s.getOutputStream()) {
            while (!closed) {
                String head = readHead(in);
                if (head == null) return;
                String[] lines = head.split("\r\n");
                String[] request = lines[0].split(" ");
                long length = 0;
                for (String line : lines) {
                    if (line.toLowerCase().startsWith("content-length:")) length = Long.parseLong(line.substring(15).trim());
                }
                if (request[1].startsWith("/__down")) {
                    long bytes = Long.parseLong(request[1].substring(request[1].indexOf("bytes=") + 6));
                    if (bytes > 0) downRequests.incrementAndGet();
                    if (downStatus != 200) {
                        respond(out, downStatus, 0);
                        continue;
                    }
                    respond(out, 200, bytes);
                    byte[] buf = new byte[32 * 1024];
                    for (long left = bytes; left > 0; ) {
                        int n = (int) Math.min(buf.length, left);
                        out.write(buf, 0, n);
                        served.addAndGet(n);
                        left -= n;
                        pause();
                    }
                    out.flush();
                } else if (request[1].startsWith("/__up")) {
                    upRequests.incrementAndGet();
                    byte[] buf = new byte[32 * 1024];
                    for (long left = length; left > 0; ) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                        if (n < 0) return;
                        received.addAndGet(n);
                        left -= n;
                        pause();
                    }
                    respond(out, upStatus, 0);
                } else {
                    respond(out, 404, 0);
                }
            }
        } catch (IOException | RuntimeException e) {
            // o cliente desistiu no meio: normal num teste de velocidade
        }
    }

    private static void respond(OutputStream out, int status, long length) throws IOException {
        String head = "HTTP/1.1 " + status + " X\r\n"
                + "Content-Length: " + length + "\r\n"
                + "cf-meta-colo: GRU\r\n"
                + "server-timing: cfRequestDuration;dur=0.01\r\n"
                + "Connection: keep-alive\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    /** Lê até a linha em branco que encerra os cabeçalhos; null quando o cliente fechou a conexão. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int b = in.read();
            if (b < 0) return null;
            head.write(b);
            if ((state % 2 == 0 && b == '\r') || (state % 2 == 1 && b == '\n')) state++;
            else state = b == '\r' ? 1 : 0;
        }
        return new String(head.toByteArray(), StandardCharsets.US_ASCII);
    }

    private void pause() {
        long ms = chunkPauseMs;
        if (ms <= 0) return;
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
