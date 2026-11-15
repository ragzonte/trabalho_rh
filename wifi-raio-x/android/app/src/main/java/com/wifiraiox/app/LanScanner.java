package com.wifiraiox.app;

import android.net.Network;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * Descobre os aparelhos da rede local: sonda cada endereço da sub-rede do Wi-Fi em paralelo.
 * Quem não responde ao eco (ICMP/TCP 7) ganha uma segunda chance por TCP e, por fim, pelo NetBIOS
 * (computadores com firewall costumam responder só a esse). Roda inteiro fora da thread da interface.
 */
final class LanScanner {

    interface Events {
        void onDevice(JSONObject device);

        void onProgress(int done, int total);
    }

    /** As operações de rede, separadas para os testes poderem trocá-las. Nenhuma lança. */
    interface Net {
        /** Tempo de resposta em ms ou -1. attempt 0 = primeira sonda, 1 = segunda chance. */
        double probe(InetAddress address, int attempt, Network network);

        /** Nome pelo DNS reverso do roteador, ou null. */
        String dnsName(InetAddress address);

        /** Nome pelo NetBIOS, ou null. Também serve de prova de vida. */
        String netbiosName(InetAddress address, Network network);

        /** IP -> MAC pela tabela de vizinhos (vazio no Android 10+). */
        Map<String, String> arp();
    }

    static final int THREADS = 48;
    static final int TIMEOUT_MS = 400;
    private static final int NETBIOS_TIMEOUT_MS = 350;
    private static final long DNS_TIMEOUT_MS = 1200;
    private static final long PROGRESS_EVERY_MS = 120;
    private static final long ARP_CACHE_MS = 300;

    private final Net net;
    private final int threads;
    private Job current;

    LanScanner() {
        this(new SystemNet(), THREADS);
    }

    LanScanner(Net net, int threads) {
        this.net = net;
        this.threads = Math.max(1, threads);
    }

    /** Interrompe a varredura em andamento; quem a pediu recebe o que já foi encontrado. */
    void cancel() {
        Job job;
        synchronized (this) {
            job = current;
        }
        if (job != null) job.cancel();
    }

    /**
     * Varre (bloqueia: chamar numa thread de trabalho) e devolve {devices: LanDevice[]}.
     * `target` null (fora do Wi-Fi) ou com endereço não privado resulta em lista vazia.
     */
    JSONObject run(ConnectionTracker.LanTarget target, Events events) {
        Job job = new Job(events);
        Job previous;
        synchronized (this) {
            previous = current;
            current = job;
        }
        if (previous != null) previous.cancel(); // uma varredura por vez
        try {
            sweep(job, target);
        } finally {
            synchronized (this) {
                if (current == job) current = null;
            }
        }
        return job.result();
    }

    private void sweep(final Job job, final ConnectionTracker.LanTarget target) {
        if (target == null || !LanRange.isPrivate(target.ip)) {
            job.events.onProgress(0, 0);
            return;
        }
        final List<Integer> hosts = new ArrayList<>();
        final Set<Integer> swept = new HashSet<>();
        for (int host : LanRange.hosts(target.ip, target.prefix)) {
            hosts.add(host);
            swept.add(host);
        }
        // O roteador pode estar fora do /24 varrido numa sub-rede grande: ele entra de qualquer jeito.
        final boolean gatewayKnown = target.gateway != 0 && LanRange.isPrivate(target.gateway)
                && LanRange.sameSubnet(target.ip, target.prefix, target.gateway);
        if (gatewayKnown && swept.add(target.gateway)) hosts.add(target.gateway);
        if (swept.add(target.ip)) hosts.add(target.ip);
        job.total = hosts.size();
        job.events.onProgress(0, job.total);

        ExecutorService pool = Executors.newFixedThreadPool(Math.min(threads, job.total), Sys.threads("lan"));
        job.pool = pool;
        try {
            for (final int host : hosts) {
                pool.execute(() -> {
                    try {
                        probe(job, target, host, gatewayKnown);
                    } catch (Exception ignored) {
                        // um endereço problemático não interrompe os outros
                    } finally {
                        job.step();
                    }
                });
            }
        } catch (RejectedExecutionException ignored) {
            // cancelada enquanto enfileirava
        }
        pool.shutdown();
        try {
            while (!pool.awaitTermination(100, TimeUnit.MILLISECONDS)) {
                if (job.cancelled) break;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            job.cancel();
        }
        if (job.cancelled) {
            pool.shutdownNow();
            return;
        }
        // Android até o 9: quem respondeu ao ARP mas ignorou todas as sondas ainda aparece, com o MAC.
        for (Map.Entry<String, String> e : net.arp().entrySet()) {
            int ip = LanRange.parse(e.getKey());
            if (ip == 0 || !swept.contains(ip) || job.has(e.getKey())) continue;
            JSONObject device = new JSONObject();
            Json.put(device, "ip", e.getKey());
            Json.put(device, "mac", e.getValue());
            job.add(device);
        }
        job.events.onProgress(job.total, job.total);
    }

    private void probe(Job job, ConnectionTracker.LanTarget target, int host, boolean gatewayKnown) throws Exception {
        if (job.cancelled) return;
        boolean self = host == target.ip;
        boolean gateway = gatewayKnown && host == target.gateway;
        String ip = LanRange.format(host);
        double ms = -1;
        String name = null;
        if (!self) {
            InetAddress address = InetAddress.getByAddress(LanRange.toBytes(host));
            ms = net.probe(address, 0, target.network);
            if (ms < 0 && !job.cancelled) ms = net.probe(address, 1, target.network);
            if (job.cancelled) return;
            if (ms >= 0) {
                name = net.dnsName(address);
                if (name == null && !job.cancelled) name = net.netbiosName(address, target.network);
            } else {
                long t0 = System.nanoTime();
                name = net.netbiosName(address, target.network);
                if (name != null) ms = (System.nanoTime() - t0) / 1_000_000.0;
            }
        }
        if (job.cancelled || !(self || gateway || ms >= 0)) return;
        JSONObject device = new JSONObject();
        Json.put(device, "ip", ip);
        Json.put(device, "host", name);
        if (!self) Json.put(device, "mac", job.mac(net, ip));
        if (ms >= 0) Json.put(device, "ms", Json.round(ms, 1));
        if (self) Json.put(device, "self", true);
        if (gateway) Json.put(device, "gateway", true);
        job.add(device);
    }

    /** Estado de uma varredura; várias threads de sonda escrevem aqui. */
    private static final class Job {
        final Events events;
        final List<JSONObject> devices = new ArrayList<>();
        final Set<String> ips = new HashSet<>();
        volatile boolean cancelled;
        volatile ExecutorService pool;
        int total;
        private int done;
        private long lastProgressAt;
        private Map<String, String> arp = new HashMap<>();
        private long arpAt;

        Job(Events events) {
            this.events = events;
        }

        void cancel() {
            cancelled = true;
            ExecutorService p = pool;
            if (p != null) p.shutdownNow();
        }

        synchronized boolean has(String ip) {
            return ips.contains(ip);
        }

        void add(JSONObject device) {
            synchronized (this) {
                if (cancelled || !ips.add(device.optString("ip"))) return;
                devices.add(device);
            }
            events.onDevice(device);
        }

        /** Mais um endereço concluído. O aviso sai com o lock para os números nunca chegarem fora de ordem. */
        synchronized void step() {
            int now = ++done;
            long t = System.nanoTime() / 1_000_000;
            if (cancelled || now >= total || t - lastProgressAt < PROGRESS_EVERY_MS) return; // o 100% sai no fim
            lastProgressAt = t;
            events.onProgress(now, total);
        }

        /** MAC do endereço pela tabela de vizinhos, relida no máximo a cada instante. */
        synchronized String mac(Net net, String ip) {
            long t = System.nanoTime() / 1_000_000;
            if (arpAt == 0 || t - arpAt > ARP_CACHE_MS) {
                arp = net.arp();
                arpAt = t == 0 ? 1 : t;
            }
            return arp.get(ip);
        }

        synchronized JSONObject result() {
            List<JSONObject> sorted = new ArrayList<>(devices);
            // comparação sem sinal: 192.168.x.x é negativo como int
            Collections.sort(sorted, (a, b) -> Long.compare(
                    LanRange.parse(a.optString("ip")) & 0xFFFFFFFFL, LanRange.parse(b.optString("ip")) & 0xFFFFFFFFL));
            JSONArray array = new JSONArray();
            for (JSONObject d : sorted) array.put(d);
            return Json.put(new JSONObject(), "devices", array);
        }
    }

    /** As sondas de verdade. */
    private static final class SystemNet implements Net {
        // Consultas de nome podem travar muito além do prazo; ficam num grupo à parte para não segurar as sondas.
        private final ExecutorService names = Executors.newCachedThreadPool(Sys.threads("lan-dns"));

        @Override
        public double probe(InetAddress address, int attempt, Network network) {
            return attempt == 0
                    ? NetProbe.reach(address, TIMEOUT_MS)
                    : NetProbe.tcp(address, 80, TIMEOUT_MS, network);
        }

        @Override
        public String dnsName(final InetAddress address) {
            Future<String> future = null;
            try {
                future = names.submit((Callable<String>) address::getCanonicalHostName);
                String name = future.get(DNS_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                // Sem registro reverso o Java devolve o próprio endereço: isso não é nome.
                if (name == null || name.isEmpty() || name.equals(address.getHostAddress())) return null;
                return name.endsWith(".") ? name.substring(0, name.length() - 1) : name;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            } catch (Exception e) {
                if (future != null) future.cancel(true);
                return null;
            }
        }

        @Override
        public String netbiosName(InetAddress address, Network network) {
            return NetBios.query(address, NETBIOS_TIMEOUT_MS, network);
        }

        @Override
        public Map<String, String> arp() {
            return ArpTable.read();
        }
    }
}
