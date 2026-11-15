package com.wifiraiox.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.DhcpInfo;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;

import androidx.annotation.NonNull;

import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Acompanha a rede Wi-Fi em uso. Um NetworkCallback filtrado por TRANSPORT_WIFI diz quando ela
 * conecta, cai ou muda de endereço; a leitura junta isso com o WifiInfo (sinal, velocidade).
 *
 * Os métodos do callback rodam numa thread do sistema e só guardam o que receberam: consultar o
 * ConnectivityManager de dentro deles dá resultados fora de ordem.
 */
final class ConnectionTracker {

    interface Listener {
        void onConnectionChanged(JSONObject connection);
    }

    /** Eventos de rede, comuns ao callback simples e ao do Android 12+ (ver Api31). */
    interface NetEvents {
        void available(Network network);

        void lost(Network network);

        void capabilities(Network network, NetworkCapabilities caps);

        void link(Network network, LinkProperties link);
    }

    /** O que a varredura da rede local precisa saber. Endereços como inteiros big-endian (a.b.c.d). */
    static final class LanTarget {
        final int ip;
        final int prefix;
        final int gateway; // 0 = desconhecido
        final Network network;

        LanTarget(int ip, int prefix, int gateway, Network network) {
            this.ip = ip;
            this.prefix = prefix;
            this.gateway = gateway;
            this.network = network;
        }
    }

    private static final class Entry {
        NetworkCapabilities caps;
        LinkProperties link;
        WifiInfo info;
    }

    /** Vários avisos chegam em rajada quando a rede muda; juntamos tudo num evento só. */
    private static final long SETTLE_MS = 250;

    private final Context context;
    private final Handler main;
    private final Listener listener;
    private final Object lock = new Object();
    private final LinkedHashMap<Network, Entry> networks = new LinkedHashMap<>();
    private ConnectivityManager.NetworkCallback callback;
    private String lastSignature;
    private final Runnable settle = this::emitIfChanged;

    private final NetEvents events = new NetEvents() {
        @Override
        public void available(Network network) {
            synchronized (lock) {
                if (entry(network) == null) return;
            }
            changed();
        }

        @Override
        public void lost(Network network) {
            synchronized (lock) {
                networks.remove(network);
            }
            changed();
        }

        @Override
        public void capabilities(Network network, NetworkCapabilities caps) {
            synchronized (lock) {
                Entry e = entry(network);
                if (e == null) return;
                e.caps = caps;
                if (Build.VERSION.SDK_INT >= 29 && caps != null) {
                    WifiInfo info = Api29.wifiInfo(caps);
                    if (info != null) e.info = info;
                }
            }
            changed();
        }

        @Override
        public void link(Network network, LinkProperties link) {
            synchronized (lock) {
                Entry e = entry(network);
                if (e == null) return;
                e.link = link;
            }
            changed();
        }
    };

    ConnectionTracker(Context context, Handler main, Listener listener) {
        this.context = context.getApplicationContext();
        this.main = main;
        this.listener = listener;
    }

    /** Registra o callback (onStart). Sempre em par com stop(): o Android limita a 100 callbacks por app. */
    void start() {
        synchronized (lock) {
            if (callback != null) return;
            ConnectivityManager cm = Sys.connectivity(context);
            if (cm == null) return;
            ConnectivityManager.NetworkCallback cb = Build.VERSION.SDK_INT >= 31
                    ? Api31.locationAwareCallback(events)
                    : new PlainCallback(events);
            try {
                NetworkRequest request = new NetworkRequest.Builder()
                        .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                        .build();
                callback = cb; // antes de registrar: o primeiro aviso pode chegar na hora
                cm.registerNetworkCallback(request, cb);
            } catch (RuntimeException e) {
                callback = null; // sem callback a leitura continua funcionando, só não há eventos
            }
        }
        changed(); // se o Wi-Fi caiu enquanto o app estava fora da tela, ninguém avisa: confere
    }

    /** Remove o callback (onStop). */
    void stop() {
        ConnectivityManager.NetworkCallback cb;
        synchronized (lock) {
            cb = callback;
            callback = null;
            networks.clear();
        }
        main.removeCallbacks(settle);
        if (cb == null) return;
        try {
            ConnectivityManager cm = Sys.connectivity(context);
            if (cm != null) cm.unregisterNetworkCallback(cb);
        } catch (RuntimeException ignored) {
            // já não estava registrado
        }
    }

    boolean tracking() {
        synchronized (lock) {
            return callback != null;
        }
    }

    /** Connection do contrato. */
    JSONObject read() {
        Snapshot s = snapshot();
        if (s.network == null) return ConnectionMapper.disconnected();
        return ConnectionMapper.connected(connectionInfo(), s.info, s.link, s.caps, dhcp());
    }

    /** RssiSample do contrato, ou null sem sinal para medir. */
    JSONObject rssiSample() {
        WifiInfo tracked;
        synchronized (lock) {
            Entry e = current();
            tracked = e == null ? null : e.info;
        }
        return ConnectionMapper.rssiSample(connectionInfo(), tracked, System.currentTimeMillis());
    }

    /** Endereço e máscara do celular no Wi-Fi, para a varredura da rede local. null fora do Wi-Fi ou sem IPv4. */
    LanTarget lanTarget() {
        Snapshot s = snapshot();
        if (s.network == null || s.link == null) return null;
        int ip = 0;
        int prefix = 0;
        for (LinkAddress address : s.link.getLinkAddresses()) {
            if (address.getAddress() instanceof Inet4Address) {
                ip = LanRange.toInt(address.getAddress().getAddress());
                prefix = address.getPrefixLength();
                break;
            }
        }
        if (ip == 0) return null;
        int gateway = 0;
        for (RouteInfo route : s.link.getRoutes()) {
            InetAddress g = route.getGateway();
            if (route.isDefaultRoute() && g instanceof Inet4Address && !g.isAnyLocalAddress()) {
                gateway = LanRange.toInt(g.getAddress());
                break;
            }
        }
        return new LanTarget(ip, prefix, gateway, s.network);
    }

    private static final class Snapshot {
        Network network;
        NetworkCapabilities caps;
        LinkProperties link;
        WifiInfo info;
    }

    private Snapshot snapshot() {
        Snapshot s = new Snapshot();
        synchronized (lock) {
            for (Map.Entry<Network, Entry> e : networks.entrySet()) { // a mais recente fica por último
                s.network = e.getKey();
                s.caps = e.getValue().caps;
                s.link = e.getValue().link;
                s.info = e.getValue().info;
            }
        }
        ConnectivityManager cm = Sys.connectivity(context);
        if (cm == null) return s;
        try {
            if (s.network == null) s.network = findWifiNetwork(cm); // callback ainda não avisou (ou não registrou)
            if (s.network != null) {
                if (s.caps == null) s.caps = cm.getNetworkCapabilities(s.network);
                if (s.link == null) s.link = cm.getLinkProperties(s.network);
            }
        } catch (RuntimeException ignored) {
            // segue com o que tiver
        }
        return s;
    }

    /** Com o lock. null depois de stop(): avisos atrasados não ressuscitam a rede. */
    private Entry entry(Network network) {
        if (callback == null || network == null) return null;
        Entry e = networks.get(network);
        if (e == null) {
            e = new Entry();
            networks.put(network, e);
        }
        return e;
    }

    private Entry current() {
        Entry last = null;
        for (Entry e : networks.values()) last = e;
        return last;
    }

    /** getAllNetworks() está obsoleto desde o Android 12 mas segue funcionando; é só o plano B. */
    @SuppressWarnings("deprecation")
    private static Network findWifiNetwork(ConnectivityManager cm) {
        Network[] all = cm.getAllNetworks();
        if (all == null) return null;
        for (Network n : all) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                return n;
            }
        }
        return null;
    }

    /** Obsoleto desde o Android 12, mas ainda é a leitura mais fresca de sinal e velocidade. */
    @SuppressWarnings("deprecation")
    private WifiInfo connectionInfo() {
        try {
            WifiManager wifi = Sys.wifi(context);
            return wifi == null ? null : wifi.getConnectionInfo();
        } catch (RuntimeException e) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private DhcpInfo dhcp() {
        try {
            WifiManager wifi = Sys.wifi(context);
            return wifi == null ? null : wifi.getDhcpInfo();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private void changed() {
        main.removeCallbacks(settle);
        main.postDelayed(settle, SETTLE_MS);
    }

    private void emitIfChanged() {
        synchronized (lock) {
            if (callback == null) return; // parado
        }
        JSONObject connection = read();
        String signature = ConnectionMapper.signature(connection);
        synchronized (lock) {
            if (signature.equals(lastSignature)) return;
            lastSignature = signature;
        }
        listener.onConnectionChanged(connection);
    }

    /** Callback para Android até o 11, onde não existe a flag de localização. */
    private static final class PlainCallback extends ConnectivityManager.NetworkCallback {
        private final NetEvents events;

        PlainCallback(NetEvents events) {
            this.events = events;
        }

        @Override
        public void onAvailable(@NonNull Network network) {
            events.available(network);
        }

        @Override
        public void onLost(@NonNull Network network) {
            events.lost(network);
        }

        @Override
        public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities caps) {
            events.capabilities(network, caps);
        }

        @Override
        public void onLinkPropertiesChanged(@NonNull Network network, @NonNull LinkProperties link) {
            events.link(network, link);
        }
    }
}
