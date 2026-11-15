package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.os.Build;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Connection: o que cada versão do Android informa sobre a rede em uso, e os eventos de mudança. */
public class ConnectionTest extends AllSdks {

    private Activity activity;
    private Fixtures.Page page;
    private Bridge bridge;

    @Before
    public void setUp() {
        activity = Fixtures.activity();
        page = new Fixtures.Page();
        bridge = Fixtures.bridge(activity, page);
        Fixtures.grantLocation();
    }

    private JSONObject connection() throws Exception {
        return new JSONObject(bridge.call("connection", "{}"));
    }

    private static LinkProperties homeLink() throws Exception {
        return Fixtures.linkProperties("wlan0",
                new String[] {"192.168.15.37/24", "fe80::1c2d:3eff:fe4f:5a6b/64", "2804:14c:1:2::10/64"},
                "192.168.15.1", "192.168.15.1", "2001:4860:4860::8888");
    }

    private static WifiInfo homeWifi() {
        WifiInfo info = Fixtures.wifiInfo("Casa 5G", "A4:91:B1:00:11:22", -52, 433, 5180);
        Fixtures.wifi().setConnectionInfo(info);
        return info;
    }

    /** As chaves que a versão do Android em teste pode entregar. */
    private static Set<String> allowedKeys() {
        Set<String> keys = new HashSet<>(Arrays.asList("connected", "ssid", "bssid", "rssi", "frequency", "linkSpeed",
                "hidden", "ip", "prefix", "gateway", "dns", "ipv6", "iface", "leaseSec", "validated", "metered"));
        if (Build.VERSION.SDK_INT >= 29) keys.addAll(Arrays.asList("txSpeed", "rxSpeed", "mtu"));
        if (Build.VERSION.SDK_INT >= 30) keys.addAll(Arrays.asList("maxTxSpeed", "maxRxSpeed", "wifiStandard"));
        if (Build.VERSION.SDK_INT >= 31) keys.add("securityType");
        return keys;
    }

    @Test
    public void noNetworkAtAllIsDisconnected() throws Exception {
        Fixtures.noNetworks();
        JSONObject c = connection();
        assertEquals(false, c.get("connected"));
        assertEquals(1, c.length());
    }

    @Test
    public void mobileDataOnlyIsDisconnected() throws Exception {
        Fixtures.cellularOnly();
        homeWifi(); // WifiInfo velho na memória não pode enganar
        JSONObject c = connection();
        assertEquals(false, c.get("connected"));
        assertEquals(1, c.length());
    }

    @Test
    public void vpnOverWifiIsNotTakenForTheWifiNetwork() throws Exception {
        Fixtures.noNetworks();
        Network vpn = org.robolectric.shadows.ShadowNetwork.newInstance(77);
        Fixtures.shadowConnectivity().addNetwork(vpn, null);
        NetworkCapabilities caps = Fixtures.capabilities(NetworkCapabilities.TRANSPORT_WIFI);
        shadowOf(caps).addTransportType(NetworkCapabilities.TRANSPORT_VPN);
        Fixtures.shadowConnectivity().setNetworkCapabilities(vpn, caps);
        assertEquals(false, connection().get("connected"));
    }

    @Test
    public void connectedWifiFillsTheContractFields() throws Exception {
        homeWifi();
        Fixtures.wifiNetwork(homeLink(), NetworkCapabilities.NET_CAPABILITY_INTERNET,
                NetworkCapabilities.NET_CAPABILITY_VALIDATED, NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        DhcpInfo dhcp = new DhcpInfo();
        dhcp.leaseDuration = 86400;
        dhcp.gateway = 0x010FA8C0; // 192.168.15.1, primeiro octeto no byte baixo
        Fixtures.wifi().setDhcpInfo(dhcp);

        assertEquals("o Android entrega o nome entre aspas", "\"Casa 5G\"", Fixtures.wifiManager().getConnectionInfo().getSSID());
        JSONObject c = connection();
        assertEquals(true, c.get("connected"));
        assertEquals("Casa 5G", c.get("ssid"));
        assertEquals("a4:91:b1:00:11:22", c.get("bssid"));
        assertEquals(-52, c.get("rssi"));
        assertEquals(5180, c.get("frequency"));
        assertEquals(433, c.get("linkSpeed"));
        assertTrue(c.get("hidden") instanceof Boolean);
        assertEquals("192.168.15.37", c.get("ip"));
        assertEquals(24, c.get("prefix"));
        assertEquals("192.168.15.1", c.get("gateway"));
        // (a escrita do IPv6 é a do sistema: o Android abrevia com "::", a JVM dos testes não)
        assertEquals(Fixtures.addresses("192.168.15.1", "2001:4860:4860::8888"), Fixtures.addresses(c.getJSONArray("dns")));
        assertEquals(Fixtures.addresses("fe80::1c2d:3eff:fe4f:5a6b", "2804:14c:1:2::10"), Fixtures.addresses(c.getJSONArray("ipv6")));
        for (String a : Fixtures.strings(c.getJSONArray("ipv6"))) assertFalse("sem escopo (%wlan0)", a.contains("%"));
        assertEquals("wlan0", c.get("iface"));
        assertEquals(86400, c.get("leaseSec"));
        assertEquals(true, c.get("validated"));
        assertEquals(false, c.get("metered"));

        Set<String> extra = Fixtures.keys(c);
        extra.removeAll(allowedKeys());
        assertTrue("campos que esta versão do Android não tem: " + extra, extra.isEmpty());
    }

    @Test
    public void newerFieldsAppearOnlyWhereTheApiExists() throws Exception {
        WifiInfo info = homeWifi();
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
        LinkProperties link = homeLink();
        ReflectionHelpers.callInstanceMethod(link, "setMtu", ClassParameter.from(int.class, 1500));
        Fixtures.wifiNetwork(link);

        JSONObject c = connection();
        assertEquals(Build.VERSION.SDK_INT >= 29, c.has("txSpeed"));
        assertEquals(Build.VERSION.SDK_INT >= 29, c.has("rxSpeed"));
        assertEquals(Build.VERSION.SDK_INT >= 29, c.has("mtu"));
        assertEquals(Build.VERSION.SDK_INT >= 30, c.has("maxTxSpeed"));
        assertEquals(Build.VERSION.SDK_INT >= 30, c.has("maxRxSpeed"));
        assertEquals(Build.VERSION.SDK_INT >= 30, c.has("wifiStandard"));
        assertEquals(Build.VERSION.SDK_INT >= 31, c.has("securityType"));
        if (Build.VERSION.SDK_INT >= 29) {
            assertEquals(866, c.get("txSpeed"));
            assertEquals(780, c.get("rxSpeed"));
            assertEquals(1500, c.get("mtu"));
        }
        if (Build.VERSION.SDK_INT >= 30) {
            assertEquals(1201, c.get("maxTxSpeed"));
            assertEquals(6, c.get("wifiStandard"));
        }
        if (Build.VERSION.SDK_INT >= 31) assertEquals(4, c.get("securityType"));
        // sem leaseDuration e sem dado de validação nada é inventado
        assertFalse(c.has("leaseSec"));
    }

    @Test
    public void sentinelsFromMissingPermissionAreAbsentNotLies() throws Exception {
        WifiInfo info = Fixtures.wifiInfo(null, "02:00:00:00:00:00", -61, 72, 2437);
        Fixtures.wifi().setConnectionInfo(info);
        Fixtures.wifiNetwork(homeLink());
        JSONObject c = connection();
        assertEquals(true, c.get("connected"));
        assertFalse("<unknown ssid> não é nome de rede", c.has("ssid"));
        assertFalse("02:00:00:00:00:00 não é BSSID", c.has("bssid"));
        assertEquals("o sinal não é escondido pelo Android", -61, c.get("rssi"));
        assertEquals(2437, c.get("frequency"));
    }

    @Test
    public void unknownValuesAreOmitted() throws Exception {
        // WifiInfo zerado: sem sinal (-127), velocidade -1, frequência -1.
        Fixtures.wifi().setConnectionInfo(org.robolectric.shadows.ShadowWifiInfo.newInstance());
        Fixtures.wifiNetwork(null);
        JSONObject c = connection();
        assertEquals(true, c.get("connected"));
        for (String k : new String[] {"ssid", "bssid", "rssi", "frequency", "linkSpeed", "txSpeed", "rxSpeed",
                "maxTxSpeed", "maxRxSpeed", "ip", "prefix", "gateway", "dns", "ipv6", "iface", "mtu", "leaseSec"}) {
            assertFalse(k, c.has(k));
        }
    }

    @Test
    public void dhcpInfoFillsInWhenLinkPropertiesAreMissing() throws Exception {
        homeWifi();
        Fixtures.wifiNetwork(null);
        DhcpInfo dhcp = new DhcpInfo();
        dhcp.ipAddress = 0x250FA8C0;  // 192.168.15.37
        dhcp.netmask = 0x00FFFFFF;    // 255.255.255.0
        dhcp.gateway = 0x010FA8C0;
        dhcp.dns1 = 0x08080808;
        dhcp.leaseDuration = 3600;
        Fixtures.wifi().setDhcpInfo(dhcp);
        JSONObject c = connection();
        assertEquals("192.168.15.37", c.get("ip"));
        assertEquals(24, c.get("prefix"));
        assertEquals("192.168.15.1", c.get("gateway"));
        assertEquals(Arrays.asList("8.8.8.8"), Fixtures.strings(c.getJSONArray("dns")));
        assertEquals(3600, c.get("leaseSec"));
    }

    @Test
    public void ssidFormsOfWifiInfo() {
        assertEquals("Casa", WifiText.connectionSsid("\"Casa\""));
        assertEquals("\"aspas\" no meio", WifiText.connectionSsid("\"\"aspas\" no meio\""));
        assertNull(WifiText.connectionSsid("<unknown ssid>"));
        assertNull(WifiText.connectionSsid(null));
        assertNull(WifiText.connectionSsid(""));
        assertNull(WifiText.connectionSsid("\"\""));
        // nome que não é UTF-8 chega em hexadecimal, com "0x" até o Android 12
        assertEquals("João", WifiText.connectionSsid("4a6fe36f"));
        assertEquals("João", WifiText.connectionSsid("0x4a6fe36f"));
        assertNull("oculta: só zeros", WifiText.connectionSsid("00000000"));
        assertEquals("semaspas", WifiText.connectionSsid("semaspas"));
        assertEquals("a4:91:b1:00:11:22", WifiText.mac("A4:91:B1:00:11:22"));
        assertNull(WifiText.mac("02:00:00:00:00:00"));
        assertNull(WifiText.mac("00:00:00:00:00:00"));
        assertNull(WifiText.mac(null));
    }

    @Test
    public void callbackIsRegisteredOnStartAndRemovedOnStop() {
        int before = Fixtures.shadowConnectivity().getNetworkCallbacks().size();
        bridge.onStart();
        bridge.onStart();
        assertEquals("um callback só, mesmo com onStart repetido", before + 1,
                Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        bridge.onStop();
        assertEquals(before, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
        bridge.onStop(); // repetido: não lança
        bridge.onStart();
        bridge.onDestroy();
        assertEquals(before, Fixtures.shadowConnectivity().getNetworkCallbacks().size());
    }

    private ConnectivityManager.NetworkCallback registeredCallback() {
        Set<ConnectivityManager.NetworkCallback> all = Fixtures.shadowConnectivity().getNetworkCallbacks();
        assertEquals(1, all.size());
        return all.iterator().next();
    }

    private void settle() {
        org.robolectric.shadows.ShadowLooper.idleMainLooper(1, java.util.concurrent.TimeUnit.SECONDS);
    }

    @Test
    public void connectDisconnectAndAddressChangesEmitConnectionEvents() throws Exception {
        Fixtures.noNetworks();
        bridge.onStart();
        settle();
        assertEquals(false, page.lastEvent("connection").get("connected"));

        // conecta
        homeWifi();
        LinkProperties link = homeLink();
        Network net = Fixtures.wifiNetwork(link, NetworkCapabilities.NET_CAPABILITY_INTERNET);
        ConnectivityManager.NetworkCallback cb = registeredCallback();
        NetworkCapabilities caps = Fixtures.connectivity().getNetworkCapabilities(net);
        page.clear();
        cb.onAvailable(net);
        cb.onCapabilitiesChanged(net, caps);
        cb.onLinkPropertiesChanged(net, link);
        settle();
        assertEquals("a rajada de avisos vira um evento só", 1, page.events("connection").size());
        JSONObject c = page.lastEvent("connection");
        assertEquals(true, c.get("connected"));
        assertEquals("Casa 5G", c.get("ssid"));
        assertEquals("192.168.15.37", c.get("ip"));

        // só o sinal mudou: não é mudança de conexão
        page.clear();
        shadowOf(Fixtures.wifiManager().getConnectionInfo()).setRssi(-70);
        cb.onCapabilitiesChanged(net, caps);
        settle();
        assertTrue(page.events("connection").isEmpty());

        // endereço novo
        LinkProperties renewed = Fixtures.linkProperties("wlan0", new String[] {"192.168.15.99/24"}, "192.168.15.1", "192.168.15.1");
        cb.onLinkPropertiesChanged(net, renewed);
        settle();
        assertEquals("192.168.15.99", page.lastEvent("connection").get("ip"));

        // cai
        page.clear();
        Fixtures.noNetworks();
        cb.onLost(net);
        settle();
        assertEquals(false, page.lastEvent("connection").get("connected"));

        // depois do onStop, avisos atrasados não geram nada
        bridge.onStop();
        page.clear();
        cb.onAvailable(net);
        settle();
        assertTrue(page.events("connection").isEmpty());
    }

    @Test
    public void android12TakesTheNameFromTheCallbackWhenTheLiveOneIsRedacted() throws Exception {
        if (Build.VERSION.SDK_INT < 31) return; // só no Android 12 o WifiInfo passou a viajar nas capacidades da rede
        // A leitura direta vem apagada...
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo(null, "02:00:00:00:00:00", -55, 300, 5200));
        // ...e o callback (com FLAG_INCLUDE_LOCATION_INFO no 12+) traz a identidade.
        WifiInfo full = Fixtures.wifiInfo("Escritorio", "0C:11:22:33:44:55", -58, 300, 5200);
        Network net = Fixtures.wifiNetwork(homeLink());
        NetworkCapabilities caps = Fixtures.capabilities(NetworkCapabilities.TRANSPORT_WIFI);
        shadowOf(caps).setTransportInfo(full);
        bridge.onStart();
        ConnectivityManager.NetworkCallback cb = registeredCallback();
        cb.onAvailable(net);
        cb.onCapabilitiesChanged(net, caps);
        JSONObject c = connection();
        assertEquals("Escritorio", c.get("ssid"));
        assertEquals("0c:11:22:33:44:55", c.get("bssid"));
        assertEquals("o sinal é o da leitura direta, mais fresca", -55, c.get("rssi"));
    }

    @Test
    public void withTwoWifiNetworksTheOneWithInternetWins() throws Exception {
        homeWifi();
        Fixtures.noNetworks();
        bridge.onStart();
        ConnectivityManager.NetworkCallback cb = registeredCallback();
        Network main = org.robolectric.shadows.ShadowNetwork.newInstance(101);
        Network iot = org.robolectric.shadows.ShadowNetwork.newInstance(102);
        cb.onAvailable(main);
        cb.onCapabilitiesChanged(main, Fixtures.capabilities(NetworkCapabilities.TRANSPORT_WIFI,
                NetworkCapabilities.NET_CAPABILITY_INTERNET, NetworkCapabilities.NET_CAPABILITY_VALIDATED));
        cb.onLinkPropertiesChanged(main, homeLink());
        // rede secundária, sem internet, chega depois
        cb.onAvailable(iot);
        cb.onCapabilitiesChanged(iot, Fixtures.capabilities(NetworkCapabilities.TRANSPORT_WIFI));
        cb.onLinkPropertiesChanged(iot, Fixtures.linkProperties("wlan1", new String[] {"10.10.10.5/24"}, null));
        JSONObject c = connection();
        assertEquals("192.168.15.37", c.get("ip"));
        assertEquals("wlan0", c.get("iface"));
        assertEquals(true, c.get("validated"));

        cb.onLost(main);
        assertEquals("10.10.10.5", connection().get("ip"));
    }

    @Test
    public void grantingLocationReRegistersTheCallbackAndRefreshesTheEvent() throws Exception {
        Fixtures.denyLocation();
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo(null, "02:00:00:00:00:00", -55, 300, 5200));
        Fixtures.wifiNetwork(homeLink());
        bridge.onStart();
        settle();
        ConnectivityManager.NetworkCallback before = registeredCallback();
        assertFalse(page.lastEvent("connection").has("ssid"));

        // permissão concedida: o Android passa a revelar a rede
        Fixtures.grantLocation();
        homeWifi();
        page.clear();
        bridge.onPermissionsResult(Permissions.REQUEST_LOCATION, new String[] {Fixtures.FINE, Fixtures.COARSE}, new int[] {0, 0});
        settle();
        ConnectivityManager.NetworkCallback after = registeredCallback();
        assertTrue("registro novo: só ele recebe o nome sem censura no Android 12+", before != after);
        assertEquals("Casa 5G", page.lastEvent("connection").get("ssid"));
        assertEquals("granted", page.lastEvent("status").get("permission"));
    }

    @Test
    public void resumeRechecksTheConnection() throws Exception {
        Fixtures.wifi().setConnectionInfo(Fixtures.wifiInfo(null, "02:00:00:00:00:00", -55, 300, 5200));
        Fixtures.wifiNetwork(homeLink());
        bridge.onStart();
        settle();
        // o usuário foi às configurações e religou a Localização: nenhum aviso de rede chega por isso
        homeWifi();
        page.clear();
        bridge.onResume();
        settle();
        assertEquals("Casa 5G", page.lastEvent("connection").get("ssid"));
    }

    @Test
    public void lanTargetComesFromTheWifiLink() throws Exception {
        ConnectionTracker tracker = new ConnectionTracker(activity, new android.os.Handler(android.os.Looper.getMainLooper()), c -> { });
        Fixtures.noNetworks();
        assertNull(tracker.lanTarget());
        Fixtures.cellularOnly();
        assertNull(tracker.lanTarget());
        Network net = Fixtures.wifiNetwork(homeLink());
        ConnectionTracker.LanTarget t = tracker.lanTarget();
        assertNotNull(t);
        assertEquals("192.168.15.37", LanRange.format(t.ip));
        assertEquals(24, t.prefix);
        assertEquals("192.168.15.1", LanRange.format(t.gateway));
        assertEquals(net, t.network);
        // Wi-Fi só com IPv6: não há o que varrer
        Fixtures.wifiNetwork(Fixtures.linkProperties("wlan0", new String[] {"2804:14c::1/64"}, null));
        assertNull(tracker.lanTarget());
    }
}
