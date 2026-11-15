package com.wifiraiox.app;

import android.net.DhcpInfo;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.NetworkCapabilities;
import android.net.RouteInfo;
import android.net.wifi.WifiInfo;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;

/**
 * Monta a Connection e a RssiSample do contrato a partir dos objetos do Android.
 * Tudo o que a versão do Android (ou a falta de permissão) não informa fica de fora do JSON.
 */
final class ConnectionMapper {

    /** WifiInfo.getRssi() quando não há medida. */
    private static final int INVALID_RSSI = -127;

    private ConnectionMapper() {}

    static JSONObject disconnected() {
        return Json.put(new JSONObject(), "connected", false);
    }

    /**
     * @param live    WifiManager.getConnectionInfo(): sinal e velocidade atuais (nome pode vir apagado)
     * @param tracked WifiInfo recebido pelo callback de rede (Android 12+: é o que traz nome e BSSID)
     */
    static JSONObject connected(WifiInfo live, WifiInfo tracked, LinkProperties link,
                                NetworkCapabilities caps, DhcpInfo dhcp) {
        JSONObject o = new JSONObject();
        Json.put(o, "connected", true);

        WifiInfo identity = bssid(live) != null || ssid(live) != null ? live : tracked;
        if (identity == null) identity = live;
        WifiInfo signal = hasSignal(live) ? live : (hasSignal(tracked) ? tracked : live);

        if (identity != null) {
            Json.put(o, "ssid", ssid(identity));
            Json.put(o, "bssid", bssid(identity));
            try {
                Json.put(o, "hidden", identity.getHiddenSSID());
            } catch (RuntimeException ignored) {
                // campo opcional
            }
        }
        if (signal != null) {
            try {
                int rssi = signal.getRssi();
                if (rssi > INVALID_RSSI && rssi < 0) Json.put(o, "rssi", rssi);
                int frequency = signal.getFrequency();
                if (frequency > 0) Json.put(o, "frequency", frequency);
                int speed = signal.getLinkSpeed();
                if (speed > 0) Json.put(o, "linkSpeed", speed); // -1 = desconhecida
                if (Build.VERSION.SDK_INT >= 29) Api29.linkSpeeds(signal, o);
                if (Build.VERSION.SDK_INT >= 30) Api30.connectionExtras(signal, o);
                if (Build.VERSION.SDK_INT >= 31) Json.put(o, "securityType", Api31.securityType(signal));
            } catch (RuntimeException ignored) {
                // o que deu para ler fica
            }
        }

        String ip = null;
        String gateway = null;
        if (link != null) {
            JSONArray ipv6 = new JSONArray();
            for (LinkAddress address : link.getLinkAddresses()) {
                InetAddress a = address.getAddress();
                if (a instanceof Inet4Address) {
                    if (ip == null) {
                        ip = a.getHostAddress();
                        Json.put(o, "ip", ip);
                        Json.put(o, "prefix", address.getPrefixLength());
                    }
                } else if (a instanceof Inet6Address) {
                    ipv6.put(noScope(a.getHostAddress()));
                }
            }
            if (ipv6.length() > 0) Json.put(o, "ipv6", ipv6);

            // Só o roteador IPv4, par do `ip`: é o endereço que a interface manda abrir no navegador
            // e usa como destino do ping. O de IPv6 é um endereço de enlace (fe80::...) que, sem o
            // nome da interface, não serve para nenhuma das duas coisas.
            for (RouteInfo route : link.getRoutes()) {
                InetAddress g = route.getGateway();
                if (route.isDefaultRoute() && g instanceof Inet4Address && !g.isAnyLocalAddress()) {
                    gateway = g.getHostAddress();
                    break;
                }
            }
            if (gateway == null && dhcp != null && dhcp.gateway != 0) gateway = ipv4(dhcp.gateway);

            JSONArray dns = new JSONArray();
            for (InetAddress server : link.getDnsServers()) {
                if (server != null) dns.put(noScope(server.getHostAddress()));
            }
            if (dns.length() > 0) Json.put(o, "dns", dns);
            Json.put(o, "iface", link.getInterfaceName());
            if (Build.VERSION.SDK_INT >= 29) {
                int mtu = Api29.mtu(link);
                if (mtu > 0) Json.put(o, "mtu", mtu); // 0 = padrão da interface, não informado
            }
        }
        if (ip == null) {
            // Sem LinkProperties (raro): o que o DHCP do Wi-Fi anotou serve de segunda fonte.
            int legacy = dhcp != null && dhcp.ipAddress != 0 ? dhcp.ipAddress : legacyIp(live);
            if (legacy != 0) {
                Json.put(o, "ip", ipv4(legacy));
                if (dhcp != null) {
                    int prefix = Integer.bitCount(dhcp.netmask);
                    if (prefix > 0 && isMask(dhcp.netmask)) Json.put(o, "prefix", prefix);
                    if (gateway == null && dhcp.gateway != 0) gateway = ipv4(dhcp.gateway);
                    JSONArray dns = new JSONArray();
                    if (dhcp.dns1 != 0) dns.put(ipv4(dhcp.dns1));
                    if (dhcp.dns2 != 0) dns.put(ipv4(dhcp.dns2));
                    if (dns.length() > 0) Json.put(o, "dns", dns);
                }
            }
        }
        Json.put(o, "gateway", gateway);
        if (dhcp != null && dhcp.leaseDuration > 0) Json.put(o, "leaseSec", dhcp.leaseDuration);

        if (caps != null) {
            Json.put(o, "validated", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
            Json.put(o, "metered", !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
        }
        return o;
    }

    /** Amostra de sinal para o evento 'rssi'; null quando não há medida (Wi-Fi desconectado). */
    static JSONObject rssiSample(WifiInfo live, WifiInfo tracked, long nowMs) {
        if (!hasSignal(live)) return null;
        JSONObject o = new JSONObject();
        Json.put(o, "ts", nowMs);
        Json.put(o, "rssi", live.getRssi());
        String bssid = bssid(live);
        if (bssid == null) bssid = bssid(tracked);
        Json.put(o, "bssid", bssid == null ? "" : bssid); // "" = o Android escondeu (falta permissão)
        Json.put(o, "frequency", Math.max(0, live.getFrequency()));
        int speed = live.getLinkSpeed();
        if (speed > 0) Json.put(o, "linkSpeed", speed);
        if (Build.VERSION.SDK_INT >= 29) Api29.linkSpeeds(live, o);
        return o;
    }

    /**
     * Resumo do que identifica a conexão, sem o que oscila o tempo todo (sinal, velocidade):
     * o evento 'connection' só é emitido quando isto muda.
     */
    static String signature(JSONObject connection) {
        try {
            JSONObject copy = new JSONObject(connection.toString());
            copy.remove("rssi");
            copy.remove("linkSpeed");
            copy.remove("txSpeed");
            copy.remove("rxSpeed");
            return copy.toString();
        } catch (org.json.JSONException e) {
            return String.valueOf(connection);
        }
    }

    static String ssid(WifiInfo info) {
        try {
            return info == null ? null : WifiText.connectionSsid(info.getSSID());
        } catch (RuntimeException e) {
            return null;
        }
    }

    static String bssid(WifiInfo info) {
        try {
            return info == null ? null : WifiText.mac(info.getBSSID());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static boolean hasSignal(WifiInfo info) {
        try {
            if (info == null) return false;
            int rssi = info.getRssi();
            return rssi > INVALID_RSSI && rssi < 0;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** Os inteiros do DhcpInfo guardam o endereço com o primeiro octeto no byte menos significativo. */
    static String ipv4(int littleEndian) {
        return (littleEndian & 0xFF) + "." + ((littleEndian >> 8) & 0xFF) + "."
                + ((littleEndian >> 16) & 0xFF) + "." + ((littleEndian >> 24) & 0xFF);
    }

    @SuppressWarnings("deprecation") // único jeito de ter o IPv4 quando o Android não entrega LinkProperties
    private static int legacyIp(WifiInfo info) {
        try {
            return info == null ? 0 : info.getIpAddress();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    /** Máscara válida = uns contíguos a partir do primeiro octeto (que aqui está no byte baixo). */
    private static boolean isMask(int littleEndianMask) {
        int big = Integer.reverseBytes(littleEndianMask);
        int inverted = ~big;
        return (inverted & (inverted + 1)) == 0;
    }

    /** "fe80::1%wlan0" -> "fe80::1". */
    private static String noScope(String address) {
        if (address == null) return null;
        int i = address.indexOf('%');
        return i < 0 ? address : address.substring(0, i);
    }
}
