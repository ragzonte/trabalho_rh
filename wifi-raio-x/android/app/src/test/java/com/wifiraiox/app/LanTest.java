package com.wifiraiox.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.net.Network;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.StringReader;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Varredura da rede local: faixa de endereços, orquestração com sondas falsas, NetBIOS e tabela ARP. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class LanTest {

    private static int ip(String dotted) {
        int v = LanRange.parse(dotted);
        assertTrue(dotted, v != 0);
        return v;
    }

    // ------------------------------------------------------------ faixa

    @Test
    public void privateRangesOnly() {
        for (String a : new String[] {"10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.1", "192.168.0.1", "192.168.255.200"}) {
            assertTrue(a, LanRange.isPrivate(ip(a)));
        }
        for (String a : new String[] {"8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1", "192.169.1.1", "100.64.0.1",
                "169.254.10.10", "11.0.0.1", "200.147.3.157", "127.0.0.1"}) {
            assertFalse(a, LanRange.isPrivate(ip(a)));
        }
    }

    @Test
    public void slash24CoversTheWholeSubnetWithoutNetworkAndBroadcast() {
        int[] hosts = LanRange.hosts(ip("192.168.15.37"), 24);
        assertEquals(254, hosts.length);
        assertEquals("192.168.15.1", LanRange.format(hosts[0]));
        assertEquals("192.168.15.254", LanRange.format(hosts[253]));
    }

    @Test
    public void rangeForSeveralPrefixes() {
        assertEquals(1022, LanRange.hosts(ip("10.0.2.9"), 22).length);
        assertEquals("10.0.0.1", LanRange.format(LanRange.hosts(ip("10.0.2.9"), 22)[0]));
        assertEquals("10.0.3.254", LanRange.format(LanRange.hosts(ip("10.0.2.9"), 22)[1021]));
        assertEquals(510, LanRange.hosts(ip("172.16.5.9"), 23).length);
        assertEquals(126, LanRange.hosts(ip("192.168.1.200"), 25).length);
        assertEquals("192.168.1.129", LanRange.format(LanRange.hosts(ip("192.168.1.200"), 25)[0]));
        assertEquals(14, LanRange.hosts(ip("192.168.1.5"), 28).length);
        assertArrayEquals(new int[] {ip("192.168.1.1"), ip("192.168.1.2")}, LanRange.hosts(ip("192.168.1.2"), 30));
        assertEquals("ponto a ponto: nada a varrer", 0, LanRange.hosts(ip("192.168.1.2"), 31).length);
        assertEquals(0, LanRange.hosts(ip("192.168.1.2"), 32).length);
    }

    @Test
    public void hugeSubnetsAreLimitedToTheSlash24AroundThePhone() {
        for (int prefix : new int[] {8, 12, 16, 20, 21, 0, -1, 33}) {
            int[] hosts = LanRange.hosts(ip("10.44.7.130"), prefix);
            assertEquals("prefixo " + prefix, 254, hosts.length);
            assertEquals("10.44.7.1", LanRange.format(hosts[0]));
            assertEquals("10.44.7.254", LanRange.format(hosts[253]));
        }
    }

    @Test
    public void publicAddressesAreNeverSwept() {
        assertEquals(0, LanRange.hosts(ip("200.147.3.157"), 24).length);
        assertEquals(0, LanRange.hosts(ip("100.64.0.9"), 24).length);
        assertEquals(0, LanRange.hosts(0, 24).length);
    }

    @Test
    public void addressTextRoundTrip() {
        assertEquals("192.168.0.10", LanRange.format(ip("192.168.0.10")));
        assertEquals("255.255.255.255", LanRange.format(LanRange.parse("255.255.255.255")));
        assertEquals(0xC0A8000A, ip("192.168.0.10"));
        for (String bad : new String[] {null, "", "1.2.3", "1.2.3.4.5", "256.0.0.1", "a.b.c.d", "1.2.3.-4", "1..2.3", "1.2.3.4 ", "0001.2.3.4"}) {
            assertEquals(String.valueOf(bad), 0, LanRange.parse(bad));
        }
        assertArrayEquals(new byte[] {(byte) 192, (byte) 168, 0, 10}, LanRange.toBytes(ip("192.168.0.10")));
        assertEquals(ip("192.168.0.10"), LanRange.toInt(new byte[] {(byte) 192, (byte) 168, 0, 10}));
        assertTrue(LanRange.sameSubnet(ip("192.168.5.10"), 16, ip("192.168.0.1")));
        assertFalse(LanRange.sameSubnet(ip("192.168.5.10"), 24, ip("192.168.0.1")));
    }

    // ------------------------------------------------------------ orquestração

    /** Rede de mentira: quem responde, com que demora, e os nomes. */
    private static class FakeNet implements LanScanner.Net {
        final Map<String, Double> first = new ConcurrentHashMap<>();   // responde à 1ª sonda
        final Map<String, Double> second = new ConcurrentHashMap<>();  // só à 2ª
        final Map<String, String> dns = new ConcurrentHashMap<>();
        final Map<String, String> netbios = new ConcurrentHashMap<>();
        final Map<String, String> arp = new ConcurrentHashMap<>();
        final AtomicInteger probes = new AtomicInteger();
        final List<String> probed = Collections.synchronizedList(new ArrayList<>());
        volatile long delayMs;

        @Override
        public double probe(InetAddress address, int attempt, Network network) {
            probes.incrementAndGet();
            if (attempt == 0) probed.add(address.getHostAddress());
            if (delayMs > 0) {
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            Double ms = (attempt == 0 ? first : second).get(address.getHostAddress());
            return ms == null ? -1 : ms;
        }

        @Override
        public String dnsName(InetAddress address) {
            return dns.get(address.getHostAddress());
        }

        @Override
        public String netbiosName(InetAddress address, Network network) {
            return netbios.get(address.getHostAddress());
        }

        @Override
        public Map<String, String> arp() {
            return new HashMap<>(arp);
        }
    }

    private static class Recorder implements LanScanner.Events {
        final List<JSONObject> devices = Collections.synchronizedList(new ArrayList<>());
        final List<int[]> progress = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void onDevice(JSONObject device) {
            devices.add(device);
        }

        @Override
        public void onProgress(int done, int total) {
            progress.add(new int[] {done, total});
        }
    }

    private static ConnectionTracker.LanTarget target(String ipAddr, int prefix, String gateway) {
        return new ConnectionTracker.LanTarget(ip(ipAddr), prefix, gateway == null ? 0 : ip(gateway), null);
    }

    private static JSONObject byIp(JSONArray devices, String ipAddr) throws Exception {
        for (int i = 0; i < devices.length(); i++) {
            if (devices.getJSONObject(i).getString("ip").equals(ipAddr)) return devices.getJSONObject(i);
        }
        return null;
    }

    @Test
    public void findsRespondersWithNamesAndFlags() throws Exception {
        FakeNet net = new FakeNet();
        net.first.put("192.168.1.1", 2.46);
        net.first.put("192.168.1.100", 41.0);
        net.second.put("192.168.1.20", 3.0);          // só na segunda chance
        net.netbios.put("192.168.1.30", "DESKTOP-ABC"); // ignora as sondas, responde ao NetBIOS
        net.dns.put("192.168.1.1", "roteador.lan");
        net.netbios.put("192.168.1.100", "IMPRESSORA");
        Recorder rec = new Recorder();

        JSONObject result = new LanScanner(net, 16).run(target("192.168.1.10", 24, "192.168.1.1"), rec);
        JSONArray devices = result.getJSONArray("devices");
        assertEquals(5, devices.length());

        // em ordem numérica de endereço
        String[] order = {"192.168.1.1", "192.168.1.10", "192.168.1.20", "192.168.1.30", "192.168.1.100"};
        for (int i = 0; i < order.length; i++) assertEquals(order[i], devices.getJSONObject(i).get("ip"));

        JSONObject router = byIp(devices, "192.168.1.1");
        assertEquals(true, router.get("gateway"));
        assertEquals("roteador.lan", router.get("host"));
        assertEquals(2.5, router.getDouble("ms"), 1e-9);
        assertFalse(router.has("self"));
        assertFalse(router.has("mac"));

        JSONObject self = byIp(devices, "192.168.1.10");
        assertEquals(true, self.get("self"));
        assertFalse("o próprio celular não é sondado", self.has("ms"));
        assertFalse(net.probed.contains("192.168.1.10"));

        assertEquals(3.0, byIp(devices, "192.168.1.20").getDouble("ms"), 1e-9);
        assertFalse(byIp(devices, "192.168.1.20").has("host"));
        assertEquals("DESKTOP-ABC", byIp(devices, "192.168.1.30").get("host"));
        assertTrue(byIp(devices, "192.168.1.30").has("ms"));
        assertEquals("IMPRESSORA", byIp(devices, "192.168.1.100").get("host"));

        // um evento por aparelho, os mesmos da resposta
        assertEquals(5, rec.devices.size());
        // progresso: começa em 0, nunca volta, termina em total/total
        assertEquals(254, rec.progress.get(0)[1]);
        assertEquals(0, rec.progress.get(0)[0]);
        int last = -1;
        for (int[] p : rec.progress) {
            assertTrue(p[0] >= last);
            assertEquals(254, p[1]);
            last = p[0];
        }
        assertEquals(254, last);
        assertEquals(253, net.probed.size());
    }

    @Test
    public void silentGatewayIsStillListed() throws Exception {
        FakeNet net = new FakeNet();
        Recorder rec = new Recorder();
        JSONArray devices = new LanScanner(net, 32).run(target("10.0.0.7", 24, "10.0.0.1"), rec).getJSONArray("devices");
        assertEquals(2, devices.length());
        assertEquals(true, byIp(devices, "10.0.0.1").get("gateway"));
        assertFalse(byIp(devices, "10.0.0.1").has("ms"));
        assertEquals(true, byIp(devices, "10.0.0.7").get("self"));
    }

    @Test
    public void bigSubnetSweepsTheLocalSliceAndTheGateway() throws Exception {
        FakeNet net = new FakeNet();
        net.first.put("192.168.0.1", 1.0);
        net.first.put("192.168.5.77", 9.0);
        Recorder rec = new Recorder();
        JSONArray devices = new LanScanner(net, 32).run(target("192.168.5.10", 16, "192.168.0.1"), rec).getJSONArray("devices");
        assertEquals("254 do /24 local (um é o celular) + o roteador fora da fatia", 254, net.probed.size());
        assertTrue(net.probed.contains("192.168.0.1"));
        assertFalse(net.probed.contains("192.168.4.1"));
        assertEquals(3, devices.length());
        assertEquals(true, byIp(devices, "192.168.0.1").get("gateway"));
        assertNotNull(byIp(devices, "192.168.5.77"));
        assertEquals(255, rec.progress.get(rec.progress.size() - 1)[1]);
    }

    @Test
    public void gatewayOutsideTheSubnetOrPublicIsNotProbed() throws Exception {
        FakeNet net = new FakeNet();
        Recorder rec = new Recorder();
        JSONArray devices = new LanScanner(net, 32).run(target("192.168.5.10", 24, "200.1.2.3"), rec).getJSONArray("devices");
        assertFalse(net.probed.contains("200.1.2.3"));
        assertEquals(1, devices.length());
    }

    @Test
    public void notOnWifiOrNotPrivateGivesAnEmptyList() throws Exception {
        FakeNet net = new FakeNet();
        Recorder rec = new Recorder();
        LanScanner scanner = new LanScanner(net, 8);
        assertEquals(0, scanner.run(null, rec).getJSONArray("devices").length());
        assertEquals(0, scanner.run(target("200.147.3.157", 24, "200.147.3.1"), rec).getJSONArray("devices").length());
        assertEquals(0, scanner.run(target("100.64.3.9", 10, "100.64.0.1"), rec).getJSONArray("devices").length());
        assertEquals(0, net.probes.get());
        assertTrue(rec.devices.isEmpty());
        for (int[] p : rec.progress) assertArrayEquals(new int[] {0, 0}, p);
    }

    @Test
    public void arpTableAddsMacsAndSilentNeighbours() throws Exception {
        FakeNet net = new FakeNet();
        net.first.put("192.168.1.1", 1.0);
        net.arp.put("192.168.1.1", "a4:91:b1:00:11:22");
        net.arp.put("192.168.1.40", "de:ad:be:ef:00:01"); // respondeu ao ARP e a mais nada
        net.arp.put("192.168.9.9", "de:ad:be:ef:00:02");  // outra rede: fora
        Recorder rec = new Recorder();
        JSONArray devices = new LanScanner(net, 32).run(target("192.168.1.10", 24, "192.168.1.1"), rec).getJSONArray("devices");
        assertEquals("a4:91:b1:00:11:22", byIp(devices, "192.168.1.1").get("mac"));
        assertEquals("de:ad:be:ef:00:01", byIp(devices, "192.168.1.40").get("mac"));
        assertFalse(byIp(devices, "192.168.1.40").has("ms"));
        assertNull(byIp(devices, "192.168.9.9"));
        assertEquals(3, devices.length());
        assertEquals(3, rec.devices.size());
    }

    @Test
    public void cancelReturnsQuicklyWithWhatWasFound() throws Exception {
        final FakeNet net = new FakeNet();
        net.delayMs = 150;
        net.first.put("192.168.1.1", 1.0);
        final LanScanner scanner = new LanScanner(net, 4);
        final Recorder rec = new Recorder();
        final JSONObject[] result = new JSONObject[1];
        final CountDownLatch done = new CountDownLatch(1);
        Thread t = new Thread(() -> {
            result[0] = scanner.run(target("192.168.1.10", 24, "192.168.1.1"), rec);
            done.countDown();
        });
        t.start();
        Thread.sleep(400);
        long t0 = System.currentTimeMillis();
        scanner.cancel();
        assertTrue("sem cancelar levaria ~20 s", done.await(3, TimeUnit.SECONDS));
        assertTrue(System.currentTimeMillis() - t0 < 3000);
        assertNotNull(result[0]);
        int found = result[0].getJSONArray("devices").length();
        assertTrue(found >= 1 && found <= 2);
        assertTrue("parou antes de sondar tudo", net.probed.size() < 100);
        int eventsAtReturn = rec.devices.size();
        Thread.sleep(400);
        assertEquals("nenhum evento depois de cancelado", eventsAtReturn, rec.devices.size());
        scanner.cancel(); // nada rodando: não faz nada
    }

    @Test
    public void aSecondScanCancelsTheFirst() throws Exception {
        final FakeNet slow = new FakeNet();
        slow.delayMs = 200;
        final LanScanner scanner = new LanScanner(slow, 2);
        final CountDownLatch firstDone = new CountDownLatch(1);
        final JSONObject[] first = new JSONObject[1];
        Thread t = new Thread(() -> {
            first[0] = scanner.run(target("192.168.1.10", 24, null), new Recorder());
            firstDone.countDown();
        });
        t.start();
        Thread.sleep(300);
        slow.delayMs = 0;
        JSONObject second = scanner.run(target("192.168.1.10", 30, null), new Recorder());
        assertTrue(firstDone.await(3, TimeUnit.SECONDS));
        assertNotNull(first[0]);
        assertEquals(1, second.getJSONArray("devices").length());
    }

    // ------------------------------------------------------------ NetBIOS

    private static byte[] nbstatResponse(String name, boolean extraGroup) {
        byte[] p = new byte[57 + 18 * 3 + 6];
        p[2] = (byte) 0x84; // resposta
        p[7] = 1;
        p[12] = 0x20;
        for (int i = 13; i < 45; i++) p[i] = 'A';
        p[45] = 0;
        p[47] = 0x21;
        p[49] = 0x01;
        p[56] = (byte) (extraGroup ? 3 : 1);
        int at = 57;
        if (extraGroup) {
            write(p, at, "WORKGROUP", 0x00, 0x80); // nome de grupo: não é a máquina
            at += 18;
            write(p, at, name, 0x20, 0x04);        // serviço de arquivos: outro tipo
            at += 18;
        }
        write(p, at, name, 0x00, 0x04);
        return p;
    }

    private static void write(byte[] p, int at, String name, int type, int flags) {
        for (int i = 0; i < 15; i++) p[at + i] = (byte) (i < name.length() ? name.charAt(i) : ' ');
        p[at + 15] = (byte) type;
        p[at + 16] = (byte) flags;
    }

    @Test
    public void netbiosRequestIsAWellFormedNodeStatusQuery() {
        byte[] q = NetBios.request();
        assertEquals(50, q.length);
        assertEquals(1, q[5]);
        assertEquals(0x20, q[12]);
        assertEquals('C', q[13]);
        assertEquals('K', q[14]);
        for (int i = 15; i < 45; i++) assertEquals('A', q[i]);
        assertEquals(0, q[45]);
        assertEquals(0x21, q[47]);
        assertEquals(0x01, q[49]);
    }

    @Test
    public void netbiosResponseParsing() {
        byte[] simple = nbstatResponse("NOTEBOOK-ANA", false);
        assertEquals("NOTEBOOK-ANA", NetBios.parse(simple, simple.length));
        byte[] full = nbstatResponse("SERVIDOR", true);
        assertEquals("pula o nome de grupo", "SERVIDOR", NetBios.parse(full, full.length));
        // lixo, respostas cortadas e perguntas não derrubam nada
        assertNull(NetBios.parse(null, 0));
        assertNull(NetBios.parse(new byte[5], 5));
        assertNull(NetBios.parse(new byte[200], 200));
        assertNull(NetBios.parse(simple, 60));
        assertNull(NetBios.parse(simple, simple.length + 10));
        byte[] query = simple.clone();
        query[2] = 0;
        assertNull(NetBios.parse(query, query.length));
        byte[] liar = simple.clone();
        liar[56] = (byte) 200; // diz ter 200 nomes
        assertEquals("NOTEBOOK-ANA", NetBios.parse(liar, liar.length));
        byte[] blank = nbstatResponse("", false);
        assertNull(NetBios.parse(blank, blank.length));
    }

    // ------------------------------------------------------------ ARP

    @Test
    public void arpTableParsing() throws Exception {
        String table = "IP address       HW type     Flags       HW address            Mask     Device\n"
                + "192.168.15.1     0x1         0x2         A4:91:B1:00:11:22     *        wlan0\n"
                + "192.168.15.20    0x1         0x0         00:00:00:00:00:00     *        wlan0\n"
                + "192.168.15.33    0x1         0x6         3c:5a:b4:aa:bb:cc     *        wlan0\n"
                + "192.168.15.44    0x1         0x2         00:00:00:00:00:00     *        wlan0\n"
                + "linha quebrada\n"
                + "192.168.15.55    0x1         zzz         3c:5a:b4:aa:bb:dd     *        wlan0\n"
                + "\n";
        Map<String, String> arp = ArpTable.parse(new StringReader(table));
        assertEquals(2, arp.size());
        assertEquals("a4:91:b1:00:11:22", arp.get("192.168.15.1"));
        assertEquals("3c:5a:b4:aa:bb:cc", arp.get("192.168.15.33"));
        assertTrue(ArpTable.parse(new StringReader("")).isEmpty());
    }
}
