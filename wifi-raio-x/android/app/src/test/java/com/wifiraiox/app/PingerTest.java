package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.io.FileOutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * O Pinger de ponta a ponta. No lugar de /system/bin/ping entra um script que imprime a saída
 * de um ping de verdade: o processo, a leitura linha a linha e o cancelamento são os reais.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PingerTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private ScheduledExecutorService watchdog;
    private final List<JSONObject> replies = Collections.synchronizedList(new ArrayList<>());
    private File argsFile;

    @Before
    public void setUp() throws Exception {
        assumeTrue(new File("/bin/sh").canExecute());
        watchdog = Executors.newSingleThreadScheduledExecutor();
        argsFile = new File(tmp.getRoot(), "args.txt");
    }

    @After
    public void tearDown() {
        if (watchdog != null) watchdog.shutdownNow();
    }

    /** Programa falso: grava os argumentos recebidos (um por linha) e executa o corpo. */
    private String fakePing(String body) throws Exception {
        File f = tmp.newFile();
        String script = "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > '" + argsFile.getAbsolutePath() + "'\n" + body + "\n";
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(script.getBytes(StandardCharsets.UTF_8));
        }
        assertTrue(f.setExecutable(true));
        return f.getAbsolutePath();
    }

    private static final Pinger.Resolver LITERAL = InetAddress::getByName;
    private static final Pinger.Prober DEAD = (address, timeoutMs) -> -1;

    private Pinger pinger(String binary, Pinger.Resolver resolver, Pinger.Prober... probers) {
        return new Pinger(binary, null, resolver, probers.length == 0 ? new Pinger.Prober[] {DEAD} : probers, watchdog);
    }

    private JSONObject run(Pinger p, String host, int count, int timeoutMs) {
        return p.run(host, count, timeoutMs, replies::add);
    }

    private static final String IPUTILS_ONE_LOST = String.join("\n",
            "echo 'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.'",
            "echo '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms'",
            "echo '64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=13.9 ms'",
            "echo '64 bytes from 8.8.8.8: icmp_seq=4 ttl=117 time=21.0 ms'",
            "echo ''",
            "echo '--- 8.8.8.8 ping statistics ---'",
            "echo '4 packets transmitted, 3 received, 25% packet loss, time 607ms'",
            "echo 'rtt min/avg/max/mdev = 13.938/16.391/21.022/3.285 ms'",
            "exit 0");

    @Test
    public void icmpSeriesStreamsRepliesAndSummarises() throws Exception {
        JSONObject s = run(pinger(fakePing(IPUTILS_ONE_LOST), LITERAL), "8.8.8.8", 4, 1000);
        assertEquals("icmp", s.get("method"));
        assertEquals("8.8.8.8", s.get("host"));
        assertEquals(4, s.get("sent"));
        assertEquals(3, s.get("received"));
        assertEquals(25.0, s.getDouble("lossPct"), 1e-9);
        assertEquals(13.9, s.getDouble("min"), 1e-9);
        assertEquals(21.0, s.getDouble("max"), 1e-9);
        assertEquals((14.2 + 13.9 + 21.0) / 3, s.getDouble("avg"), 1e-3);
        assertEquals((0.3 + 7.1) / 2, s.getDouble("jitter"), 1e-3);

        // um evento por pacote: as respostas na ordem em que chegaram, o perdido no fim
        assertEquals(4, replies.size());
        int[] seqs = {1, 2, 4, 3};
        boolean[] oks = {true, true, true, false};
        for (int i = 0; i < 4; i++) {
            JSONObject r = replies.get(i);
            assertEquals("8.8.8.8", r.get("host"));
            assertEquals(seqs[i], r.get("seq"));
            assertEquals(oks[i], r.get("ok"));
            assertEquals(oks[i], r.has("ms"));
        }
        assertEquals(14.2, replies.get(0).getDouble("ms"), 1e-9);
    }

    @Test
    public void programReceivesOnlyAFixedArgumentVector() throws Exception {
        run(pinger(fakePing(IPUTILS_ONE_LOST), LITERAL), "8.8.8.8", 4, 2500);
        List<String> args = Files.readAllLines(argsFile.toPath());
        assertEquals(java.util.Arrays.asList("-c", "4", "-i", "0.2", "-W", "3", "8.8.8.8"), args);
    }

    @Test
    public void hostnameIsResolvedHereAndTheProgramGetsTheNumericAddress() throws Exception {
        Pinger.Resolver fixed = host -> InetAddress.getByAddress(host, new byte[] {(byte) 203, 0, 113, 9});
        JSONObject s = run(pinger(fakePing(IPUTILS_ONE_LOST), fixed), "exemplo.com.br", 4, 1000);
        List<String> args = Files.readAllLines(argsFile.toPath());
        assertEquals("203.0.113.9", args.get(args.size() - 1));
        assertFalse(args.contains("exemplo.com.br"));
        assertEquals("o resumo fala do nome pedido", "exemplo.com.br", s.get("host"));
    }

    @Test
    public void countAndTimeoutAreClamped() throws Exception {
        run(pinger(fakePing("exit 0"), LITERAL), "8.8.8.8", 100000, 999999);
        List<String> args = Files.readAllLines(argsFile.toPath());
        assertEquals("50", args.get(1));
        assertEquals("5", args.get(5));
        run(pinger(fakePing("exit 0"), LITERAL), "8.8.8.8", -3, 1);
        args = Files.readAllLines(argsFile.toPath());
        assertEquals("1", args.get(1));
        assertEquals("1", args.get(5));
    }

    @Test
    public void invalidHostNeverStartsAProcess() throws Exception {
        Pinger p = pinger(fakePing(IPUTILS_ONE_LOST), LITERAL);
        for (String bad : new String[] {"-c 1000", "8.8.8.8; reboot", "", null, "$(id)"}) {
            JSONObject r = run(p, bad, 4, 1000);
            assertEquals(Pinger.ERR_INVALID_HOST, r.get("error"));
        }
        assertFalse("o programa não chegou a rodar", argsFile.exists());
        assertTrue(replies.isEmpty());
    }

    @Test
    public void unknownHostIsAnError() throws Exception {
        Pinger.Resolver failing = host -> {
            throw new UnknownHostException(host);
        };
        JSONObject r = run(pinger(fakePing(IPUTILS_ONE_LOST), failing), "nao-existe.invalid", 4, 1000);
        assertEquals(Pinger.ERR_UNKNOWN_HOST, r.get("error"));
        assertFalse(argsFile.exists());
    }

    @Test
    public void zeroBasedSequenceIsNormalised() throws Exception {
        String toybox = String.join("\n",
                "echo 'Ping 192.168.0.1 (192.168.0.1): 56(84) bytes.'",
                "echo '64 bytes from 192.168.0.1: icmp_seq=0 ttl=64 time=3 ms'",
                "echo '64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=5 ms'",
                "echo '--- 192.168.0.1 ping statistics ---'",
                "echo '2 packets transmitted, 2 received, 0% packet loss'",
                "echo 'round-trip min/avg/max = 3/4/5 ms'");
        JSONObject s = run(pinger(fakePing(toybox), LITERAL), "192.168.0.1", 2, 1000);
        assertEquals(2, s.get("sent"));
        assertEquals(2, s.get("received"));
        assertEquals(1, replies.get(0).get("seq"));
        assertEquals(2, replies.get(1).get("seq"));
    }

    @Test
    public void duplicateRepliesCountOnce() throws Exception {
        String dup = String.join("\n",
                "echo '64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=2.0 ms'",
                "echo '64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=2.9 ms (DUP!)'",
                "echo '1 packets transmitted, 1 received, +1 duplicates, 0% packet loss, time 0ms'");
        JSONObject s = run(pinger(fakePing(dup), LITERAL), "192.168.0.1", 1, 1000);
        assertEquals(1, s.get("received"));
        assertEquals(1, replies.size());
        assertEquals(2.0, s.getDouble("max"), 1e-9);
    }

    @Test
    public void silentHostFallsBackToTcpTiming() throws Exception {
        String silent = String.join("\n",
                "echo 'PING 10.0.0.9 (10.0.0.9) 56(84) bytes of data.'",
                "echo '--- 10.0.0.9 ping statistics ---'",
                "echo '3 packets transmitted, 0 received, 100% packet loss, time 2010ms'",
                "exit 1");
        final AtomicInteger first = new AtomicInteger();
        final AtomicInteger second = new AtomicInteger();
        Pinger.Prober icmpLike = (a, t) -> {
            first.incrementAndGet();
            return -1;
        };
        Pinger.Prober tcp = (a, t) -> second.incrementAndGet() == 2 ? -1 : 8.5;
        JSONObject s = run(pinger(fakePing(silent), LITERAL, icmpLike, tcp), "10.0.0.9", 3, 300);
        assertEquals("tcp", s.get("method"));
        assertEquals(3, s.get("sent"));
        assertEquals(2, s.get("received"));
        assertEquals(8.5, s.getDouble("avg"), 1e-9);
        assertEquals("a sonda que funcionou na 1ª rodada é a usada nas seguintes", 1, first.get());
        assertEquals(3, second.get());
        assertEquals(3, replies.size());
        assertEquals(true, replies.get(0).get("ok"));
        assertEquals(1, replies.get(0).get("seq"));
        // perdidos saem no fim, cada pacote aparece uma única vez
        assertEquals(false, replies.get(2).get("ok"));
        assertEquals(2, replies.get(2).get("seq"));
    }

    @Test
    public void missingProgramFallsBackToTcp() throws Exception {
        Pinger p = pinger(new File(tmp.getRoot(), "nao-existe").getAbsolutePath(), LITERAL, (a, t) -> 4.0);
        JSONObject s = run(p, "192.168.0.1", 2, 300);
        assertEquals("tcp", s.get("method"));
        assertEquals(2, s.get("sent"));
        assertEquals(2, s.get("received"));
        assertEquals(0.0, s.getDouble("lossPct"), 1e-9);
    }

    @Test
    public void nothingAnswersAnywhere() throws Exception {
        // ICMP rodou (ninguém respondeu) e o TCP também não: o resumo é o do ICMP, 100% de perda.
        String silent = "echo '5 packets transmitted, 0 received, 100% packet loss, time 1010ms'\nexit 1";
        JSONObject s = run(pinger(fakePing(silent), LITERAL), "10.0.0.9", 5, 200);
        assertEquals("icmp", s.get("method"));
        assertEquals(5, s.get("sent"));
        assertEquals(0, s.get("received"));
        assertEquals(100.0, s.getDouble("lossPct"), 1e-9);
        assertFalse(s.has("avg"));
        assertEquals(5, replies.size());
        for (int i = 0; i < 5; i++) {
            assertEquals(i + 1, replies.get(i).get("seq"));
            assertEquals(false, replies.get(i).get("ok"));
        }

        // Sem programa e sem resposta: desiste depois de poucas tentativas em vez de insistir a série toda.
        replies.clear();
        Pinger p = pinger(new File(tmp.getRoot(), "nao-existe").getAbsolutePath(), LITERAL);
        JSONObject t = run(p, "10.0.0.9", 50, 200);
        assertEquals("tcp", t.get("method"));
        assertEquals(3, t.get("sent"));
        assertEquals(0, t.get("received"));
        assertEquals(3, replies.size());
    }

    @Test
    public void cancelKillsTheProcessAndReturnsThePartialSummary() throws Exception {
        // "exec": o sleep toma o lugar do shell, como um ping de verdade parado esperando resposta
        String slow = "echo '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms'\nexec sleep 30";
        final Pinger p = pinger(fakePing(slow), LITERAL);
        final CountDownLatch firstReply = new CountDownLatch(1);
        final JSONObject[] result = new JSONObject[1];
        Thread t = new Thread(() -> result[0] = p.run("8.8.8.8", 10, 1000, r -> {
            replies.add(r);
            firstReply.countDown();
        }));
        long t0 = System.currentTimeMillis();
        t.start();
        assertTrue(firstReply.await(10, TimeUnit.SECONDS));
        p.cancel();
        t.join(5000);
        assertFalse("cancelar tem de soltar a thread", t.isAlive());
        assertTrue(System.currentTimeMillis() - t0 < 10_000);
        assertNotNull(result[0]);
        assertEquals("icmp", result[0].get("method"));
        assertEquals(1, result[0].get("received"));
        assertEquals(1, result[0].get("sent"));
        p.cancel(); // sem nada rodando: não faz nada
    }

    @Test
    public void aNewPingCancelsTheOneRunning() throws Exception {
        // o 7º argumento é o endereço: 8.8.8.8 fica parado, qualquer outro responde na hora
        String script = String.join("\n",
                "case \"$7\" in",
                "8.8.8.8) echo '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms'; exec sleep 30;;",
                "*) echo '64 bytes from 192.168.0.1: icmp_seq=1 ttl=64 time=1.5 ms'; echo '1 packets transmitted, 1 received, 0% packet loss, time 0ms';;",
                "esac");
        final Pinger p = pinger(fakePing(script), LITERAL);
        final CountDownLatch started = new CountDownLatch(1);
        final JSONObject[] first = new JSONObject[1];
        Thread t = new Thread(() -> first[0] = p.run("8.8.8.8", 10, 1000, r -> started.countDown()));
        t.start();
        assertTrue(started.await(10, TimeUnit.SECONDS));

        JSONObject second = run(p, "192.168.0.1", 1, 1000);
        assertEquals(1, second.get("received"));
        assertEquals(1.5, second.getDouble("avg"), 1e-9);

        t.join(5000);
        assertFalse("o primeiro foi cancelado pelo segundo", t.isAlive());
        assertNotNull(first[0]);
        assertEquals(1, first[0].get("received"));
    }

    @Test
    public void tcpProbeTimesOpenAndClosedPorts() throws Exception {
        ServerSocket server;
        try {
            server = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
        } catch (Exception e) {
            assumeTrue("sem rede local neste ambiente", false);
            return;
        }
        int open = server.getLocalPort();
        double ms = NetProbe.tcp(InetAddress.getLoopbackAddress(), open, 1000, null);
        assertTrue("porta aberta responde", ms >= 0 && ms < 1000);
        server.close();
        double refused = NetProbe.tcp(InetAddress.getLoopbackAddress(), open, 1000, null);
        assertTrue("porta fechada recusa: o aparelho está lá", refused >= 0 && refused < 1000);
    }
}
