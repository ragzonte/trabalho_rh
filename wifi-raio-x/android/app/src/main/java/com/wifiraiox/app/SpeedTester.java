package com.wifiraiox.app;

import android.net.Network;

import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Teste de velocidade da internet pelo Wi-Fi: latência, download e upload contra o serviço
 * público speed.cloudflare.com (GET /__down?bytes=N devolve N bytes; POST /__up recebe o que vier).
 *
 * Só roda com Wi-Fi conectado e preso a essa rede: assim mede o Wi-Fi mesmo quando os dados
 * móveis são a rede padrão do celular, e nunca gasta a franquia do chip por engano.
 */
final class SpeedTester {

    interface Events {
        void onProgress(JSONObject speedProgress);
    }

    /** Abre uma conexão HTTP para a URL. */
    interface Opener {
        HttpURLConnection open(URL url) throws IOException;
    }

    /** Como abrir conexões por uma rede específica (nos testes: um servidor local). */
    interface Openers {
        Opener through(Network network);
    }

    static final String BASE_URL = "https://speed.cloudflare.com";
    static final String MODE_FULL = "full";
    static final String MODE_LIGHT = "light";
    static final String ERR_OFFLINE = "offline";
    static final String ERR_CANCELLED = "cancelled";
    static final String ERR_FAILED = "failed";

    private static final long TICK_MS = 200;       // o evento 'speed' sai 5 vezes por segundo
    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 5000;
    private static final int PROBE_BYTES = 640;    // estimativa do vaivém de cabeçalhos de uma medida de latência
    private static final int MAX_STREAM_FAILURES = 2;

    /** Tamanho e duração de cada modo. */
    static final class Plan {
        final double phaseS;     // duração de cada direção
        final double rampS;      // arrancada do TCP, fora da média final
        final long downCap;      // teto de bytes (o modo leve para cedo para poupar dados)
        final long upCap;
        final int probes;        // medidas de latência
        final int downStreams;   // conexões em paralelo
        final int upStreams;
        final long downChunk;    // bytes pedidos por requisição
        final long upChunk;

        Plan(double phaseS, double rampS, long downCap, long upCap, int probes,
             int downStreams, int upStreams, long downChunk, long upChunk) {
            this.phaseS = phaseS;
            this.rampS = rampS;
            this.downCap = downCap;
            this.upCap = upCap;
            this.probes = probes;
            this.downStreams = downStreams;
            this.upStreams = upStreams;
            this.downChunk = downChunk;
            this.upChunk = upChunk;
        }

        static Plan of(String mode) {
            if (MODE_LIGHT.equals(mode)) {
                return new Plan(3, 0.4, 25_000_000L, 10_000_000L, 5, 2, 2, 5_000_000L, 2_000_000L);
            }
            return new Plan(8, 1.0, Long.MAX_VALUE, Long.MAX_VALUE, 8, 4, 3, 25_000_000L, 10_000_000L);
        }
    }

    static boolean validMode(String mode) {
        return MODE_FULL.equals(mode) || MODE_LIGHT.equals(mode);
    }

    private final String baseUrl;
    private final Openers openers;
    private final Plan fixedPlan; // só nos testes: troca os tempos dos dois modos
    private Job current;

    SpeedTester() {
        this(BASE_URL, network -> url -> (HttpURLConnection) network.openConnection(url), null);
    }

    SpeedTester(String baseUrl, Openers openers, Plan fixedPlan) {
        this.baseUrl = baseUrl;
        this.openers = openers;
        this.fixedPlan = fixedPlan;
    }

    /** Interrompe o teste em andamento; quem o pediu recebe {ok:false, error:'cancelled'}. */
    void cancel() {
        Job job;
        synchronized (this) {
            job = current;
        }
        if (job != null) job.cancel();
    }

    /**
     * Executa o teste (bloqueia: chamar numa thread de trabalho) e devolve o SpeedSummary.
     *
     * @param wifi a rede Wi-Fi em uso; null = fora do Wi-Fi, o teste não roda ('offline')
     */
    JSONObject run(String mode, Network wifi, Events events) {
        Plan plan = fixedPlan != null ? fixedPlan : Plan.of(mode);
        Job job = new Job();
        Job previous;
        synchronized (this) {
            previous = current;
            current = job;
        }
        if (previous != null) previous.cancel(); // um teste por vez
        job.attach(Thread.currentThread());
        long[] down = {0};
        long[] up = {0};
        try {
            if (wifi == null) throw new Abort(ERR_OFFLINE);
            Opener opener = openers.through(wifi);
            if (opener == null) throw new Abort(ERR_OFFLINE);

            List<Double> times = latency(job, plan, opener, events);
            double downMbps = transfer(job, plan, opener, events, true, down);
            double upMbps = transfer(job, plan, opener, events, false, up);

            JSONObject o = new JSONObject();
            Json.put(o, "ok", true);
            Json.put(o, "latencyMs", Json.round(median(times), 1));
            Json.put(o, "jitterMs", Json.round(jitter(times), 1));
            Json.put(o, "downMbps", Json.round(downMbps, 2));
            Json.put(o, "upMbps", Json.round(upMbps, 2));
            Json.put(o, "bytesDown", down[0]);
            Json.put(o, "bytesUp", up[0]);
            Json.put(o, "server", job.server);
            return o;
        } catch (Abort a) {
            JSONObject o = new JSONObject();
            Json.put(o, "ok", false);
            Json.put(o, "error", job.cancelled ? ERR_CANCELLED : a.error);
            Json.put(o, "bytesDown", down[0]);
            Json.put(o, "bytesUp", up[0]);
            return o;
        } finally {
            job.detach();
            job.closeAll();
            synchronized (this) {
                if (current == job) current = null;
            }
        }
    }

    // ------------------------------------------------------------------ latência

    private List<Double> latency(Job job, Plan plan, Opener opener, Events events) throws Abort {
        try {
            probe(job, opener); // aquecimento: resolve o nome e abre a conexão segura; não entra na conta
        } catch (IOException | RuntimeException e) {
            throw new Abort(job.cancelled ? ERR_CANCELLED : classify(e));
        }
        List<Double> times = new ArrayList<>();
        for (int k = 1; k <= plan.probes; k++) {
            if (job.cancelled) throw new Abort(ERR_CANCELLED);
            double ms = -1;
            try {
                ms = probe(job, opener);
                times.add(ms);
            } catch (IOException | RuntimeException e) {
                if (job.cancelled) throw new Abort(ERR_CANCELLED);
                // uma medida perdida não invalida o teste
            }
            JSONObject o = new JSONObject();
            Json.put(o, "phase", "latency");
            Json.put(o, "progress", Json.round(k / (double) plan.probes, 3));
            if (ms >= 0) Json.put(o, "ms", Json.round(ms, 1));
            Json.put(o, "bytes", (long) k * PROBE_BYTES);
            events.onProgress(o);
        }
        if (times.isEmpty()) throw new Abort(ERR_FAILED);
        return times;
    }

    /** Uma requisição mínima; devolve o tempo de ida e volta em ms. */
    private double probe(Job job, Opener opener) throws IOException {
        long t0 = System.nanoTime();
        HttpURLConnection c = opener.open(new URL(baseUrl + "/__down?bytes=0"));
        job.open.add(c);
        try {
            configure(c);
            int code = c.getResponseCode();
            drain(code < 400 ? c.getInputStream() : c.getErrorStream());
            double ms = (System.nanoTime() - t0) / 1_000_000.0;
            if (code != 200) throw new IOException("HTTP " + code);
            if (job.server == null) job.server = serverOf(c);
            double serverMs = serverTime(c.getHeaderField("server-timing"));
            return serverMs > 0 && serverMs < ms ? ms - serverMs : ms; // desconta o tempo gasto dentro do servidor
        } catch (IOException | RuntimeException e) {
            c.disconnect();
            throw e;
        } finally {
            job.open.remove(c);
        }
    }

    /** Sigla do datacenter que atendeu (ex.: "GRU"), pelos cabeçalhos da Cloudflare. */
    static String serverOf(HttpURLConnection c) {
        String colo = c.getHeaderField("cf-meta-colo");
        if (colo == null || colo.trim().isEmpty()) {
            String ray = c.getHeaderField("cf-ray"); // "8c1f0a2b3c4d5e6f-GRU"
            int dash = ray == null ? -1 : ray.lastIndexOf('-');
            colo = dash >= 0 ? ray.substring(dash + 1) : null;
        }
        if (colo == null) return null;
        colo = colo.trim();
        return colo.matches("[A-Za-z0-9]{2,8}") ? colo.toUpperCase(java.util.Locale.ROOT) : null;
    }

    /** "cfRequestDuration;dur=1.23" -> 1.23; -1 quando ausente. */
    static double serverTime(String header) {
        if (header == null) return -1;
        int at = header.indexOf("dur=");
        if (at < 0) return -1;
        int end = at + 4;
        while (end < header.length() && (Character.isDigit(header.charAt(end)) || header.charAt(end) == '.')) end++;
        try {
            return Double.parseDouble(header.substring(at + 4, end));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    // ------------------------------------------------------------------ download e upload

    private static final class Phase {
        final long cap;
        final AtomicLong bytes = new AtomicLong();
        final AtomicInteger alive = new AtomicInteger();
        volatile boolean stop;
        volatile Throwable error;

        Phase(long cap) {
            this.cap = cap;
        }

        boolean over(Job job) {
            return stop || job.cancelled || bytes.get() >= cap;
        }
    }

    /** Uma direção do teste. Devolve Mb/s (média do trecho estável) e deixa em total[0] os bytes trafegados. */
    private double transfer(final Job job, final Plan plan, final Opener opener, Events events,
                            final boolean download, long[] total) throws Abort {
        final Phase phase = new Phase(download ? plan.downCap : plan.upCap);
        int streams = download ? plan.downStreams : plan.upStreams;
        phase.alive.set(streams);
        Thread[] workers = new Thread[streams];
        for (int i = 0; i < streams; i++) {
            workers[i] = new Thread(() -> {
                try {
                    if (download) downloadLoop(job, phase, opener, plan.downChunk);
                    else uploadLoop(job, phase, opener, plan.upChunk);
                } finally {
                    phase.alive.decrementAndGet();
                }
            }, "wrx-speed-" + (download ? "down-" : "up-") + i);
            workers[i].setDaemon(true);
            workers[i].start();
        }

        final long t0 = System.nanoTime();
        long lastT = t0;
        long lastBytes = 0;
        long bytes = 0;
        long steadyT = 0;
        long steadyBytes = -1;
        double average = 0;
        double elapsed = 0;
        boolean streamsDied = false;
        try {
            for (int k = 0; ; k++) {
                try {
                    Thread.sleep(TICK_MS);
                } catch (InterruptedException e) {
                    throw new Abort(ERR_CANCELLED);
                }
                if (job.cancelled) throw new Abort(ERR_CANCELLED);
                long now = System.nanoTime();
                bytes = phase.bytes.get();
                elapsed = (now - t0) / 1e9;
                double dt = (now - lastT) / 1e9;
                double instant = dt > 0 ? (bytes - lastBytes) * 8 / 1e6 / dt : 0;
                average = k == 0 ? instant : 0.6 * average + 0.4 * instant; // média móvel: o número na tela não treme
                lastT = now;
                lastBytes = bytes;
                if (steadyBytes < 0 && elapsed >= plan.rampS) {
                    steadyBytes = bytes;
                    steadyT = now;
                }
                streamsDied = phase.alive.get() == 0 && bytes < phase.cap;
                boolean finished = elapsed >= plan.phaseS || bytes >= phase.cap || streamsDied;
                double byCap = phase.cap == Long.MAX_VALUE ? 0 : bytes / (double) phase.cap;
                JSONObject o = new JSONObject();
                Json.put(o, "phase", download ? "download" : "upload");
                Json.put(o, "progress", finished ? 1 : Json.round(Math.min(1, Math.max(elapsed / plan.phaseS, byCap)), 3));
                Json.put(o, "mbps", Json.round(average, 2));
                Json.put(o, "bytes", bytes);
                events.onProgress(o);
                if (finished) break;
            }
        } finally {
            phase.stop = true;
            job.closeAll(); // solta quem está parado numa leitura ou escrita
            for (Thread w : workers) {
                try {
                    w.join(300);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            total[0] = phase.bytes.get();
        }
        // Todas as conexões caíram antes da hora: o número não mede nada.
        if (bytes == 0 || (streamsDied && phase.error != null && elapsed < plan.phaseS - 0.25)) {
            throw new Abort(phase.error == null ? ERR_FAILED : classify(phase.error));
        }
        double steadyS = (lastT - steadyT) / 1e9;
        if (steadyBytes >= 0 && steadyS >= 0.3) return (bytes - steadyBytes) * 8 / 1e6 / steadyS;
        return elapsed > 0 ? bytes * 8 / 1e6 / elapsed : 0; // teste curto demais para separar a arrancada
    }

    private void downloadLoop(Job job, Phase phase, Opener opener, long chunk) {
        byte[] buffer = new byte[64 * 1024];
        int failures = 0;
        while (!phase.over(job)) {
            HttpURLConnection c = null;
            boolean reusable = false;
            try {
                c = opener.open(new URL(baseUrl + "/__down?bytes=" + chunk));
                job.open.add(c);
                configure(c);
                int code = c.getResponseCode();
                if (code != 200) throw new IOException("HTTP " + code);
                try (InputStream in = c.getInputStream()) {
                    int n;
                    boolean cut = false;
                    while ((n = in.read(buffer)) > 0) {
                        phase.bytes.addAndGet(n);
                        if (phase.over(job)) {
                            cut = true;
                            break;
                        }
                    }
                    reusable = !cut;
                }
                failures = 0;
            } catch (IOException | RuntimeException e) {
                if (phase.over(job)) return;
                phase.error = e;
                if (++failures >= MAX_STREAM_FAILURES) return;
            } finally {
                if (c != null) {
                    job.open.remove(c);
                    if (!reusable) c.disconnect(); // resposta lida pela metade: a conexão não serve mais
                }
            }
        }
    }

    private void uploadLoop(Job job, Phase phase, Opener opener, long chunk) {
        byte[] payload = new byte[16 * 1024];
        new Random(0x57495246).nextBytes(payload); // bytes sem padrão: nada no caminho consegue compactar
        int failures = 0;
        while (!phase.over(job)) {
            HttpURLConnection c = null;
            boolean reusable = false;
            try {
                c = opener.open(new URL(baseUrl + "/__up"));
                job.open.add(c);
                configure(c);
                c.setDoOutput(true);
                c.setRequestMethod("POST");
                c.setRequestProperty("Content-Type", "application/octet-stream");
                c.setFixedLengthStreamingMode(chunk); // sem isto o corpo inteiro seria guardado na memória antes de sair
                OutputStream out = c.getOutputStream();
                long left = chunk;
                while (left > 0 && !phase.over(job)) {
                    int n = (int) Math.min(payload.length, left);
                    out.write(payload, 0, n);
                    phase.bytes.addAndGet(n);
                    left -= n;
                }
                if (left > 0) return; // interrompido no meio do envio: o finally derruba a conexão
                out.close();
                int code = c.getResponseCode();
                drain(code < 400 ? c.getInputStream() : c.getErrorStream());
                if (code / 100 != 2) throw new IOException("HTTP " + code);
                reusable = true;
                failures = 0;
            } catch (IOException | RuntimeException e) {
                if (phase.over(job)) return;
                phase.error = e;
                if (++failures >= MAX_STREAM_FAILURES) return;
            } finally {
                if (c != null) {
                    job.open.remove(c);
                    if (!reusable) c.disconnect();
                }
            }
        }
    }

    // ------------------------------------------------------------------ apoio

    private static void configure(HttpURLConnection c) {
        c.setConnectTimeout(CONNECT_TIMEOUT_MS);
        c.setReadTimeout(READ_TIMEOUT_MS);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        // Sem compactação: o que se conta são os bytes que cruzaram a rede.
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Cache-Control", "no-store");
    }

    private static void drain(InputStream in) throws IOException {
        if (in == null) return;
        try {
            byte[] sink = new byte[4096];
            while (in.read(sink) > 0) {
                // descarta
            }
        } finally {
            in.close();
        }
    }

    /** Sem rota, sem DNS, sem resposta = sem internet; o resto é falha do teste. */
    static String classify(Throwable e) {
        if (e instanceof UnknownHostException || e instanceof ConnectException
                || e instanceof NoRouteToHostException || e instanceof SocketTimeoutException) {
            return ERR_OFFLINE;
        }
        return ERR_FAILED;
    }

    static double median(List<Double> values) {
        List<Double> sorted = new ArrayList<>(values);
        Collections.sort(sorted);
        return sorted.get(sorted.size() / 2);
    }

    /** Média das diferenças entre medidas seguidas. */
    static double jitter(List<Double> values) {
        if (values.size() < 2) return 0;
        double sum = 0;
        for (int i = 1; i < values.size(); i++) sum += Math.abs(values.get(i) - values.get(i - 1));
        return sum / (values.size() - 1);
    }

    private static final class Abort extends Exception {
        final String error;

        Abort(String error) {
            super(error, null, false, false);
            this.error = error;
        }
    }

    private static final class Job {
        final Set<HttpURLConnection> open = ConcurrentHashMap.newKeySet();
        volatile boolean cancelled;
        volatile String server;
        private Thread runner; // com o lock do Job

        synchronized void attach(Thread thread) {
            runner = thread;
        }

        /** Acorda quem conduz o teste (pode estar dormindo entre duas medidas) e derruba as conexões. */
        synchronized void cancel() {
            cancelled = true;
            closeAll();
            if (runner != null) runner.interrupt();
        }

        /**
         * Fim do teste: daqui em diante ninguém mais interrompe a thread, e ela volta limpa para
         * o pool (sem isto um cancelamento atrasado poderia interromper a próxima tarefa dela).
         */
        synchronized void detach() {
            runner = null;
            Thread.interrupted();
        }

        void closeAll() {
            for (HttpURLConnection c : open) {
                try {
                    c.disconnect();
                } catch (RuntimeException ignored) {
                    // já fechada
                }
            }
        }
    }
}
