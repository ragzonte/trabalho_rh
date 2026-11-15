package com.wifiraiox.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.net.MacAddress;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiSsid;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** ScanResult -> ScanAp em cada versão do Android. */
public class ScanMapperTest extends AllSdks {

    private static final long NOW = 1_000_000L; // ms desde o boot

    private static ScanResult typical() {
        ScanResult r = Fixtures.scanResult("Casa", "AA:BB:CC:DD:EE:0F", "[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][WPS]", -57, 5180);
        r.channelWidth = ScanResult.CHANNEL_WIDTH_80MHZ;
        r.centerFreq0 = 5210;
        r.centerFreq1 = 0;
        r.timestamp = (NOW - 1500) * 1000; // microssegundos
        return r;
    }

    @Test
    public void mapsEveryBaseFieldWithContractNamesAndTypes() throws Exception {
        JSONObject ap = ScanMapper.one(typical(), NOW);
        assertEquals("aa:bb:cc:dd:ee:0f", ap.get("bssid"));
        assertEquals("Casa", ap.get("ssid"));
        assertEquals(-57, ap.get("level"));
        assertEquals(5180, ap.get("frequency"));
        assertEquals(2, ap.get("channelWidth"));
        assertEquals(5210, ap.get("centerFreq0"));
        assertEquals(0, ap.get("centerFreq1"));
        assertEquals("[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][WPS]", ap.get("capabilities"));
        assertEquals(1500L, ap.getLong("ageMs"));
        assertEquals(false, ap.get("rttResponder"));
        assertEquals(false, ap.get("passpoint"));
        assertFalse(ap.has("venueName"));
        assertFalse(ap.has("operatorName"));
    }

    @Test
    public void fieldsNewerThanTheDeviceAreOmitted() throws Exception {
        JSONObject ap = ScanMapper.one(typical(), NOW);
        assertEquals("wifiStandard só existe do Android 11 em diante", Build.VERSION.SDK_INT >= 30, ap.has("wifiStandard"));
        if (ap.has("wifiStandard")) assertTrue(ap.get("wifiStandard") instanceof Integer);
        assertFalse("sem elementos no resultado, sem ies", ap.has("ies"));
        assertFalse(ap.has("mld"));
    }

    @Test
    public void quotedSsidLosesTheQuotes() throws Exception {
        ScanResult r = typical();
        r.SSID = "\"Rede do Zé\"";
        assertEquals("Rede do Zé", ScanMapper.one(r, NOW).get("ssid"));
        r.SSID = "\"";
        assertEquals("\"", ScanMapper.one(r, NOW).get("ssid"));
    }

    @Test
    public void hiddenNetworkHasEmptySsid() throws Exception {
        ScanResult r = typical();
        for (String hidden : new String[] {"", null, "\u0000\u0000\u0000\u0000"}) {
            r.SSID = hidden;
            assertEquals("", ScanMapper.one(r, NOW).get("ssid"));
        }
    }

    @Test
    public void undecodableSsidWithoutRawBytesIsEmptyNotTheSentinel() throws Exception {
        ScanResult r = typical();
        r.SSID = "<unknown ssid>";
        assertEquals("", ScanMapper.one(r, NOW).get("ssid"));
    }

    @Test
    public void flagsAndOptionalTexts() throws Exception {
        ScanResult r = typical();
        ReflectionHelpers.setField(r, "flags", 0x3L); // passpoint | 802.11mc
        r.venueName = "Aeroporto";
        r.operatorFriendlyName = "  Operadora X ";
        JSONObject ap = ScanMapper.one(r, NOW);
        assertEquals(true, ap.get("rttResponder"));
        assertEquals(true, ap.get("passpoint"));
        assertEquals("Aeroporto", ap.get("venueName"));
        assertEquals("Operadora X", ap.get("operatorName"));
    }

    @Test
    public void absurdTimestampsStayInsideZeroToNow() throws Exception {
        ScanResult r = typical();
        long[][] cases = {
            {Long.MAX_VALUE, 0},            // futuro distante
            {(NOW + 5000) * 1000, 0},       // um pouco no futuro
            {0, NOW},                       // sem carimbo: tão velho quanto o boot
            {-123456789L, NOW},
            {Long.MIN_VALUE, NOW},
            {NOW * 1000, 0},
        };
        for (long[] c : cases) {
            r.timestamp = c[0];
            assertEquals("timestamp " + c[0], c[1], ScanMapper.one(r, NOW).getLong("ageMs"));
        }
        assertEquals(0, ScanMapper.ageMs(5, -10));
    }

    @Test
    public void informationElementsComeAsHexOnAndroid11Plus() throws Exception {
        ScanResult r = typical();
        byte[] rsn = {0x01, 0x00, 0x00, 0x0f, (byte) 0xac, 0x04};
        ScanResult.InformationElement[] ies = {
            Fixtures.element(0, 0, "Casa".getBytes(StandardCharsets.UTF_8)),
            Fixtures.element(48, 0, rsn),
            Fixtures.element(255, 35, new byte[] {(byte) 0xff, 0x00}),
            Fixtures.element(221, 0, new byte[0]),
            Fixtures.element(7, 0, null), // corpo ausente: este é pulado, os outros ficam
            null,
        };
        ReflectionHelpers.setField(r, "informationElements", ies);
        JSONObject ap = ScanMapper.one(r, NOW);
        if (Build.VERSION.SDK_INT < 30) {
            assertFalse(ap.has("ies"));
            return;
        }
        JSONArray out = ap.getJSONArray("ies");
        assertEquals(4, out.length());
        assertEquals(0, out.getJSONObject(0).get("id"));
        assertEquals(0, out.getJSONObject(0).get("ext"));
        assertEquals("43617361", out.getJSONObject(0).get("hex"));
        assertEquals(48, out.getJSONObject(1).get("id"));
        assertEquals("0100000fac04", out.getJSONObject(1).get("hex"));
        assertEquals(255, out.getJSONObject(2).get("id"));
        assertEquals(35, out.getJSONObject(2).get("ext"));
        assertEquals("ff00", out.getJSONObject(2).get("hex"));
        assertEquals("", out.getJSONObject(3).get("hex"));
    }

    @Test
    public void undecodableSsidIsRecoveredFromTheBeaconWhenPossible() throws Exception {
        ScanResult r = typical();
        r.SSID = "<unknown ssid>";
        byte[] latin1 = {'J', 'o', (byte) 0xe3, 'o'}; // "João" em Latin-1: não é UTF-8 válido
        ReflectionHelpers.setField(r, "informationElements",
                new ScanResult.InformationElement[] {Fixtures.element(0, 0, latin1)});
        String expected = Build.VERSION.SDK_INT >= 30 ? "João" : "";
        assertEquals(expected, ScanMapper.one(r, NOW).get("ssid"));
    }

    @Test
    public void android13ReadsTheNameFromRawBytes() throws Exception {
        if (Build.VERSION.SDK_INT < 33) return;
        ScanResult r = typical();
        r.SSID = "ignorado";
        setWifiSsid(r, "Café ☕ 5G".getBytes(StandardCharsets.UTF_8));
        assertEquals("Café ☕ 5G", ScanMapper.one(r, NOW).get("ssid"));
        setWifiSsid(r, new byte[] {'J', 'o', (byte) 0xe3, 'o'});
        assertEquals("João", ScanMapper.one(r, NOW).get("ssid"));
        setWifiSsid(r, new byte[8]); // oculta: nome preenchido com zeros
        assertEquals("", ScanMapper.one(r, NOW).get("ssid"));
        setWifiSsid(r, new byte[0]);
        assertEquals("", ScanMapper.one(r, NOW).get("ssid"));
        setWifiSsid(r, "\"entre aspas\"".getBytes(StandardCharsets.UTF_8)); // aspas fazem parte do nome de verdade
        assertEquals("\"entre aspas\"", ScanMapper.one(r, NOW).get("ssid"));
    }

    @Test
    public void android13ReportsTheMldAddress() throws Exception {
        if (Build.VERSION.SDK_INT < 33) return;
        ScanResult r = typical();
        ReflectionHelpers.callInstanceMethod(r, "setApMldMacAddress",
                ClassParameter.from(MacAddress.class, MacAddress.fromString("02:AB:CD:EF:00:11")));
        assertEquals("02:ab:cd:ef:00:11", ScanMapper.one(r, NOW).get("mld"));
    }

    @Test
    public void oneBrokenResultDoesNotBreakTheList() throws Exception {
        ScanResult noBssid = typical();
        noBssid.BSSID = null;
        ScanResult emptyBssid = typical();
        emptyBssid.BSSID = "";
        ScanResult nullCaps = typical();
        nullCaps.BSSID = "11:22:33:44:55:66";
        nullCaps.capabilities = null;
        List<ScanResult> list = Arrays.asList(typical(), null, noBssid, emptyBssid, nullCaps);
        JSONArray out = ScanMapper.list(list, NOW);
        assertEquals(2, out.length());
        assertEquals("aa:bb:cc:dd:ee:0f", out.getJSONObject(0).get("bssid"));
        assertEquals("", out.getJSONObject(1).get("capabilities"));
        assertEquals(0, ScanMapper.list(null, NOW).length());
        assertNull(ScanMapper.one(null, NOW));
    }

    @Test
    public void hugeListsAreCappedKeepingTheStrongest() throws Exception {
        List<ScanResult> many = new ArrayList<>();
        for (int i = 0; i < ScanMapper.MAX_APS + 50; i++) {
            many.add(Fixtures.scanResult("r" + i, String.format("02:00:00:00:%02x:%02x", i / 256, i % 256), "[ESS]", -100 + (i % 70), 2412));
        }
        many.add(3, null);
        JSONArray out = ScanMapper.list(many, NOW);
        assertEquals(ScanMapper.MAX_APS, out.length());
        int weakest = 0;
        for (int i = 0; i < out.length(); i++) weakest = Math.min(weakest, out.getJSONObject(i).getInt("level"));
        assertTrue("as mais fracas é que ficam de fora", weakest > -100);
    }

    private static void setWifiSsid(ScanResult r, byte[] bytes) {
        ReflectionHelpers.callInstanceMethod(r, "setWifiSsid", ClassParameter.from(WifiSsid.class, WifiSsid.fromBytes(bytes)));
    }
}
