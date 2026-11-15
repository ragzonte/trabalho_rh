package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Saídas reais do ping do Android (iputils e toybox) e as contas do resumo. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class PingParserTest {

    private static void reply(String line, int seq, double ms) {
        PingParser.Reply r = PingParser.parseLine(line);
        assertNotNull(line, r);
        assertTrue(line, r.ok);
        assertEquals(line, seq, r.seq);
        assertEquals(line, ms, r.ms, 1e-9);
    }

    private static void lost(String line, int seq) {
        PingParser.Reply r = PingParser.parseLine(line);
        assertNotNull(line, r);
        assertFalse(line, r.ok);
        assertEquals(line, seq, r.seq);
    }

    @Test
    public void iputilsReplies() {
        reply("64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms", 1, 14.2);
        reply("64 bytes from 192.168.15.1: icmp_seq=12 ttl=64 time=0.845 ms", 12, 0.845);
        reply("64 bytes from gru14s27-in-f14.1e100.net (142.250.218.14): icmp_seq=3 ttl=118 time=11.4 ms", 3, 11.4);
        reply("64 bytes from 2800:3f0:4001:81a::200e: icmp_seq=2 ttl=118 time=12.1 ms", 2, 12.1);
        reply("64 bytes from 192.168.15.1: icmp_seq=1 ttl=64 time=2.31 ms (DUP!)", 1, 2.31);
        reply("64 bytes from 10.0.0.1: icmp_req=7 ttl=64 time=103 ms", 7, 103);       // iputils antigo
        reply("72 bytes from 1.1.1.1: icmp_seq=50 ttl=57 time=1203.777 ms", 50, 1203.777);
        reply("64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.045 ms", 1, 0.045);
        reply("64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14,2 ms", 1, 14.2);      // vírgula decimal
    }

    @Test
    public void toyboxReplies() {
        reply("64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14 ms", 1, 14);
        reply("64 bytes from 192.168.0.1: icmp_seq=0 ttl=64 time=3 ms", 0, 3);
    }

    @Test
    public void errorLinesAreLostPackets() {
        lost("From 192.168.15.37 icmp_seq=1 Destination Host Unreachable", 1);
        lost("From 10.255.0.1: icmp_seq=4 Time to live exceeded", 4);
        lost("From 192.168.15.1 icmp_seq=2 Destination Net Unreachable", 2);
        lost("no answer yet for icmp_seq=9", 9);
        lost("From 200.1.2.3 icmp_seq=5 Packet filtered", 5);
    }

    @Test
    public void busyboxDialectCountsFromZeroWithoutTheIcmpPrefix() {
        PingParser.Reply r = PingParser.parseLine("64 bytes from 142.250.218.14: seq=0 ttl=117 time=10.253 ms");
        assertEquals(0, r.seq);
        assertTrue(r.ok);
        assertEquals(10.253, r.ms, 1e-9);
        r = PingParser.parseLine("64 bytes from 192.168.0.1: seq=12 ttl=64 time=1.1 ms");
        assertEquals(12, r.seq);
        // "seq=" solto dentro de outra palavra não conta
        assertNull(PingParser.parseLine("64 bytes from 8.8.8.8: subseq=3 time=1 ms"));
        assertEquals(2, PingParser.parseTransmitted("2 packets transmitted, 2 packets received, 0% packet loss"));
    }

    @Test
    public void everythingElseIsNotAboutAPacket() {
        String[] noise = {
            null, "", "PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.", "Ping 8.8.8.8 (8.8.8.8): 56(84) bytes.",
            "--- 8.8.8.8 ping statistics ---", "4 packets transmitted, 3 received, 25% packet loss, time 607ms",
            "rtt min/avg/max/mdev = 13.938/16.391/21.022/3.285 ms", "round-trip min/avg/max = 13/14/15 ms",
            "ping: unknown host exemplo.invalido", "connect: Network is unreachable",
            "ping: sendmsg: Network is unreachable", "ping: icmp open socket: Permission denied",
            "PING google.com (142.250.218.14) 56(84) bytes of data.",
        };
        for (String line : noise) assertNull(String.valueOf(line), PingParser.parseLine(line));
    }

    @Test
    public void transmittedCountFromBothDialects() {
        assertEquals(4, PingParser.parseTransmitted("4 packets transmitted, 3 received, 25% packet loss, time 607ms"));
        assertEquals(10, PingParser.parseTransmitted("10 packets transmitted, 10 received, 0% packet loss"));
        assertEquals(3, PingParser.parseTransmitted("3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2003ms"));
        assertEquals(-1, PingParser.parseTransmitted("rtt min/avg/max/mdev = 1/2/3/4 ms"));
        assertEquals(-1, PingParser.parseTransmitted(null));
    }

    @Test
    public void summaryMaths() throws Exception {
        List<Double> rtts = Arrays.asList(10.0, 14.0, 11.0, 20.0);
        JSONObject s = PingStats.summary("8.8.8.8", "icmp", 5, rtts);
        assertEquals("8.8.8.8", s.get("host"));
        assertEquals("icmp", s.get("method"));
        assertEquals(5, s.get("sent"));
        assertEquals(4, s.get("received"));
        assertEquals(20.0, s.getDouble("lossPct"), 1e-9);
        assertEquals(10.0, s.getDouble("min"), 1e-9);
        assertEquals(13.75, s.getDouble("avg"), 1e-9);
        assertEquals(20.0, s.getDouble("max"), 1e-9);
        assertEquals("média de |4|, |3|, |9|", 16.0 / 3, s.getDouble("jitter"), 1e-3);
    }

    @Test
    public void summaryEdgeCases() throws Exception {
        JSONObject none = PingStats.summary("h", "tcp", 3, new ArrayList<>());
        assertEquals(3, none.get("sent"));
        assertEquals(0, none.get("received"));
        assertEquals(100.0, none.getDouble("lossPct"), 1e-9);
        for (String k : new String[] {"min", "avg", "max", "jitter"}) assertFalse(k, none.has(k));

        JSONObject one = PingStats.summary("h", "icmp", 1, Arrays.asList(7.5));
        assertEquals(0.0, one.getDouble("lossPct"), 1e-9);
        assertEquals(7.5, one.getDouble("min"), 1e-9);
        assertEquals(7.5, one.getDouble("avg"), 1e-9);
        assertFalse("uma resposta só não tem variação", one.has("jitter"));

        JSONObject nothingSent = PingStats.summary("h", "icmp", 0, new ArrayList<>());
        assertEquals(0, nothingSent.get("sent"));
        assertEquals(0.0, nothingSent.getDouble("lossPct"), 1e-9);

        // mais respostas que envios (contagem do ping estranha): nunca perda negativa
        JSONObject odd = PingStats.summary("h", "icmp", 1, Arrays.asList(1.0, 2.0));
        assertEquals(2, odd.get("sent"));
        assertEquals(0.0, odd.getDouble("lossPct"), 1e-9);

        JSONObject third = PingStats.summary("h", "icmp", 3, Arrays.asList(1.0, 2.0));
        assertEquals(33.3, third.getDouble("lossPct"), 1e-9);
    }
}
