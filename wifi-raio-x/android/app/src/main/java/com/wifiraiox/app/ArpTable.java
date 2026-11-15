package com.wifiraiox.app;

import android.os.Build;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Tabela de vizinhos do kernel (IP -> MAC). Até o Android 9 qualquer app podia ler /proc/net/arp;
 * do Android 10 em diante o acesso é bloqueado, então nem tentamos.
 */
final class ArpTable {

    private static final String PATH = "/proc/net/arp";

    private ArpTable() {}

    static boolean readable() {
        return Build.VERSION.SDK_INT < 29;
    }

    /** IP -> MAC (minúsculo) das entradas completas; vazio quando não dá para ler. */
    static Map<String, String> read() {
        if (!readable()) return new HashMap<>();
        try (Reader reader = new InputStreamReader(new FileInputStream(PATH), StandardCharsets.US_ASCII)) {
            return parse(reader);
        } catch (Exception e) {
            return new HashMap<>();
        }
    }

    /**
     * Formato do kernel:
     *   IP address       HW type     Flags       HW address            Mask     Device
     *   192.168.0.1      0x1         0x2         a4:91:b1:00:11:22     *        wlan0
     * Flags 0x0 = entrada incompleta (ninguém respondeu ao ARP).
     */
    static Map<String, String> parse(Reader source) throws java.io.IOException {
        Map<String, String> out = new HashMap<>();
        BufferedReader reader = new BufferedReader(source);
        String line;
        while ((line = reader.readLine()) != null) {
            String[] cols = line.trim().split("\\s+");
            if (cols.length < 4 || LanRange.parse(cols[0]) == 0) continue;
            int flags;
            try {
                flags = Integer.decode(cols[2]);
            } catch (NumberFormatException e) {
                continue;
            }
            if ((flags & 0x2) == 0) continue;
            String mac = WifiText.mac(cols[3]);
            if (mac != null && mac.length() == 17) out.put(cols[0], mac.toLowerCase(Locale.ROOT));
        }
        return out;
    }
}
