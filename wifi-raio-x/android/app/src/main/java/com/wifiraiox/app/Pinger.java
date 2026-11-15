package com.wifiraiox.app;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Ping. Usa o programa /system/bin/ping do Android (um processo para a série toda, lido linha a
 * linha) e, se ele não existir ou ninguém responder ao ICMP, mede o tempo de uma conexão TCP.
 *
 * O destino nunca passa por um shell: o nome é resolvido aqui e o programa recebe o endereço
 * numérico como um argumento isolado.
 */
final class Pinger {

    interface Events {
        void onReply(JSONObject reply);
    }

    interface Resolver {
        InetAddress resolve(String host) throws Exception;
    }

    /** Sonda alternativa ao ICMP: tempo em ms, ou -1 sem resposta. Não lança. */
    interface Prober {
        double probe(InetAddress address, int timeoutMs);
    }

    static final int MIN_COUNT = 1;
    static final int MAX_COUNT = 50;
    static final int MIN_TIMEOUT_MS = 200;
    static final int MAX_TIMEOUT_MS = 5000;
    /** 0,2 s é o menor intervalo que o ping aceita de quem não é root. */
    static final String INTERVAL_ARG = "0.2";
    static final long INTERVAL_MS = 200;
    private static final long DNS_TIMEOUT_MS = 5000;
    /** Sem ICMP e sem resposta nenhuma: não vale insistir a série inteira. */
    private static final int FALLBACK_GIVE_UP = 3;

    static final String ERR_INVALID_HOST = "host inválido";
    static final String ERR_UNKNOWN_HOST = "host não encontrado";

    private final String ping4;
    private final String ping6;
    private final Resolver resolver;
    private final Prober[] probers;
    private final ScheduledExecutorService watchdog;
    private Job current;

    private static final class Job {
        volatile boolean cancelled;
        volatile Process process;

        void cancel() {
            cancelled = true;
            Process p = process;
            if (p != null) p.destroy();
        }
    }

    private static final class Outcome {
        final TreeMap<Integer, Double> replies = new TreeMap<>(); // seq -> ms
        final TreeSet<Integer> failed = new TreeSet<>();          // seq sem resposta
        int sent;
        int exit = -1;
    }

    /** Configuração de verdade: os programas do sistema e as sondas TCP. */
    Pinger(ScheduledExecutorService watchdog) {
        this("/system/bin/ping", "/system/bin/ping6", Pinger::resolveBounded, defaultProbers(), watchdog);
    }

    Pinger(String ping4, String ping6, Resolver resolver, Prober[] probers, ScheduledExecutorService watchdog) {
        this.ping4 = ping4;
        this.ping6 = ping6;
        this.resolver = resolver;
        this.probers = probers;
        this.watchdog = watchdog;
    }

    private static Prober[] defaultProbers() {
        return new Prober[] {
            NetProbe::reach,
            (address, timeoutMs) -> NetProbe.tcp(address, 443, timeoutMs, null),
            (address, timeoutMs) -> NetProbe.tcp(address, 80, timeoutMs, null),
            (address, timeoutMs) -> NetProbe.tcp(address, 53, timeoutMs, null),
        };
    }

    /** Interrompe o ping em andamento; quem o pediu recebe o resumo parcial. */
    void cancel() {
        Job job;
        synchronized (this) {
            job = current;
        }
        if (job != null) job.cancel();
    }

    /**
     * Executa a série (bloqueia: chamar numa thread de trabalho). Emite um PingReply por pacote e
     * devolve o PingSummary, ou {error} quando o destino é inválido ou não resolve.
     */
    JSONObject run(String host, int count, int timeoutMs, Events events) {
        if (!PingHost.isValid(host)) return Json.error(ERR_INVALID_HOST);
        count = Math.max(MIN_COUNT, Math.min(MAX_COUNT, count));
        timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeoutMs));

        Job job = new Job();
        Job previous;
        synchronized (this) {
            previous = current;
            current = job;
        }
        if (previous != null) previous.cancel(); // um ping por vez
        try {
            InetAddress address;
            try {
                address = resolver.resolve(host);
            } catch (Exception e) {
                return Json.error(ERR_UNKNOWN_HOST);
            }
            if (address == null) return Json.error(ERR_UNKNOWN_HOST);
            if (job.cancelled) return PingStats.summary(host, "icmp", 0, new ArrayList<>());

            Outcome icmp = icmp(job, host, address, count, timeoutMs, events);
            boolean icmpAnswered = icmp != null && (!icmp.replies.isEmpty() || icmp.exit == 0);
            if (icmpAnswered || job.cancelled) {
                return finish(host, "icmp", icmp == null ? new Outcome() : icmp, events);
            }
            // O programa não rodou, ou rodou e ninguém respondeu (muito roteador descarta ICMP).
            Outcome tcp = fallback(job, host, address, count, timeoutMs, events);
            if (!tcp.replies.isEmpty() || icmp == null) return finish(host, "tcp", tcp, events);
            return finish(host, "icmp", icmp, events);
        } finally {
            synchronized (this) {
                if (current == job) current = null;
            }
        }
    }

    /** Avisa os pacotes sem resposta (só agora: uma resposta atrasada ainda podia chegar) e fecha a conta. */
    private static JSONObject finish(String host, String method, Outcome o, Events events) {
        for (int seq = 1; seq <= o.sent; seq++) {
            if (!o.replies.containsKey(seq)) events.onReply(reply(host, seq, false, -1));
        }
        return PingStats.summary(host, method, o.sent, new ArrayList<>(o.replies.values()));
    }

    /** null quando o programa não pôde ser executado. */
    private Outcome icmp(Job job, String host, InetAddress address, int count, int timeoutMs, Events events) {
        String binary = address instanceof Inet6Address && ping6 != null && new File(ping6).canExecute() ? ping6 : ping4;
        if (binary == null) return null;
        int waitSec = Math.max(1, (int) Math.ceil(timeoutMs / 1000.0)); // o ping antigo só aceita segundos inteiros
        long deadlineMs = count * INTERVAL_MS + waitSec * 1000L + 3000L;
        // Só opções que os dois dialetos (iputils e toybox) entendem. Sem "-w": com ele o iputils
        // deixa de parar em "count" enviados e segue transmitindo até receber "count" respostas.
        List<String> command = Arrays.asList(binary,
                "-c", String.valueOf(count),
                "-i", INTERVAL_ARG,
                "-W", String.valueOf(waitSec),
                address.getHostAddress());
        final Process process;
        try {
            process = new ProcessBuilder(command).redirectErrorStream(true).start();
        } catch (IOException | RuntimeException e) {
            return null;
        }
        job.process = process;
        if (job.cancelled) process.destroy();
        // Rede de segurança: um ping travado não pode prender a thread (e a promessa da página) para sempre.
        ScheduledFuture<?> guard = null;
        try {
            guard = watchdog.schedule(process::destroy, deadlineMs, TimeUnit.MILLISECONDS);
        } catch (RuntimeException ignored) {
            // app encerrando
        }

        Outcome o = new Outcome();
        int transmitted = -1;
        int maxSeq = 0;
        Boolean zeroBased = null;
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                PingParser.Reply r = PingParser.parseLine(line);
                if (r == null) {
                    int t = PingParser.parseTransmitted(line);
                    if (t >= 0) transmitted = t;
                    continue;
                }
                if (zeroBased == null) zeroBased = r.seq == 0; // alguns pings contam a partir de 0
                int seq = r.seq + (zeroBased ? 1 : 0);
                if (seq < 1 || seq > MAX_COUNT) continue;
                maxSeq = Math.max(maxSeq, seq);
                if (r.ok && !o.replies.containsKey(seq)) { // respostas duplicadas (DUP!) contam uma vez
                    o.replies.put(seq, r.ms);
                    events.onReply(reply(host, seq, true, r.ms));
                }
            }
        } catch (IOException ignored) {
            // processo encerrado no meio (cancelamento)
        }
        try {
            o.exit = process.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (guard != null) guard.cancel(false);
        process.destroy();
        job.process = null;

        if (transmitted >= 0) o.sent = Math.max(transmitted, maxSeq);
        else o.sent = job.cancelled ? maxSeq : Math.max(count, maxSeq); // morto antes do resumo
        return o;
    }

    private Outcome fallback(Job job, String host, InetAddress address, int count, int timeoutMs, Events events) {
        Outcome o = new Outcome();
        Prober chosen = null;
        int misses = 0;
        for (int seq = 1; seq <= count && !job.cancelled; seq++) {
            double ms = -1;
            if (chosen != null) {
                ms = chosen.probe(address, timeoutMs);
            } else {
                // Na primeira rodada descobre qual sonda este destino responde; depois fica nela.
                Prober[] candidates = seq == 1 ? probers : new Prober[] {probers[0]};
                for (Prober p : candidates) {
                    if (job.cancelled) break;
                    ms = p.probe(address, timeoutMs);
                    if (ms >= 0) {
                        chosen = p;
                        break;
                    }
                }
            }
            if (job.cancelled && ms < 0) break;
            o.sent = seq;
            if (ms >= 0) {
                misses = 0;
                o.replies.put(seq, ms);
                events.onReply(reply(host, seq, true, ms));
            } else if (++misses >= FALLBACK_GIVE_UP && o.replies.isEmpty()) {
                break;
            }
            if (seq < count && !pause(job)) break;
        }
        return o;
    }

    /** false quando cancelado durante a espera. */
    private static boolean pause(Job job) {
        try {
            Thread.sleep(INTERVAL_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            job.cancelled = true;
        }
        return !job.cancelled;
    }

    static JSONObject reply(String host, int seq, boolean ok, double ms) {
        JSONObject o = new JSONObject();
        Json.put(o, "host", host);
        Json.put(o, "seq", seq);
        Json.put(o, "ok", ok);
        if (ok && ms >= 0) Json.put(o, "ms", Json.round(ms, 3));
        return o;
    }

    /** Resolve o nome numa thread à parte para poder desistir: o DNS do Java não aceita prazo. */
    static InetAddress resolveBounded(final String host) throws Exception {
        if (PingHost.isIpv4(host) || PingHost.isIpv6(host)) return InetAddress.getByName(host); // literal: sem consulta
        FutureTask<InetAddress> task = new FutureTask<>(() -> InetAddress.getByName(host));
        Sys.thread("dns", task).start();
        return task.get(DNS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
    }
}
