package com.wifiraiox.app;

import android.content.Intent;
import android.net.LinkProperties;
import android.net.NetworkCapabilities;
import android.net.TransportInfo;
import android.net.wifi.WifiInfo;
import android.provider.Settings;

import androidx.annotation.RequiresApi;

import org.json.JSONObject;

/** Só Android 10 (API 29) em diante. */
@RequiresApi(29)
final class Api29 {

    private Api29() {}

    /** Painel de Wi-Fi/Internet que abre por cima do app, sem sair dele. */
    static Intent wifiPanel() {
        return new Intent(Settings.Panel.ACTION_WIFI);
    }

    static int mtu(LinkProperties link) {
        return link.getMtu();
    }

    /** Velocidades negociadas de envio e recepção. -1 (e o 0 de um WifiInfo recém-criado) = desconhecida. */
    static void linkSpeeds(WifiInfo info, JSONObject o) {
        int tx = info.getTxLinkSpeedMbps();
        int rx = info.getRxLinkSpeedMbps();
        if (tx > 0) Json.put(o, "txSpeed", tx);
        if (rx > 0) Json.put(o, "rxSpeed", rx);
    }

    /** WifiInfo que acompanha as capacidades da rede (com nome e BSSID quando o callback pediu a localização). */
    static WifiInfo wifiInfo(NetworkCapabilities caps) {
        TransportInfo info = caps.getTransportInfo();
        return info instanceof WifiInfo ? (WifiInfo) info : null;
    }
}
