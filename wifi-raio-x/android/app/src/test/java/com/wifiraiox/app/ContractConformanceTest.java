package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;
import static org.junit.Assume.assumeTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.DhcpInfo;
import android.net.LinkProperties;
import android.net.MacAddress;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.rtt.RangingResult;
import android.net.wifi.rtt.WifiRttManager;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.robolectric.shadows.RangingResultBuilder;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.shadows.ShadowSystemClock;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * O contrato inteiro de app/js/bridge.js, conferido contra um esquema (ContractSchema) em cada
 * versão do Android: TODO JSON que sai do lado nativo durante cada teste — resposta imediata,
 * resposta de callAsync e evento — passa pelo esquema ao fim do teste, nenhum script que chega à
 * página foge dos três formatos combinados (resolve / emit com nome do contrato), e cada chamada
 * assíncrona é respondida exatamente uma vez.
 *
 * Quando há Node na máquina, as mesmas amostras passam também por tests/helpers/contract.mjs, o
 * conferidor com que o simulador (js/sim/backend.js) é testado: assim os dois lados da ponte são
 * medidos pela mesma régua.
 */
public class ContractConformanceTest extends AllSdks {

    private static final Pattern EMIT = Pattern.compile(
            "^window\\.__wrx&&window\\.__wrx\\.emit&&window\\.__wrx\\.emit\\(\"([^\"]*)\",(.*)\\)$", Pattern.DOTALL);
    private static final Pattern RESOLVE = Pattern.compile(
            "^window\\.__wrx&&window\\.__wrx\\.resolve&&window\\.__wrx\\.resolve\\((-?\\d+),(.*)\\)$", Pattern.DOTALL);
    private static final String[] BOTH = {Fixtures.FINE, Fixtures.COARSE};
    private static final int[] GRANTED = {PackageManager.PERMISSION_GRANTED, PackageManager.PERMISSION_GRANTED};
    private static final int[] DENIED = {PackageManager.PERMISSION_DENIED, PackageManager.PERMISSION_DENIED};
    private static final String RTT_FEATURE = "android.hardware.wifi.rtt";
    private static final String AP_HOME = "a4:91:b1:00:11:22";
    private static final String AP_MESH = "a4:91:b1:00:11:33";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Activity activity;
    private Fixtures.Page page;
    private Bridge bridge;
    private ScheduledExecutorService watchdog;
    private FakeSpeedServer server;
    private FakeLan lan;
    private final List<Bridge> bridges = new ArrayList<>();

    /** Tudo o que foi pedido por callAsync: id -> método. */
    private final Map<Integer, String> asked = new LinkedHashMap<>();
    /** Ids que têm de ser respondidos com {error}. */
    private final Set<Integer> mustFail = new HashSet<>();
    /** Ids que não podem receber resposta nenhuma (página estranha, página antiga). */
    private final Set<Integer> mustStaySilent = new HashSet<>();
    /**
     * Tudo o que já passou pelo esquema, para a conferência cruzada com o JS: [tipo, nome, json, script].
     * tipo: "result" (resposta imediata), "resolve" / "reject" (resposta de callAsync) ou "event";
     * script é o texto exato entregue ao WebView (nulo nas respostas imediatas).
     */
    private final List<String[]> samples = new ArrayList<>();
    private int nextId = 1;

    @Before
    public void setUp() throws Exception {
        Fixtures.forgetFileProviderPaths();
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        watchdog = Executors.newSingleThreadScheduledExecutor();
        ShadowSystemClock.advanceBy(90, TimeUnit.SECONDS); // relógio longe do zero, como num celular ligado
        lan = new FakeLan();
        bridge = newBridge(tcpPinger(12.5), new LanScanner(lan, 16), offlineSpeed());
    }

    @After
    public void tearDown() {
        for (Bridge b : bridges) b.onDestroy();
        watchdog.shutdownNow();
        if (server != null) server.close();
    }

    // ------------------------------------------------------------------ montagem

    private Bridge newBridge(Pinger pinger, LanScanner scanner, SpeedTester speed) {
        Bridge b = Fixtures.bridge(activity, page, pinger, scanner, speed);
        bridges.add(b);
        return b;
    }

    /** Ping sem o programa do sistema: cai na sonda, que responde com o tempo dado (ou não responde, se negativo). */
    private Pinger tcpPinger(final double ms) {
        return new Pinger("/caminho/que/nao/existe/ping", null,
                host -> host.startsWith("nao-existe") ? null : InetAddress.getByAddress(host, new byte[] {10, 1, 2, 3}),
                new Pinger.Prober[] {(address, timeoutMs) -> ms}, watchdog);
    }

    private static SpeedTester offlineSpeed() {
        return new SpeedTester("http://127.0.0.1:9", network -> url -> {
            throw new java.net.UnknownHostException("sem internet nos testes");
        }, null);
    }

    /** Rede local de mentira: roteador, um computador com nome NetBIOS, um aparelho mudo com MAC. */
    private static final class FakeLan implements LanScanner.Net {
        volatile CountDownLatch hold; // quando existe, as sondas ficam presas até ser liberado

        @Override
        public double probe(InetAddress address, int attempt, Network network) {
            CountDownLatch gate = hold;
            if (gate != null) {
                try {
                    gate.await(20, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return -1;
                }
            }
            String ip = address.getHostAddress();
            if (ip.endsWith(".1")) return attempt == 0 ? 2.25 : -1;
            if (ip.endsWith(".40")) return attempt == 1 ? 7.0 : -1;
            return -1;
        }

        @Override
        public String dnsName(InetAddress address) {
            return address.getHostAddress().endsWith(".1") ? "roteador.lan" : null;
        }

        @Override
        public String netbiosName(InetAddress address, Network network) {
            return address.getHostAddress().endsWith(".40") ? "DESKTOP-ANA" : null;
        }

        @Override
        public Map<String, String> arp() {
            Map<String, String> arp = new HashMap<>();
            arp.put("192.168.15.1", "a4:91:b1:00:11:22");
            arp.put("192.168.15.77", "0c:11:22:33:44:55");
            return arp;
        }
    }

    private static LinkProperties homeLink() throws Exception {
        LinkProperties link = Fixtures.linkProperties("wlan0",
                new String[] {"192.168.15.37/24", "fe80::1c2d:3eff:fe4f:5a6b/64", "2804:14c:1:2::10/64"},
                "192.168.15.1", "192.168.15.1", "2001:4860:4860::8888");
        ReflectionHelpers.callInstanceMethod(link, "setMtu", ClassParameter.from(int.class, 1500));
        return link;
    }

    /** Celular conectado ao Wi-Fi de casa, com tudo o que a versão do Android em teste sabe informar. */
    private Network connectHome(String ssid, String bssid) throws Exception {
        WifiInfo info = Fixtures.wifiInfo(ssid, bssid, -52, 433, 5180);
        if (Build.VERSION.SDK_INT >= 29) {
            ReflectionHelpers.callInstanceMethod(info, "setTxLinkSpeedMbps", ClassParameter.from(int.class, 866));
            ReflectionHelpers.callInstanceMethod(info, "setRxLinkSpeedMbps", ClassParameter.from(int.class, 780));
        }
        if (Build.VERSION.SDK_INT >= 30) {
            ReflectionHelpers.callInstanceMethod(info, "setMaxSupportedTxLinkSpeedMbps", ClassParameter.from(int.class, 1201));
            ReflectionHelpers.callInstanceMethod(info, "setMaxSupportedRxLinkSpeedMbps", ClassParameter.from(int.class, 1201));
            ReflectionHelpers.callInstanceMethod(info, "setWifiStandard", ClassParameter.from(int.class, 6));
        }
        if (Build.VERSION.SDK_INT >= 31) {
            ReflectionHelpers.callInstanceMethod(info, "setCurrentSecurityType", ClassParameter.from(int.class, 4));
        }
        Fixtures.wifi().setConnectionInfo(info);
        DhcpInfo dhcp = new DhcpInfo();
        dhcp.leaseDuration = 86400;
        dhcp.gateway = 0x010FA8C0; // 192.168.15.1
        Fixtures.wifi().setDhcpInfo(dhcp);
        return Fixtures.wifiNetwork(homeLink(), NetworkCapabilities.NET_CAPABILITY_INTERNET,
                NetworkCapabilities.NET_CAPABILITY_VALIDATED, NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
    }

    private static ScanResult ap(String ssid, String bssid, String caps, int level, int frequency, int width, int center0,
                                 long heardMsAgo) {
        ScanResult r = Fixtures.scanResult(ssid, bssid, caps, level, frequency);
        r.channelWidth = width;
        r.centerFreq0 = center0;
        r.centerFreq1 = 0;
        r.timestamp = (SystemClock.elapsedRealtime() - heardMsAgo) * 1000;
        return r;
    }

    /** A vizinhança: tudo o que costuma dar errado numa lista de redes de verdade, de uma vez. */
    private static List<ScanResult> neighbourhood() {
        List<ScanResult> list = new ArrayList<>();
        ScanResult home = ap("Casa 5G", AP_HOME.toUpperCase(), "[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][WPS]", -48, 5180,
                ScanResult.CHANNEL_WIDTH_80MHZ, 5210, 400);
        ReflectionHelpers.setField(home, "flags", 0x2L); // 802.11mc
        if (Build.VERSION.SDK_INT >= 30) {
            ReflectionHelpers.setField(home, "informationElements", new ScanResult.InformationElement[] {
                Fixtures.element(0, 0, "Casa 5G".getBytes(StandardCharsets.UTF_8)),
                Fixtures.element(48, 0, new byte[] {0x01, 0x00, 0x00, 0x0f, (byte) 0xac, 0x04}),
                Fixtures.element(255, 35, new byte[] {(byte) 0xff, 0x00}),
                Fixtures.element(221, 0, new byte[0]),
                Fixtures.element(7, 0, null),
                null,
            });
            ReflectionHelpers.callInstanceMethod(home, "setWifiStandard", ClassParameter.from(int.class, 6));
        }
        if (Build.VERSION.SDK_INT >= 33) {
            ReflectionHelpers.callInstanceMethod(home, "setApMldMacAddress",
                    ClassParameter.from(MacAddress.class, MacAddress.fromString("02:AB:CD:EF:00:11")));
        }
        list.add(home);

        ScanResult mesh = ap("Casa 5G", AP_MESH.toUpperCase(), "[WPA2-PSK-CCMP][ESS]", -67, 2437,
                ScanResult.CHANNEL_WIDTH_20MHZ, 0, 900);
        ReflectionHelpers.setField(mesh, "flags", 0x2L);
        list.add(mesh);

        list.add(ap("", "0C:11:22:33:44:55", "[ESS]", -80, 5500, ScanResult.CHANNEL_WIDTH_40MHZ, 5510, 2500)); // oculta
        list.add(ap("\u0000\u0000\u0000\u0000", "0C:11:22:33:44:56", "[WEP][ESS]", -85, 2412, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 3000));
        list.add(ap("<unknown ssid>", "0C:11:22:33:44:57", "[WPA-PSK-TKIP][ESS]", -88, 2462, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 3100));
        list.add(ap("Café \"do\" João <b>&amp;", "0C:11:22:33:44:58", "", -70, 2462, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 50));

        ScanResult hotspot = ap("Aeroporto", "0C:11:22:33:44:59", "[RSN-EAP-CCMP][ESS]", -75, 5745,
                ScanResult.CHANNEL_WIDTH_80MHZ, 5775, 1200);
        ReflectionHelpers.setField(hotspot, "flags", 0x1L); // passpoint
        hotspot.venueName = "Aeroporto de Congonhas";
        hotspot.operatorFriendlyName = "  Operadora X ";
        list.add(hotspot);

        // o mesmo roteador duas vezes (trocou de canal há pouco): só a leitura mais nova pode sair
        list.add(ap("Vizinho", "DE:AD:BE:EF:00:01", "[WPA2-PSK-CCMP][ESS]", -60, 2412, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 9000));
        list.add(ap("Vizinho", "de:ad:be:ef:00:01", "[WPA2-PSK-CCMP][ESS]", -71, 2462, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 300));

        list.add(null);                                                    // lixo que alguns aparelhos devolvem
        list.add(ap("sem bssid", null, "[ESS]", -50, 2437, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 100));
        ScanResult unstamped = ap("sem hora", "0C:11:22:33:44:5A", "[ESS]", -66, 5200, ScanResult.CHANNEL_WIDTH_20MHZ, 0, 0);
        unstamped.timestamp = 0;
        unstamped.capabilities = null;
        list.add(unstamped);
        return list;
    }

    private void everythingOn() throws Exception {
        Fixtures.grantLocation();
        Fixtures.setLocationEnabled(true);
        Fixtures.wifiManager().setWifiEnabled(true);
        Fixtures.wifi().setScanResults(neighbourhood());
        connectHome("Casa 5G", AP_HOME.toUpperCase());
    }

    // ------------------------------------------------------------------ chamadas conferidas

    /** Chamada imediata que tem de dar certo: confere a forma na hora. */
    private JSONObject call(String method, String args) throws Exception {
        String json = bridge.call(method, args);
        ContractSchema.assertResult(method, json);
        samples.add(new String[] {"result", method, json, null});
        return new JSONObject(json);
    }

    /** Chamada imediata que tem de falhar com {error}. */
    private String refuse(String method, String args) throws Exception {
        String json = bridge.call(method, args);
        ContractSchema.assertError(json);
        return new JSONObject(json).getString("error");
    }

    private int async(Bridge target, String method, String args) {
        int id = nextId++;
        asked.put(id, method);
        target.callAsync(id, method, args);
        return id;
    }

    private int async(String method, String args) {
        return async(bridge, method, args);
    }

    private JSONObject answer(int id) throws Exception {
        Fixtures.idle();
        return page.awaitResolved(id, 20_000);
    }

    private JSONObject resolvedNow(int id) throws Exception {
        Fixtures.idle();
        return page.resolved(id);
    }

    private void systemAnnouncesScan(boolean updated) {
        Intent intent = new Intent(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
        intent.putExtra(WifiManager.EXTRA_RESULTS_UPDATED, updated);
        activity.sendBroadcast(intent);
        Fixtures.idle();
    }

    private void dialogAnswered(int[] results, long afterMs) {
        ShadowSystemClock.advanceBy(afterMs, TimeUnit.MILLISECONDS);
        for (Bridge b : new ArrayList<>(bridges)) b.onPermissionsResult(Permissions.REQUEST_LOCATION, BOTH, results);
        Fixtures.idle();
    }

    private void rationale(boolean show) {
        shadowOf(activity.getPackageManager()).setShouldShowRequestPermissionRationale(Fixtures.FINE, show);
    }

    /**
     * A conferência de fim de teste. Passa pelo esquema tudo o que chegou à página e garante:
     *   - só os três formatos de script do contrato (resolve, emit; "back" não passa por aqui);
     *   - eventos só com os nomes do contrato;
     *   - cada callAsync respondido exatamente uma vez (ou nenhuma, quando combinado), só com ids pedidos.
     */
    private void verifyEverythingThePageReceived() throws Exception {
        Fixtures.idle();
        Map<Integer, Integer> answers = new HashMap<>();
        for (String script : page.scripts()) {
            Matcher emit = EMIT.matcher(script);
            if (emit.matches()) {
                ContractSchema.assertEvent(emit.group(1), emit.group(2));
                samples.add(new String[] {"event", emit.group(1), emit.group(2), script});
                continue;
            }
            Matcher resolve = RESOLVE.matcher(script);
            assertTrue("script fora do contrato: " + script, resolve.matches());
            int id = Integer.parseInt(resolve.group(1));
            String method = asked.get(id);
            assertNotNull("resposta para um id que ninguém pediu: " + script, method);
            Integer seen = answers.get(id);
            answers.put(id, seen == null ? 1 : seen + 1);
            String json = resolve.group(2);
            JSONObject parsed = new JSONObject(json);
            if (parsed.length() == 1 && parsed.has("error")) { // {error} sozinho = a chamada falhou
                ContractSchema.assertError(json);
                assertTrue(method + " (id " + id + ") não devia falhar: " + json, mustFail.contains(id));
                samples.add(new String[] {"reject", method, json, script});
            } else {
                assertFalse(method + " (id " + id + ") devia ter falhado: " + json, mustFail.contains(id));
                ContractSchema.assertResult(method, json);
                samples.add(new String[] {"resolve", method, json, script});
            }
        }
        for (Map.Entry<Integer, String> e : asked.entrySet()) {
            Integer count = answers.get(e.getKey());
            if (mustStaySilent.contains(e.getKey())) {
                assertNull(e.getValue() + " (id " + e.getKey() + ") não podia ter resposta", count);
            } else {
                assertEquals(e.getValue() + " (id " + e.getKey() + ") respondido exatamente uma vez", Integer.valueOf(1), count);
            }
        }
        for (Bridge b : bridges) assertEquals("nenhuma chamada ficou pendurada", 0, b.pendingCalls());
        crossCheckWithTheJavaScriptSide();
    }

    // ------------------------------------------------------------------ conferência cruzada com o JS

    private static Boolean nodeAvailable;

    private static boolean hasNode() {
        if (nodeAvailable == null) {
            try {
                Process p = new ProcessBuilder("node", "--version").redirectErrorStream(true).start();
                nodeAvailable = p.waitFor(20, TimeUnit.SECONDS) && p.exitValue() == 0;
            } catch (Exception e) {
                nodeAvailable = false;
            }
        }
        return nodeAvailable;
    }

    /** Um arquivo do repositório (fora de android/), quando o módulo está dentro dele. */
    private static File repoFile(String path) {
        return new File(System.getProperty("user.dir"), "../../" + path);
    }

    /**
     * As amostras deste teste vistas pelo lado JavaScript, de duas formas:
     *   1. pela forma: tests/helpers/contract.mjs, o conferidor com que o simulador é testado;
     *   2. pelo caminho de verdade: app/js/bridge.js rodando no Node com um window.WrxNative de
     *      mentira. Cada script que o lado nativo mandaria ao WebView é EXECUTADO, e o que a
     *      interface recebe (valor da Promise, dados do evento, erro) tem de ser igual ao JSON.
     * Sem Node ou fora do repositório completo não há o que comparar e esta parte é pulada (o
     * esquema em Java já rodou).
     */
    private void crossCheckWithTheJavaScriptSide() throws Exception {
        File contract = repoFile("tests/helpers/contract.mjs");
        File bridgeJs = repoFile("app/js/bridge.js");
        if (samples.isEmpty() || !contract.isFile() || !bridgeJs.isFile() || !hasNode()) return;
        StringBuilder json = new StringBuilder("[");
        for (int i = 0; i < samples.size(); i++) {
            String[] s = samples.get(i);
            if (i > 0) json.append(",\n");
            json.append("{\"kind\":").append(JSONObject.quote(s[0])).append(",\"name\":").append(JSONObject.quote(s[1]))
                    .append(",\"raw\":").append(JSONObject.quote(s[2]))
                    .append(",\"script\":").append(s[3] == null ? "null" : JSONObject.quote(s[3]))
                    .append(",\"value\":").append(s[2]).append('}');
        }
        json.append(']');
        File data = tmp.newFile();
        try (FileOutputStream out = new FileOutputStream(data)) {
            out.write(json.toString().getBytes(StandardCharsets.UTF_8));
        }
        String script = String.join("\n",
                "import { readFileSync } from 'node:fs';",
                "import { pathToFileURL } from 'node:url';",
                "import { isDeepStrictEqual } from 'node:util';",
                "const [contractPath, bridgePath, samplesPath] = process.argv.slice(2);",
                "const contract = await import(pathToFileURL(contractPath).href);",
                "const samples = JSON.parse(readFileSync(samplesPath, 'utf8'));",
                "let bad = 0;",
                "const fail = (s, why) => { bad += 1; console.log(`${s.kind} ${s.name}: ${why} <- ${s.raw.slice(0, 500)}`); };",
                "// 1. a forma, pelo conferidor do simulador",
                "for (const s of samples) {",
                "  if (s.kind === 'reject') continue;",
                "  const problems = s.kind === 'event' ? contract.checkEvent(s.name, s.value, { simEvents: false }) : contract.checkResult(s.name, s.value);",
                "  if (problems.length) fail(s, problems.join(' | '));",
                "}",
                "// 2. o caminho de verdade, por app/js/bridge.js",
                "globalThis.window = globalThis;",
                "let current = null;",
                "globalThis.WrxNative = {",
                "  call(method, argsJson) {",
                "    if (typeof JSON.parse(argsJson) !== 'object') throw new Error('argumentos fora do combinado');",
                "    if (method !== current.name) throw new Error(`esperava ${current.name}, veio ${method}`);",
                "    return current.raw;",
                "  },",
                "  callAsync(id, method, argsJson) {",
                "    if (typeof JSON.parse(argsJson) !== 'object') throw new Error('argumentos fora do combinado');",
                "    if (method !== current.name) throw new Error(`esperava ${current.name}, veio ${method}`);",
                "    current.id = id;",
                "  },",
                "};",
                "const bridge = await import(pathToFileURL(bridgePath).href);",
                "await bridge.connect('native');",
                "let collisions = 0;",
                "for (const s of samples) {",
                "  current = s;",
                "  try {",
                "    if (s.kind === 'result') {",
                "      const out = await bridge[s.name]();",
                "      if (!isDeepStrictEqual(out, s.value)) fail(s, 'a interface recebeu outra coisa: ' + JSON.stringify(out));",
                "    } else if (s.kind === 'event') {",
                "      const got = [];",
                "      const off = bridge.on(s.name, (data) => got.push(data));",
                "      (0, eval)(s.script);",
                "      off();",
                "      if (got.length !== 1 || !isDeepStrictEqual(got[0], s.value)) fail(s, 'o evento chegou diferente: ' + JSON.stringify(got));",
                "    } else {",
                "      const promise = bridge[s.name]();",
                "      if (typeof current.id !== 'number') { fail(s, 'bridge.js não chamou callAsync'); continue; }",
                "      (0, eval)(s.script.replace(/resolve\\((-?\\d+),/, `resolve(${current.id},`));",
                "      const settled = await promise.then((value) => ({ value }), (error) => ({ error }));",
                "      if (s.kind === 'reject') {",
                "        if (!settled.error || settled.error.message !== s.value.error) fail(s, 'a falha não chegou como erro: ' + JSON.stringify(settled));",
                "      } else if (settled.error && typeof s.value.error === 'string' && settled.error.message === s.value.error) {",
                "        collisions += 1; // resultado com campo `error` (SpeedSummary que falhou): bridge.js o entrega como exceção",
                "      } else if (settled.error || !isDeepStrictEqual(settled.value, s.value)) {",
                "        fail(s, 'a Promise terminou diferente: ' + JSON.stringify(settled.error ? String(settled.error) : settled.value));",
                "      }",
                "    }",
                "  } catch (err) {",
                "    fail(s, 'exceção: ' + err);",
                "  }",
                "}",
                "console.log(`conferidas ${samples.length}, fora do contrato ${bad}, resultados entregues como exceção ${collisions}`);",
                "process.exit(bad ? 1 : 0);");
        File checker = tmp.newFile("conferir" + samples.size() + ".mjs");
        try (FileOutputStream out = new FileOutputStream(checker)) {
            out.write(script.getBytes(StandardCharsets.UTF_8));
        }
        Process p = new ProcessBuilder("node", checker.getAbsolutePath(), contract.getCanonicalPath(), bridgeJs.getCanonicalPath(),
                data.getAbsolutePath()).redirectErrorStream(true).start();
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) output.append(line).append('\n');
        }
        assertTrue("o conferidor JavaScript não terminou", p.waitFor(60, TimeUnit.SECONDS));
        assertEquals("o lado JavaScript não aceita o que o Android mandou:\n" + output, 0, p.exitValue());
        crossChecked += samples.size();
    }

    /** Quantas amostras deste teste passaram também pelo lado JavaScript (0 = sem Node, conferência pulada). */
    private int crossChecked;

    // ------------------------------------------------------------------ respostas imediatas

    @Test
    public void everyImmediateMethodOnAPhoneWithEverythingOn() throws Exception {
        everythingOn();
        bridge.onStart();
        bridge.onResume();

        JSONObject info = call("info", "{}");
        assertEquals(Build.VERSION.SDK_INT, info.get("sdk"));

        JSONObject status = call("status", "{}");
        assertEquals(true, status.get("canScan"));
        assertEquals("antes do Android 11 não dá para saber", Build.VERSION.SDK_INT < 30, status.isNull("throttled"));

        JSONObject scan = call("lastScan", "{}");
        JSONArray aps = scan.getJSONArray("aps");
        assertEquals("9 redes de verdade na vizinhança (a repetida conta uma vez; as sem BSSID ficam de fora)", 9, aps.length());
        JSONObject home = aps.getJSONObject(0);
        assertEquals(AP_HOME, home.get("bssid"));
        assertEquals(Build.VERSION.SDK_INT >= 30, home.has("ies"));
        assertEquals(Build.VERSION.SDK_INT >= 30, home.has("wifiStandard"));
        assertEquals(Build.VERSION.SDK_INT >= 33, home.has("mld"));
        assertTrue(home.getLong("ageMs") >= 400 && home.getLong("ageMs") < 1000);

        JSONObject c = call("connection", "{}");
        assertEquals(true, c.get("connected"));
        assertEquals("Casa 5G", c.get("ssid"));
        assertEquals(AP_HOME, c.get("bssid"));
        assertEquals("192.168.15.1", c.get("gateway"));
        assertEquals(86400, c.get("leaseSec"));
        assertEquals(Build.VERSION.SDK_INT >= 29, c.has("mtu"));

        call("watchRssi", "{\"intervalMs\":250}");
        ShadowLooper.idleMainLooper(1, TimeUnit.SECONDS);
        assertFalse("o evento 'rssi' sai enquanto a tela está visível", page.events("rssi").isEmpty());
        call("unwatchRssi", "{}");

        for (String which : new String[] {"wifi", "location", "app", "developer", "panel"}) {
            assertEquals(true, call("openSettings", "{\"which\":\"" + which + "\"}").get("ok"));
        }
        call("keepAwake", "{\"on\":true}");
        call("keepAwake", "{\"on\":false}");
        call("vibrate", "{\"ms\":20}");
        call("vibrate", "{}");
        call("setBars", "{\"color\":\"#0a0f1c\",\"dark\":true}");
        call("setBars", "{\"color\":\"#fff\"}");
        call("share", "{\"title\":\"Relatório\",\"text\":\"linha 1\\nlinha 2\"}");
        call("share", "{\"text\":\"só o texto\"}");
        call("saveFile", "{\"name\":\"redes.csv\",\"mime\":\"text/csv\",\"text\":\"a;b\\n\"}");
        call("saveFile", "{\"name\":\"mapa.bin\",\"base64\":\"AAECAw==\"}");
        for (String op : new String[] {"ping", "lan", "speed"}) call("cancel", "{\"op\":\"" + op + "\"}");
        verifyEverythingThePageReceived();
    }

    @Test
    public void everyImmediateMethodOnAPhoneWithEverythingOff() throws Exception {
        Fixtures.denyLocation();
        Fixtures.setLocationEnabled(false);
        Fixtures.wifiManager().setWifiEnabled(false);
        Fixtures.wifi().setIsScanAlwaysAvailable(false);
        Fixtures.wifi().setScanResults(new ArrayList<>());
        Fixtures.noNetworks();
        bridge.onStart();
        bridge.onResume();

        call("info", "{}");
        JSONObject status = call("status", "{}");
        assertEquals(false, status.get("canScan"));
        assertEquals(0, call("lastScan", "{}").getJSONArray("aps").length());
        assertEquals("desconectado só diz isso", 1, call("connection", "{}").length());
        call("watchRssi", "{}");
        ShadowLooper.idleMainLooper(3, TimeUnit.SECONDS);
        assertTrue("sem sinal para medir não há evento 'rssi'", page.events("rssi").isEmpty());
        call("unwatchRssi", "{}");
        verifyEverythingThePageReceived();
    }

    @Test
    public void statusInEveryCombination() throws Exception {
        bridge.onStart();
        for (int mask = 0; mask < 8; mask++) {
            boolean wifi = (mask & 1) != 0;
            boolean location = (mask & 2) != 0;
            boolean granted = (mask & 4) != 0;
            Fixtures.wifiManager().setWifiEnabled(wifi);
            Fixtures.setLocationEnabled(location);
            if (granted) Fixtures.grantLocation();
            else Fixtures.denyLocation();
            JSONObject s = call("status", "{}");
            assertEquals(wifi, s.get("wifiEnabled"));
            assertEquals(location, s.get("locationEnabled"));
            assertEquals(granted ? "granted" : "denied", s.get("permission"));
            activity.sendBroadcast(new Intent(WifiManager.WIFI_STATE_CHANGED_ACTION)); // vira evento 'status'
            Fixtures.idle();
        }
        assertFalse(page.events("status").isEmpty());
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ varredura

    @Test
    public void scanListsNeverRepeatABssidAndAlwaysUseLowerCase() throws Exception {
        everythingOn();
        bridge.onStart();
        JSONArray aps = call("lastScan", "{}").getJSONArray("aps");
        Map<String, JSONObject> byBssid = new HashMap<>();
        for (int i = 0; i < aps.length(); i++) {
            JSONObject a = aps.getJSONObject(i);
            assertNull("BSSID repetido: " + a.getString("bssid"), byBssid.put(a.getString("bssid"), a));
        }
        JSONObject neighbour = byBssid.get("de:ad:be:ef:00:01");
        assertNotNull(neighbour);
        assertEquals("das duas leituras do mesmo roteador fica a ouvida por último", 2462, neighbour.get("frequency"));
        assertEquals(-71, neighbour.get("level"));
        assertEquals("rede oculta", "", byBssid.get("0c:11:22:33:44:55").get("ssid"));
        assertEquals("nome só de zeros é rede oculta", "", byBssid.get("0c:11:22:33:44:56").get("ssid"));
        assertEquals("sentinela do Android não é nome", "", byBssid.get("0c:11:22:33:44:57").get("ssid"));
        assertEquals("o nome sai cru: quem escapa para a tela é a interface",
                "Café \"do\" João <b>&amp;", byBssid.get("0c:11:22:33:44:58").get("ssid"));
        assertEquals("Operadora X", byBssid.get("0c:11:22:33:44:59").get("operatorName"));
        assertEquals("", byBssid.get("0c:11:22:33:44:5a").get("capabilities"));

        // os dois caminhos do evento 'scan': pedido nosso e varredura do próprio sistema
        Fixtures.wifi().setStartScanSucceeds(true);
        assertEquals(true, answer(async("scan", "{}")).get("accepted"));
        systemAnnouncesScan(true);
        systemAnnouncesScan(true);
        systemAnnouncesScan(false);
        List<JSONObject> events = page.events("scan");
        assertEquals(3, events.size());
        assertEquals("request", events.get(0).get("source"));
        assertEquals("system", events.get(1).get("source"));
        assertEquals(false, events.get(2).get("fresh"));
        for (JSONObject e : events) assertEquals(aps.length(), e.getJSONArray("aps").length());
        verifyEverythingThePageReceived();
    }

    @Test
    public void scanRefusalsUseOnlyTheDocumentedReasons() throws Exception {
        everythingOn();
        Fixtures.wifi().setStartScanSucceeds(false);
        assertEquals(false, answer(async("scan", "{}")).get("accepted")); // throttled ou failed, conforme a versão
        Fixtures.wifiManager().setWifiEnabled(false);
        Fixtures.wifi().setIsScanAlwaysAvailable(false);
        assertEquals("wifi-off", answer(async("scan", "{}")).get("reason"));
        Fixtures.setLocationEnabled(false);
        assertEquals("location-off", answer(async("scan", "{}")).get("reason"));
        Fixtures.denyLocation();
        assertEquals("no-permission", answer(async("scan", "{}")).get("reason"));
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ conexão

    @Test
    public void connectionInEveryStateTheAndroidCanBeIn() throws Exception {
        Fixtures.grantLocation();
        bridge.onStart();

        // sem permissão o Android apaga nome e BSSID: os campos somem, não viram "" nem null
        Fixtures.denyLocation();
        connectHome(null, "02:00:00:00:00:00");
        JSONObject hiddenIdentity = call("connection", "{}");
        assertEquals(true, hiddenIdentity.get("connected"));
        assertFalse(hiddenIdentity.has("ssid"));
        assertFalse(hiddenIdentity.has("bssid"));
        assertEquals(-52, hiddenIdentity.get("rssi"));
        call("watchRssi", "{\"intervalMs\":250}");
        ShadowLooper.idleMainLooper(600, TimeUnit.MILLISECONDS);
        assertEquals("o BSSID escondido vira \"\" na amostra de sinal", "", page.lastEvent("rssi").get("bssid"));

        // conectado, com tudo
        Fixtures.grantLocation();
        connectHome("Casa 5G", AP_HOME.toUpperCase());
        JSONObject full = call("connection", "{}");
        assertEquals("Casa 5G", full.get("ssid"));
        ShadowLooper.idleMainLooper(600, TimeUnit.MILLISECONDS);
        assertEquals(AP_HOME, page.lastEvent("rssi").get("bssid"));

        // Wi-Fi só com IPv6: sem ip, sem prefix e sem gateway (o de IPv6 não serve à interface)
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"2804:14c:1:2::10/64"}, "fe80::1", "2001:4860:4860::8888"),
                NetworkCapabilities.NET_CAPABILITY_INTERNET);
        Fixtures.wifi().setDhcpInfo(new DhcpInfo());
        JSONObject v6 = call("connection", "{}");
        assertEquals(true, v6.get("connected"));
        assertFalse(v6.has("ip"));
        assertFalse(v6.has("prefix"));
        assertFalse("gateway é o roteador IPv4, par do ip", v6.has("gateway"));
        assertEquals(1, v6.getJSONArray("ipv6").length());
        assertFalse(v6.has("leaseSec"));

        // sinal inválido e velocidades desconhecidas somem em vez de virar -127 / -1 / 0
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo("Casa 5G", AP_HOME, -127, -1, 0));
        JSONObject noSignal = call("connection", "{}");
        for (String gone : new String[] {"rssi", "linkSpeed", "frequency", "txSpeed", "rxSpeed", "maxTxSpeed", "maxRxSpeed"}) {
            assertFalse(gone, noSignal.has(gone));
        }

        // desconectado
        Fixtures.noNetworks();
        assertEquals(1, call("connection", "{}").length());
        ShadowLooper.idleMainLooper(2, TimeUnit.SECONDS); // os eventos 'connection' das mudanças acima
        assertFalse(page.events("connection").isEmpty());
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ permissão

    @Test
    public void permissionRequestResolvesWithAStatusWhateverTheUserDoes() throws Exception {
        Fixtures.denyLocation();
        rationale(false);

        int first = async("requestPermission", "{}");
        int second = async("requestPermission", "{}"); // pega carona no mesmo diálogo
        assertNull(resolvedNow(first));
        rationale(true);
        dialogAnswered(DENIED, 3000);
        assertEquals("denied", answer(first).get("permission"));
        assertEquals("denied", answer(second).get("permission"));

        // diálogo fechado sem escolha: o Android devolve vetores vazios
        int dismissed = async("requestPermission", "{}");
        ShadowSystemClock.advanceBy(2, TimeUnit.SECONDS);
        bridge.onPermissionsResult(Permissions.REQUEST_LOCATION, new String[0], new int[0]);
        assertEquals("denied", answer(dismissed).get("permission"));

        int again = async("requestPermission", "{}");
        rationale(false);
        dialogAnswered(DENIED, 3000);
        assertEquals("blocked", answer(again).get("permission"));

        // bloqueada: o pedido seguinte é recusado pelo Android na hora e ainda assim responde
        int blocked = async("requestPermission", "{}");
        dialogAnswered(DENIED, 30);
        assertEquals("blocked", answer(blocked).get("permission"));

        // liberada pelas configurações: responde sem diálogo
        Fixtures.grantLocation();
        assertEquals("granted", answer(async("requestPermission", "{}")).get("permission"));

        // concedida pelo diálogo
        Fixtures.denyLocation();
        int granted = async("requestPermission", "{}");
        Fixtures.grantLocation();
        dialogAnswered(GRANTED, 2500);
        assertEquals("granted", answer(granted).get("permission"));
        assertTrue("cada resposta vem acompanhada do evento 'status'", page.events("status").size() >= 6);
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ RTT

    private void answerNearbyDialogIfShown() {
        ShadowActivity.PermissionsRequest request = shadowOf(activity).getLastRequestedPermission();
        if (request != null && request.requestCode == Permissions.REQUEST_NEARBY) {
            bridge.onPermissionsResult(Permissions.REQUEST_NEARBY, request.requestedPermissions,
                    new int[] {PackageManager.PERMISSION_DENIED});
            Fixtures.idle();
        }
    }

    @Test
    public void rttAnswersOneResultPerRealBssid() throws Exception {
        everythingOn();
        shadowOf(activity.getPackageManager()).setSystemFeature(RTT_FEATURE, true);
        if (Build.VERSION.SDK_INT >= 28) {
            WifiRttManager manager = (WifiRttManager) activity.getSystemService(Context.WIFI_RTT_RANGING_SERVICE);
            List<RangingResult> measured = new ArrayList<>();
            measured.add(new RangingResultBuilder(RangingResult.STATUS_SUCCESS, MacAddress.fromString(AP_HOME), 1000L, 4321)
                    .setDistanceStandardDeviation(150).setRssi(-48).setNumAttemptedMeasurements(8).setNumSuccessfulMeasurements(7).build());
            measured.add(new RangingResultBuilder(RangingResult.STATUS_FAIL, MacAddress.fromString(AP_MESH), 1000L, 0).build());
            shadowOf(manager).setRangeResults(measured);
        }
        // maiúsculas, espaços, repetido, fora da varredura e três coisas que não são um BSSID
        int id = async("rtt", new JSONObject().put("bssids", new JSONArray(Arrays.asList(
                AP_HOME.toUpperCase(), " " + AP_MESH + " ", AP_HOME, "de:ad:be:ef:99:99", "não é mac", "", "aa:bb:cc:dd:ee",
                "<img src=x onerror=alert(1)>"))).toString());
        Fixtures.idle();
        answerNearbyDialogIfShown();
        JSONArray results = answer(id).getJSONArray("results");
        if (Build.VERSION.SDK_INT < 28) {
            assertEquals("sem RTT nesta versão do Android", 0, results.length());
        } else {
            assertEquals("só os três BSSID de verdade, na ordem do pedido", 3, results.length());
            assertEquals(AP_HOME, results.getJSONObject(0).get("bssid"));
            assertEquals(true, results.getJSONObject(0).get("ok"));
            assertEquals("milímetros viram metros", 4.321, results.getJSONObject(0).getDouble("distM"), 1e-9);
            assertEquals(0.15, results.getJSONObject(0).getDouble("stdM"), 1e-9);
            assertEquals(AP_MESH, results.getJSONObject(1).get("bssid"));
            assertEquals(false, results.getJSONObject(1).get("ok"));
            assertEquals("de:ad:be:ef:99:99", results.getJSONObject(2).get("bssid"));
        }
        assertEquals(0, answer(async("rtt", "{\"bssids\":[]}")).getJSONArray("results").length());
        assertEquals(0, answer(async("rtt", "{\"bssids\":[1,null,{},\"zz:zz:zz:zz:zz:zz\"]}")).getJSONArray("results").length());
        for (String bad : new String[] {"{}", "{\"bssids\":\"" + AP_HOME + "\"}", "{\"bssids\":null}"}) mustFail.add(async("rtt", bad));

        shadowOf(activity.getPackageManager()).setSystemFeature(RTT_FEATURE, false);
        assertEquals(0, answer(async("rtt", "{\"bssids\":[\"" + AP_HOME + "\"]}")).getJSONArray("results").length());
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ ping

    private String fakePing(String body) throws Exception {
        File f = tmp.newFile();
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(("#!/bin/sh\n" + body + "\n").getBytes(StandardCharsets.UTF_8));
        }
        assertTrue(f.setExecutable(true));
        return f.getAbsolutePath();
    }

    @Test
    public void pingSummariesAndRepliesByTheProbePath() throws Exception {
        int ok = async("ping", "{\"host\":\"exemplo.com\",\"count\":3,\"timeoutMs\":300}");
        JSONObject summary = answer(ok);
        assertEquals("tcp", summary.get("method"));
        assertEquals(3, summary.get("sent"));
        assertEquals(3, summary.get("received"));
        assertEquals(0.0, summary.getDouble("lossPct"), 1e-9);
        assertEquals(12.5, summary.getDouble("avg"), 1e-9);

        // padrões e limites: sem count/timeoutMs valem 10 e 1000; exageros são contidos, nunca recusados
        assertEquals(10, answer(async("ping", "{\"host\":\"10.0.0.1\"}")).get("sent"));
        assertEquals(1, answer(async("ping", "{\"host\":\"10.0.0.1\",\"count\":-3,\"timeoutMs\":1e12}")).get("sent"));
        assertEquals(1, answer(async("ping", "{\"host\":\"10.0.0.1\",\"count\":0.2,\"timeoutMs\":-5}")).get("sent"));
        if (Build.VERSION.SDK_INT == 34) { // 10 s de série: uma versão do Android basta
            assertEquals(50, answer(async("ping", "{\"host\":\"10.0.0.1\",\"count\":1e9}")).get("sent"));
            assertEquals(10, answer(async("ping", "{\"host\":\"10.0.0.1\",\"count\":\"7\",\"timeoutMs\":null}")).get("sent"));
        }

        // ninguém responde: 100% de perda, sem estatísticas, e um evento ok:false por pacote enviado
        Bridge silent = newBridge(tcpPinger(-1), null, offlineSpeed());
        JSONObject lost = answer(async(silent, "ping", "{\"host\":\"10.9.9.9\",\"count\":5,\"timeoutMs\":200}"));
        assertEquals(0, lost.get("received"));
        assertEquals(100.0, lost.getDouble("lossPct"), 1e-9);
        assertFalse(lost.has("min"));
        int lostReplies = 0;
        for (JSONObject reply : page.events("ping")) {
            if (!"10.9.9.9".equals(reply.get("host"))) continue;
            assertEquals(false, reply.get("ok"));
            lostReplies++;
        }
        assertEquals(lost.getInt("sent"), lostReplies);

        // erros: destino inválido (recusado antes de qualquer coisa) e nome que não resolve
        for (String bad : new String[] {"{}", "{\"host\":\"\"}", "{\"host\":\"-c 5 8.8.8.8\"}", "{\"host\":\"a b\"}", "{\"host\":5}"}) {
            int id = async("ping", bad);
            mustFail.add(id);
            assertEquals(Pinger.ERR_INVALID_HOST, answer(id).get("error"));
        }
        int unknown = async("ping", "{\"host\":\"nao-existe.exemplo\"}");
        mustFail.add(unknown);
        assertEquals(Pinger.ERR_UNKNOWN_HOST, answer(unknown).get("error"));
        verifyEverythingThePageReceived();
    }

    @Test
    public void pingByTheSystemProgramWithLossAndCancel() throws Exception {
        assumeTrue(new File("/bin/sh").canExecute());
        String lossy = fakePing(String.join("\n",
                "echo 'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.'",
                "echo '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms'",
                "echo '64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=13.9 ms'",
                "echo 'From 192.168.0.1 icmp_seq=3 Destination Host Unreachable'",
                "echo '64 bytes from 8.8.8.8: icmp_seq=4 ttl=117 time=0.412 ms'",
                "echo '64 bytes from 8.8.8.8: icmp_seq=4 ttl=117 time=0.9 ms (DUP!)'",
                "echo '5 packets transmitted, 3 received, 40% packet loss, time 807ms'",
                "exit 1"));
        Bridge icmp = newBridge(new Pinger(lossy, null, InetAddress::getByName, new Pinger.Prober[] {(a, t) -> -1}, watchdog), null, offlineSpeed());
        JSONObject s = answer(async(icmp, "ping", "{\"host\":\"8.8.8.8\",\"count\":5}"));
        assertEquals("icmp", s.get("method"));
        assertEquals(5, s.get("sent"));
        assertEquals(3, s.get("received"));
        assertEquals(40.0, s.getDouble("lossPct"), 1e-9);
        assertEquals(0.412, s.getDouble("min"), 1e-9);
        List<JSONObject> replies = page.events("ping");
        assertEquals("um evento por pacote enviado, sem repetir o duplicado", 5, replies.size());
        Set<Integer> seqs = new HashSet<>();
        for (JSONObject r : replies) assertTrue("seq repetido", seqs.add(r.getInt("seq")));
        assertEquals(new HashSet<>(Arrays.asList(1, 2, 3, 4, 5)), seqs);

        // cancelado no meio: resumo parcial, respondido uma vez só
        String slow = fakePing("echo '64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms'\nexec sleep 30");
        Bridge hanging = newBridge(new Pinger(slow, null, InetAddress::getByName, new Pinger.Prober[] {(a, t) -> -1}, watchdog), null, offlineSpeed());
        int id = async(hanging, "ping", "{\"host\":\"8.8.8.8\",\"count\":20}");
        long deadline = System.currentTimeMillis() + 10_000;
        while (page.events("ping").size() < 6 && System.currentTimeMillis() < deadline) Thread.sleep(20);
        assertEquals("{\"ok\":true}", hanging.call("cancel", "{\"op\":\"ping\"}"));
        JSONObject partial = answer(id);
        assertEquals(1, partial.get("received"));
        assertEquals(1, partial.get("sent"));
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ rede local

    @Test
    public void lanScanEmitsDevicesProgressAndTheSameListInTheAnswer() throws Exception {
        // fora do Wi-Fi: lista vazia e um progresso 0/0, não um erro
        Fixtures.noNetworks();
        assertEquals(0, answer(async("lanScan", "{}")).getJSONArray("devices").length());
        assertEquals(0, page.lastEvent("lanProgress").get("total"));

        everythingOn();
        JSONArray devices = answer(async("lanScan", "{\"ignorado\":true}")).getJSONArray("devices");
        Map<String, JSONObject> byIp = new HashMap<>();
        for (int i = 0; i < devices.length(); i++) byIp.put(devices.getJSONObject(i).getString("ip"), devices.getJSONObject(i));
        assertEquals(4, devices.length());
        JSONObject router = byIp.get("192.168.15.1");
        assertEquals(true, router.get("gateway"));
        assertEquals("roteador.lan", router.get("host"));
        assertEquals("a4:91:b1:00:11:22", router.get("mac"));
        assertEquals(true, byIp.get("192.168.15.37").get("self"));
        assertFalse(byIp.get("192.168.15.37").has("ms"));
        assertEquals("DESKTOP-ANA", byIp.get("192.168.15.40").get("host"));
        assertEquals("quem só aparece na tabela ARP entra com o MAC", "0c:11:22:33:44:55", byIp.get("192.168.15.77").get("mac"));
        assertEquals(devices.length(), page.events("lan").size());
        JSONObject last = page.lastEvent("lanProgress");
        assertEquals(254, last.get("total"));
        assertEquals(254, last.get("done"));

        // cancelada: responde na hora com o que já achou, uma vez só
        lan.hold = new CountDownLatch(1);
        int id = async("lanScan", "{}");
        Thread.sleep(150);
        assertEquals("{\"ok\":true}", bridge.call("cancel", "{\"op\":\"lan\"}"));
        assertNotNull(answer(id).getJSONArray("devices"));
        lan.hold.countDown();
        lan.hold = null;
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ velocidade

    @Test
    public void speedTestSummariesAndProgressInEveryOutcome() throws Exception {
        try {
            server = new FakeSpeedServer();
        } catch (java.io.IOException e) {
            assumeTrue("sem rede local neste ambiente", false);
        }
        everythingOn();
        SpeedTester.Openers local = network -> url -> (HttpURLConnection) url.openConnection();
        SpeedTester.Plan quick = new SpeedTester.Plan(0.7, 0.1, 3_000_000L, 1_500_000L, 3, 2, 2, 400_000L, 200_000L);
        Bridge fast = newBridge(null, null, new SpeedTester(server.baseUrl(), local, quick));

        JSONObject ok = answer(async(fast, "speedTest", "{\"mode\":\"light\"}"));
        assertEquals(ok.toString(), true, ok.get("ok"));
        assertEquals("GRU", ok.get("server"));
        assertTrue(ok.getLong("bytesDown") > 0 && ok.getLong("bytesUp") > 0);
        Set<String> phases = new HashSet<>();
        for (JSONObject p : page.events("speed")) phases.add(p.getString("phase"));
        assertEquals(new HashSet<>(Arrays.asList("latency", "download", "upload")), phases);
        assertEquals(true, answer(async(fast, "speedTest", "{}")).get("ok")); // sem modo vale 'full'

        // servidor recusando: falha do teste
        server.downStatus = 503;
        JSONObject failed = answer(async(fast, "speedTest", "{\"mode\":\"full\"}"));
        assertEquals(false, failed.get("ok"));
        assertEquals("failed", failed.get("error"));
        server.downStatus = 200;

        // cancelado no meio
        server.chunkPauseMs = 40;
        Bridge slow = newBridge(null, null, new SpeedTester(server.baseUrl(), local,
                new SpeedTester.Plan(20, 0.1, Long.MAX_VALUE, Long.MAX_VALUE, 2, 1, 1, 50_000_000L, 1_000_000L)));
        int id = async(slow, "speedTest", "{\"mode\":\"full\"}");
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline) {
            boolean downloading = false;
            for (JSONObject p : page.events("speed")) if ("download".equals(p.getString("phase")) && p.getDouble("progress") < 1) downloading = true;
            if (downloading && slow.pendingCalls() == 1) break;
            Thread.sleep(50);
        }
        assertEquals("{\"ok\":true}", slow.call("cancel", "{\"op\":\"speed\"}"));
        JSONObject cancelled = answer(id);
        assertEquals(false, cancelled.get("ok"));
        assertEquals("cancelled", cancelled.get("error"));
        server.chunkPauseMs = 0;

        // fora do Wi-Fi e sem internet: 'offline'
        assertEquals("offline", answer(async("speedTest", "{\"mode\":\"light\"}")).get("error"));
        Fixtures.noNetworks();
        assertEquals("offline", answer(async(fast, "speedTest", "{\"mode\":\"light\"}")).get("error"));

        for (String bad : new String[] {"{\"mode\":\"turbo\"}", "{\"mode\":3}", "{\"mode\":null}"}) {
            int refused = async("speedTest", bad);
            mustFail.add(refused);
            assertTrue(answer(refused).getString("error").startsWith(Bridge.ERR_ARGS));
        }
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ erros

    @Test
    public void everyFailureIsASingleErrorField() throws Exception {
        everythingOn();
        String[] garbage = {"{", "[]", "\"texto\"", "42", "true", "{\"a\":}", "não é json"};
        for (String method : ContractSchema.RESULTS.keySet()) {
            for (String args : garbage) {
                if (ContractSchema.ASYNC.contains(method)) {
                    mustFail.add(async(method, args));
                    assertTrue(refuse(method, "{}").contains("callAsync")); // o caminho imediato também recusa
                } else {
                    assertTrue(refuse(method, args).startsWith(Bridge.ERR_ARGS));
                    mustFail.add(async(method, args)); // o mesmo erro pelo caminho assíncrono
                }
            }
        }
        // argumentos de tipo ou valor errado nos métodos que têm argumento obrigatório
        String[][] wrong = {
            {"openSettings", "{}"}, {"openSettings", "{\"which\":\"bluetooth\"}"}, {"openSettings", "{\"which\":7}"},
            {"openSettings", "{\"which\":\"android.settings.SETTINGS\"}"},
            {"keepAwake", "{}"}, {"keepAwake", "{\"on\":\"true\"}"}, {"keepAwake", "{\"on\":1}"}, {"keepAwake", "{\"on\":null}"},
            {"vibrate", "{\"ms\":\"20\"}"}, {"vibrate", "{\"ms\":null}"},
            {"watchRssi", "{\"intervalMs\":\"1000\"}"}, {"watchRssi", "{\"intervalMs\":null}"},
            {"setBars", "{}"}, {"setBars", "{\"color\":\"red\"}"}, {"setBars", "{\"color\":\"#12345\"}"}, {"setBars", "{\"color\":255}"},
            {"share", "{}"}, {"share", "{\"title\":\"sem texto\"}"}, {"share", "{\"text\":5}"},
            {"saveFile", "{}"}, {"saveFile", "{\"name\":\"a.txt\"}"}, {"saveFile", "{\"name\":\"  \",\"text\":\"x\"}"},
            {"saveFile", "{\"name\":\"a.txt\",\"text\":\"x\",\"base64\":\"eA==\"}"}, {"saveFile", "{\"name\":\"a.bin\",\"base64\":\"=\"}"},
            {"cancel", "{}"}, {"cancel", "{\"op\":\"tudo\"}"}, {"cancel", "{\"op\":null}"},
        };
        for (String[] w : wrong) assertTrue(w[0] + " " + w[1], refuse(w[0], w[1]).startsWith(Bridge.ERR_ARGS));
        for (String method : new String[] {"naoExiste", "", "INFO", "info ", "__proto__", "constructor", "toString", "emit", "onDestroy"}) {
            assertTrue(refuse(method, "{}").startsWith(Bridge.ERR_UNKNOWN));
            int id = async(method, "{}");
            asked.put(id, "info"); // qualquer um: tem de falhar
            mustFail.add(id);
        }
        assertNull("nada foi aberto por engano", shadowOf(activity).getNextStartedActivity());
        assertNull(shadowOf(activity).getLastRequestedPermission());
        verifyEverythingThePageReceived();
    }

    // ------------------------------------------------------------------ exatamente uma resposta

    @Test
    public void everyPendingCallIsAnsweredExactlyOnceWhenTheScreenDies() throws Exception {
        everythingOn();
        Fixtures.denyLocation(); // o pedido de permissão fica com o diálogo aberto
        final CountDownLatch release = new CountDownLatch(1);
        Pinger stuck = new Pinger("/nao/existe", null, host -> {
            release.await(20, TimeUnit.SECONDS);
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 5.0}, watchdog);
        lan.hold = release;
        SpeedTester hanging = new SpeedTester("http://127.0.0.1:9", network -> url -> {
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            throw new java.net.ConnectException("solto");
        }, null);
        Bridge b = newBridge(stuck, new LanScanner(lan, 4), hanging);

        int permission = async(b, "requestPermission", "{}");
        int ping = async(b, "ping", "{\"host\":\"preso.exemplo\"}");
        int scanLan = async(b, "lanScan", "{}");
        int speed = async(b, "speedTest", "{\"mode\":\"light\"}");
        int scan = async(b, "scan", "{}");
        Fixtures.idle();
        Thread.sleep(200);
        assertEquals("permissão, ping, rede local e velocidade seguem em andamento", 4, b.pendingCalls());
        assertNotNull(page.resolved(scan));
        mustFail.addAll(Arrays.asList(ping));

        b.onDestroy();
        assertEquals(0, b.pendingCalls());
        assertEquals("quem pediu permissão recebe o Status atual", "denied", page.resolved(permission).get("permission"));
        assertEquals(Bridge.ERR_CLOSED, page.resolved(ping).get("error"));
        assertNotNull(page.resolved(scanLan));
        assertNotNull(page.resolved(speed));
        // rede local e velocidade respondem com o que tinham ou com "encerrado", conforme quem chegou primeiro
        if (page.resolved(scanLan).length() == 1 && page.resolved(scanLan).has("error")) mustFail.add(scanLan);
        if (page.resolved(speed).length() == 1) mustFail.add(speed);

        // o trabalho que sobrou termina depois: nada mais chega à página
        int before = page.scripts().size();
        release.countDown();
        Thread.sleep(400);
        b.onPermissionsResult(Permissions.REQUEST_LOCATION, BOTH, DENIED);
        Fixtures.idle();
        assertEquals("nenhuma resposta ou evento depois de encerrado", before, page.scripts().size());
        lan.hold = null;
        verifyEverythingThePageReceived();
    }

    @Test
    public void aReloadedPageOrAForeignPageNeverGetsAnswers() throws Exception {
        everythingOn();
        final CountDownLatch release = new CountDownLatch(1);
        Pinger stuck = new Pinger("/nao/existe", null, host -> {
            release.await(20, TimeUnit.SECONDS);
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 5.0}, watchdog);
        Bridge b = newBridge(stuck, null, offlineSpeed());

        // página estranha na tela: nem resposta de erro recebe
        b.setPageUrl("https://evil.example/");
        for (String method : ContractSchema.RESULTS.keySet()) mustStaySilent.add(async(b, method, "{}"));
        assertEquals(Bridge.ERR_FORBIDDEN, new JSONObject(b.call("lastScan", "{}")).get("error"));
        Fixtures.idle();
        assertTrue(page.scripts().isEmpty());

        // página do app recarregada com uma chamada em andamento: a resposta antiga se perde
        b.setPageUrl(WebClient.START_URL);
        int old = async(b, "ping", "{\"host\":\"antiga.exemplo\",\"count\":1}");
        mustStaySilent.add(old);
        Thread.sleep(100);
        b.onNewPage();
        release.countDown();
        Thread.sleep(400);
        Fixtures.idle();
        assertNull(page.resolved(old));
        assertEquals(0, b.pendingCalls());
        verifyEverythingThePageReceived();
    }

    @Test
    public void aSupersededOperationStillGetsItsOwnAnswer() throws Exception {
        everythingOn();
        final CountDownLatch first = new CountDownLatch(1);
        Pinger pinger = new Pinger("/nao/existe", null, host -> {
            if (host.startsWith("primeiro")) first.await(20, TimeUnit.SECONDS);
            return InetAddress.getByAddress(new byte[] {10, 0, 0, 1});
        }, new Pinger.Prober[] {(a, t) -> 5.0}, watchdog);
        Bridge b = newBridge(pinger, new LanScanner(lan, 8), offlineSpeed());
        int one = async(b, "ping", "{\"host\":\"primeiro.exemplo\",\"count\":3}");
        Thread.sleep(100);
        int two = async(b, "ping", "{\"host\":\"segundo.exemplo\",\"count\":2}"); // um ping por vez: encerra o anterior
        assertEquals(2, answer(two).get("received"));
        first.countDown();
        JSONObject interrupted = answer(one);
        assertEquals("o anterior responde com o que tinha: nada", 0, interrupted.get("sent"));
        assertEquals(0, interrupted.get("received"));

        lan.hold = new CountDownLatch(1);
        int lanOne = async(b, "lanScan", "{}");
        Thread.sleep(150);
        CountDownLatch gate = lan.hold;
        lan.hold = null;
        int lanTwo = async(b, "lanScan", "{}");
        assertNotNull(answer(lanOne));
        gate.countDown();
        assertTrue(answer(lanTwo).getJSONArray("devices").length() >= 2);
        verifyEverythingThePageReceived();
    }

    @Test
    public void theSchemaItselfCatchesContractViolations() {
        // o conferidor não pode ser um carimbo: cada tipo de deslize tem de ser apontado
        String[][] broken = {
            {"status", "{\"wifiEnabled\":true,\"locationEnabled\":true,\"permission\":\"granted\",\"throttled\":null}"},              // falta canScan
            {"status", "{\"wifiEnabled\":true,\"locationEnabled\":true,\"permission\":\"granted\",\"throttled\":null,\"canScan\":false}"},  // conta errada
            {"status", "{\"wifiEnabled\":1,\"locationEnabled\":true,\"permission\":\"granted\",\"throttled\":null,\"canScan\":true}"},     // número no lugar de booleano
            {"status", "{\"wifiEnabled\":true,\"locationEnabled\":true,\"permission\":\"approximate\",\"throttled\":null,\"canScan\":false}"},
            {"connection", "{\"connected\":true,\"ssid\":null}"},                         // opcional com null
            {"connection", "{\"connected\":true,\"bssid\":\"A4:91:B1:00:11:22\"}"},      // maiúsculas
            {"connection", "{\"connected\":true,\"bssid\":\"02:00:00:00:00:00\"}"},      // sentinela
            {"connection", "{\"connected\":true,\"ssid\":\"\\\"Casa\\\"\"}"},             // aspas do Android
            {"connection", "{\"connected\":true,\"rssi\":-127}"},
            {"connection", "{\"connected\":true,\"linkSpeed\":-1}"},
            {"connection", "{\"connected\":true,\"gateway\":\"fe80::1\"}"},
            {"connection", "{\"connected\":true,\"ipv6\":[\"fe80::1%wlan0\"]}"},
            {"connection", "{\"connected\":true,\"dns\":[]}"},
            {"connection", "{\"connected\":false,\"ip\":\"10.0.0.2\"}"},
            {"connection", "{\"connected\":true,\"rssi\":\"-52\"}"},                     // texto no lugar de número
            {"connection", "{\"connected\":true,\"extra\":1}"},                           // campo desconhecido
            {"lastScan", "{\"ts\":1700000000000,\"fresh\":false,\"source\":\"cache\"}"},  // aps ausente
            {"lastScan", "{\"ts\":1700000000000,\"fresh\":false,\"source\":\"cache\",\"aps\":null}"},
            {"lastScan", "{\"ts\":1700000,\"fresh\":false,\"source\":\"cache\",\"aps\":[]}"},  // ts em segundos
            {"lastScan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[]}"},
            {"info", "{\"platform\":\"android\",\"sdk\":\"34\",\"release\":\"14\",\"manufacturer\":\"x\",\"model\":\"y\",\"appVersion\":\"1\","
                    + "\"bands\":{\"b24\":true,\"b5\":true,\"b6\":false,\"b60\":false},\"standards\":[],\"rtt\":false}"},
            {"scan", "{\"accepted\":false}"},
            {"scan", "{\"accepted\":true,\"reason\":\"throttled\"}"},
            {"scan", "{\"accepted\":false,\"reason\":\"sem vontade\"}"},
            {"rtt", "{\"results\":[{\"bssid\":\"aa:bb:cc:dd:ee:ff\",\"ok\":true}]}"},
            {"rtt", "{\"results\":[{\"bssid\":\"aa:bb:cc:dd:ee:ff\",\"ok\":false,\"distM\":2}]}"},
            {"rtt", "{\"results\":null}"},
            {"ping", "{\"host\":\"a\",\"method\":\"udp\",\"sent\":1,\"received\":0,\"lossPct\":100}"},
            {"ping", "{\"host\":\"a\",\"method\":\"icmp\",\"sent\":2,\"received\":1,\"lossPct\":0.5,\"min\":1,\"avg\":1,\"max\":1}"},  // fração no lugar de %
            {"ping", "{\"host\":\"a\",\"method\":\"icmp\",\"sent\":2,\"received\":0,\"lossPct\":100,\"min\":0}"},
            {"lanScan", "{\"devices\":[{\"ip\":\"192.168.0.1\"},{\"ip\":\"192.168.0.1\"}]}"},
            {"lanScan", "{\"devices\":[{\"ip\":\"192.168.0.1\",\"self\":false}]}"},
            {"lanScan", "{\"devices\":[{\"ip\":\"192.168.0.1\",\"mac\":\"A4:91:B1:00:11:22\"}]}"},
            {"speedTest", "{\"ok\":false,\"bytesDown\":0,\"bytesUp\":0}"},
            {"speedTest", "{\"ok\":true,\"bytesDown\":0,\"bytesUp\":0}"},
            {"speedTest", "{\"ok\":false,\"error\":\"timeout\",\"bytesDown\":0,\"bytesUp\":0}"},
            {"share", "{\"ok\":\"true\"}"},
            {"watchRssi", "{\"ok\":false}"},
            {"watchRssi", "{}"},
        };
        for (String[] b : broken) {
            assertFalse("o esquema devia recusar " + b[0] + " " + b[1], ContractSchema.checkResult(b[0], b[1]).isEmpty());
        }
        String ap = "{\"bssid\":\"aa:bb:cc:dd:ee:ff\",\"ssid\":\"x\",\"level\":-50,\"frequency\":2437,\"channelWidth\":0,\"centerFreq0\":0,"
                + "\"centerFreq1\":0,\"capabilities\":\"[ESS]\",\"ageMs\":10}";
        assertTrue(ContractSchema.checkEvent("scan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[" + ap + "]}").isEmpty());
        String[][] brokenEvents = {
            {"scan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[" + ap + "," + ap + "]}"},              // BSSID repetido
            {"scan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[" + ap.replace("aa:bb", "AA:BB") + "]}"},
            {"scan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[" + ap.replace("\"ageMs\":10", "\"ageMs\":-1") + "]}"},
            {"scan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[" + ap.replace("\"ageMs\":10", "\"ageMs\":10,\"ies\":[]") + "]}"},
            {"scan", "{\"ts\":1700000000000,\"fresh\":true,\"source\":\"request\",\"aps\":[" + ap.replace("\"ageMs\":10", "\"ageMs\":10,\"venueName\":\"\"") + "]}"},
            {"rssi", "{\"ts\":1700000000000,\"rssi\":-50,\"frequency\":5180}"},                                    // bssid ausente
            {"rssi", "{\"ts\":1700000000000,\"rssi\":-50,\"bssid\":null,\"frequency\":5180}"},
            {"ping", "{\"host\":\"a\",\"seq\":1,\"ok\":true}"},
            {"ping", "{\"host\":\"a\",\"seq\":1,\"ok\":false,\"ms\":3}"},
            {"ping", "{\"host\":\"a\",\"seq\":0,\"ok\":false}"},
            {"lanProgress", "{\"done\":5,\"total\":4}"},
            {"speed", "{\"phase\":\"latency\",\"progress\":1.2,\"bytes\":0}"},
            {"speed", "{\"phase\":\"download\",\"progress\":0.5,\"bytes\":10}"},
            {"sim", "{}"},
            {"Scan", "{}"},
        };
        for (String[] b : brokenEvents) {
            assertFalse("o esquema devia recusar o evento " + b[0] + " " + b[1], ContractSchema.checkEvent(b[0], b[1]).isEmpty());
        }
        assertFalse(ContractSchema.checkError("{\"error\":\"\"}").isEmpty());
        assertFalse(ContractSchema.checkError("{\"error\":\"x\",\"ok\":false}").isEmpty());
        assertFalse(ContractSchema.checkError("{\"erro\":\"x\"}").isEmpty());
        assertTrue(ContractSchema.checkError("{\"error\":\"x\"}").isEmpty());
        try {
            ContractSchema.assertResult("status", "{}");
            fail("assertResult tem de lançar");
        } catch (AssertionError expected) {
            assertTrue(expected.getMessage().contains("canScan"));
        }
    }
}
