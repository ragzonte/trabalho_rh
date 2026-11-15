package com.wifiraiox.app;

import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.IpPrefix;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.net.RouteInfo;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.shadows.ShadowConnectivityManager;
import org.robolectric.shadows.ShadowNetwork;
import org.robolectric.shadows.ShadowNetworkCapabilities;
import org.robolectric.shadows.ShadowNetworkInfo;
import org.robolectric.shadows.ShadowWifiInfo;
import org.robolectric.shadows.ShadowWifiManager;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Apoio dos testes: página falsa que grava o que o lado nativo manda, e fábricas de objetos do Android. */
final class Fixtures {

    private Fixtures() {}

    static final String FINE = Manifest.permission.ACCESS_FINE_LOCATION;
    static final String COARSE = Manifest.permission.ACCESS_COARSE_LOCATION;

    // ---------------------------------------------------------------- página falsa

    /** No lugar do WebView: guarda cada script e sabe separar eventos de respostas. */
    static final class Page implements JsSink {
        private static final Pattern EMIT = Pattern.compile(
                "^window\\.__wrx&&window\\.__wrx\\.emit&&window\\.__wrx\\.emit\\(\"([A-Za-z]+)\",(.*)\\)$", Pattern.DOTALL);
        private static final Pattern RESOLVE = Pattern.compile(
                "^window\\.__wrx&&window\\.__wrx\\.resolve&&window\\.__wrx\\.resolve\\((-?\\d+),(.*)\\)$", Pattern.DOTALL);

        private final List<String> scripts = new ArrayList<>();

        @Override
        public synchronized void eval(String script) {
            scripts.add(script);
            notifyAll();
        }

        synchronized List<String> scripts() {
            return new ArrayList<>(scripts);
        }

        synchronized void clear() {
            scripts.clear();
        }

        /** Dados de todos os eventos com esse nome, na ordem. */
        synchronized List<JSONObject> events(String name) throws Exception {
            List<JSONObject> out = new ArrayList<>();
            for (String s : scripts) {
                Matcher m = EMIT.matcher(s);
                if (m.matches() && m.group(1).equals(name)) out.add(new JSONObject(m.group(2)));
            }
            return out;
        }

        synchronized JSONObject lastEvent(String name) throws Exception {
            List<JSONObject> all = events(name);
            return all.isEmpty() ? null : all.get(all.size() - 1);
        }

        /** Resposta do callAsync com esse id, ou null se ainda não veio. */
        synchronized JSONObject resolved(int id) throws Exception {
            JSONObject found = null;
            int count = 0;
            for (String s : scripts) {
                Matcher m = RESOLVE.matcher(s);
                if (m.matches() && Integer.parseInt(m.group(1)) == id) {
                    found = new JSONObject(m.group(2));
                    count++;
                }
            }
            if (count > 1) throw new AssertionError("id " + id + " respondido " + count + " vezes");
            return found;
        }

        /** Espera a resposta chegar de outra thread. */
        JSONObject awaitResolved(int id, long timeoutMs) throws Exception {
            long deadline = System.currentTimeMillis() + timeoutMs;
            synchronized (this) {
                while (true) {
                    JSONObject r = resolved(id);
                    if (r != null) return r;
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) throw new AssertionError("sem resposta para o id " + id + " em " + timeoutMs + " ms");
                    wait(left);
                }
            }
        }
    }

    // ---------------------------------------------------------------- montagem

    static Application app() {
        return ApplicationProvider.getApplicationContext();
    }

    static Activity activity() {
        return Robolectric.buildActivity(Activity.class).setup().get();
    }

    /** Ponte com a varredura na própria thread do teste e a página do app como origem. */
    static Bridge bridge(Activity activity, Page page) {
        return bridge(activity, page, null, null);
    }

    static Bridge bridge(Activity activity, Page page, Pinger pinger, LanScanner lan) {
        Bridge bridge = new Bridge(activity, page, Runnable::run, pinger, lan);
        bridge.setPageUrl(WebClient.START_URL);
        return bridge;
    }

    /**
     * O FileProvider guarda numa variável estática a pasta de cache do primeiro uso. Num processo de
     * verdade ela nunca muda; aqui cada teste ganha uma pasta nova, então a memória precisa ser limpa.
     */
    static void forgetFileProviderPaths() {
        java.util.Map<?, ?> cache = ReflectionHelpers.getStaticField(androidx.core.content.FileProvider.class, "sCache");
        synchronized (cache) {
            cache.clear();
        }
    }

    static void idle() {
        shadowOf(Looper.getMainLooper()).idle();
    }

    static void grantLocation() {
        shadowOf(app()).grantPermissions(FINE, COARSE);
    }

    static void denyLocation() {
        shadowOf(app()).denyPermissions(FINE, COARSE);
    }

    static ShadowWifiManager wifi() {
        return shadowOf((WifiManager) app().getSystemService(Context.WIFI_SERVICE));
    }

    static WifiManager wifiManager() {
        return (WifiManager) app().getSystemService(Context.WIFI_SERVICE);
    }

    static void setLocationEnabled(boolean on) {
        LocationManager lm = (LocationManager) app().getSystemService(Context.LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 28) {
            shadowOf(lm).setLocationEnabled(on);
        }
        shadowOf(lm).setProviderEnabled(LocationManager.GPS_PROVIDER, on);
        shadowOf(lm).setProviderEnabled(LocationManager.NETWORK_PROVIDER, on);
    }

    // ---------------------------------------------------------------- Wi-Fi

    static ScanResult scanResult(String ssid, String bssid, String caps, int level, int frequency) {
        ScanResult r = new ScanResult();
        r.SSID = ssid;
        r.BSSID = bssid;
        r.capabilities = caps;
        r.level = level;
        r.frequency = frequency;
        return r;
    }

    /** Elemento de informação cru (construtor e campos são ocultos no SDK). */
    static ScanResult.InformationElement element(int id, int ext, byte[] body) {
        ScanResult.InformationElement ie = ReflectionHelpers.callConstructor(ScanResult.InformationElement.class);
        ReflectionHelpers.setField(ie, "id", id);
        if (Build.VERSION.SDK_INT >= 30) ReflectionHelpers.setField(ie, "idExt", ext);
        ReflectionHelpers.setField(ie, "bytes", body);
        return ie;
    }

    /** WifiInfo de verdade: o nome entra cru e o próprio Android o devolve entre aspas em getSSID(). */
    static WifiInfo wifiInfo(String ssid, String bssid, int rssi, int linkSpeed, int frequency) {
        WifiInfo info = ShadowWifiInfo.newInstance();
        ShadowWifiInfo shadow = shadowOf(info);
        if (ssid != null) shadow.setSSID(ssid);
        shadow.setBSSID(bssid);
        shadow.setRssi(rssi);
        shadow.setLinkSpeed(linkSpeed);
        shadow.setFrequency(frequency);
        return info;
    }

    // ---------------------------------------------------------------- rede

    static ConnectivityManager connectivity() {
        return (ConnectivityManager) app().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    static ShadowConnectivityManager shadowConnectivity() {
        return shadowOf(connectivity());
    }

    static NetworkCapabilities capabilities(int transport, int... capabilities) {
        NetworkCapabilities caps = ShadowNetworkCapabilities.newInstance();
        shadowOf(caps).addTransportType(transport);
        for (int c : capabilities) shadowOf(caps).addCapability(c);
        return caps;
    }

    /** LinkProperties montado por reflexão: os construtores só viraram públicos em versões recentes. */
    static LinkProperties linkProperties(String iface, String[] addressesWithPrefix, String gateway, String... dns) throws Exception {
        LinkProperties lp = ReflectionHelpers.callConstructor(LinkProperties.class);
        ReflectionHelpers.callInstanceMethod(lp, "setInterfaceName", ClassParameter.from(String.class, iface));
        for (String a : addressesWithPrefix) {
            String[] parts = a.split("/");
            LinkAddress address = ReflectionHelpers.callConstructor(LinkAddress.class,
                    ClassParameter.from(InetAddress.class, InetAddress.getByName(parts[0])),
                    ClassParameter.from(int.class, Integer.parseInt(parts[1])));
            ReflectionHelpers.callInstanceMethod(lp, "addLinkAddress", ClassParameter.from(LinkAddress.class, address));
        }
        if (gateway != null) {
            // rota padrão (0.0.0.0/0 ou ::/0) pelo gateway
            boolean v6 = gateway.indexOf(':') >= 0;
            IpPrefix all = ReflectionHelpers.callConstructor(IpPrefix.class,
                    ClassParameter.from(InetAddress.class, InetAddress.getByName(v6 ? "::" : "0.0.0.0")),
                    ClassParameter.from(int.class, 0));
            RouteInfo route = ReflectionHelpers.callConstructor(RouteInfo.class,
                    ClassParameter.from(IpPrefix.class, all),
                    ClassParameter.from(InetAddress.class, InetAddress.getByName(gateway)),
                    ClassParameter.from(String.class, iface));
            ReflectionHelpers.callInstanceMethod(lp, "addRoute", ClassParameter.from(RouteInfo.class, route));
        }
        for (String d : dns) {
            ReflectionHelpers.callInstanceMethod(lp, "addDnsServer",
                    ClassParameter.from(InetAddress.class, InetAddress.getByName(d)));
        }
        return lp;
    }

    /** Deixa o aparelho sem rede nenhuma (o Robolectric começa com celular + Wi-Fi). */
    static void noNetworks() {
        shadowConnectivity().clearAllNetworks();
    }

    /** Só dados móveis. */
    static Network cellularOnly() {
        noNetworks();
        Network cell = ShadowNetwork.newInstance(7);
        shadowConnectivity().addNetwork(cell, ShadowNetworkInfo.newInstance(
                NetworkInfo.DetailedState.CONNECTED, ConnectivityManager.TYPE_MOBILE, 0, true, NetworkInfo.State.CONNECTED));
        shadowConnectivity().setNetworkCapabilities(cell, capabilities(NetworkCapabilities.TRANSPORT_CELLULAR,
                NetworkCapabilities.NET_CAPABILITY_INTERNET));
        return cell;
    }

    /** Uma rede Wi-Fi conectada, com endereços. */
    static Network wifiNetwork(LinkProperties lp, int... capabilities) {
        noNetworks();
        Network net = ShadowNetwork.newInstance(42);
        shadowConnectivity().addNetwork(net, ShadowNetworkInfo.newInstance(
                NetworkInfo.DetailedState.CONNECTED, ConnectivityManager.TYPE_WIFI, 0, true, NetworkInfo.State.CONNECTED));
        shadowConnectivity().setNetworkCapabilities(net, capabilities(NetworkCapabilities.TRANSPORT_WIFI, capabilities));
        if (lp != null) shadowConnectivity().setLinkProperties(net, lp);
        return net;
    }

    // ---------------------------------------------------------------- JSON

    static Set<String> keys(JSONObject o) {
        Set<String> out = new HashSet<>();
        for (Iterator<String> it = o.keys(); it.hasNext();) out.add(it.next());
        return out;
    }

    static List<InetAddress> addresses(JSONArray a) throws Exception {
        List<InetAddress> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(InetAddress.getByName(a.getString(i)));
        return out;
    }

    static List<InetAddress> addresses(String... texts) throws Exception {
        List<InetAddress> out = new ArrayList<>();
        for (String t : texts) out.add(InetAddress.getByName(t));
        return out;
    }

    static List<String> strings(JSONArray a) throws Exception {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) out.add(a.getString(i));
        return out;
    }
}
