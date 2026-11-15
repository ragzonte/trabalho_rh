package com.wifiraiox.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** O destino do ping vira argumento de um programa: só passa o que é inequivocamente um endereço ou nome. */
public class PingHostTest {

    @Test
    public void acceptsAddressesAndNames() {
        String[] ok = {
            "8.8.8.8", "192.168.0.1", "0.0.0.0", "255.255.255.255", "10.0.0.254",
            "::1", "fe80::1", "2001:4860:4860::8888", "2804:14c:1:2:3:4:5:6", "::ffff:192.168.0.1",
            "fe80::1c2d:3eff:fe4f:5a6b%wlan0", "fe80::1%3",
            "google.com", "www.uol.com.br", "localhost", "roteador", "meu-pc.local", "my_nas.lan",
            "a.b.c.d.e.f.g", "xn--caf-dma.example", "host123", "1e100.net", "example.com.", "3com.com",
        };
        for (String h : ok) assertTrue(h, PingHost.isValid(h));
        StringBuilder longest = new StringBuilder();
        while (longest.length() < 250) longest.append("abcdefghi.");
        assertTrue(PingHost.isValid(longest.substring(0, 249) + ".br"));
    }

    @Test
    public void rejectsOptionInjection() {
        String[] attacks = {
            "-c", "-f", "-h", "--help", "-I wlan0", "-s 65000 8.8.8.8", "-c1000000", "-",
            "8.8.8.8 -f", "8.8.8.8 -c 9999", "8.8.8.8\n-f", "8.8.8.8\t-f", "host -n",
        };
        for (String h : attacks) assertFalse(h, PingHost.isValid(h));
    }

    @Test
    public void rejectsShellMetacharactersEvenThoughNoShellIsUsed() {
        String[] attacks = {
            "8.8.8.8; rm -rf /", "8.8.8.8 && reboot", "$(id)", "`id`", "a|b", "a>b", "a<b", "a&b",
            "google.com;ls", "'quoted'", "\"quoted\"", "a\\b", "a/b", "../../etc/passwd", "a*b", "a?b",
            "{a,b}", "~root", "a=b", "a#b", "a!b", "a@b", "http://google.com", "google.com:80", "google.com/path",
            "[::1]", "a%b", "\u0000", "a\u0000b", "café.com", "例え.jp", " google.com", "google.com ",
        };
        for (String h : attacks) assertFalse(h, PingHost.isValid(h));
    }

    @Test
    public void rejectsLookAlikeCharactersFromOtherAlphabets() {
        // Character.digit() aceita algarismos de qualquer alfabeto; o validador não pode.
        String[] sosias = {
            "１::１", "fe80::１", "ＦＥ８０::1", "٢٠٠١:db8::1", "२००१::१", "::ｆｆｆｆ:1.2.3.4",   // "IPv6" com algarismos de largura cheia, arábicos, devanágari
            "８.８.８.８", "٨.٨.٨.٨", "1.1.1.１",                                           // "IPv4"
            "ｇｏｏｇｌｅ.com", "gооgle.com", "google。com", "google．com", "goo​gle.com", "‮moc.elgoog", // nomes
            "fe80::1%ｗlan0", "fe80::1%wlan０",                                           // escopo
        };
        for (String h : sosias) assertFalse(h, PingHost.isValid(h));
        assertTrue(PingHost.isHex('0') && PingHost.isHex('9') && PingHost.isHex('a') && PingHost.isHex('F'));
        assertFalse(PingHost.isHex('g') || PingHost.isHex('１') || PingHost.isHex('٨') || PingHost.isHex(':'));
    }

    @Test
    public void rejectsMalformedInput() {
        String[] bad = {
            null, "", ".", "..", "a..b", ".com", "-host.com", "host-.com", "a.-b.c",
            "1.2.3", "1.2.3.4.5", "256.1.1.1", "999.999.999.999", "1.2.3.", "1", "12345", "0x7f.0.0.1.2",
            "1.2.3.4/24", ":", "1:2", "fe80::1%", "fe80::1%wlan0;id", "fe80::1%wlan-0", "::g", "1::2::3::4::5::6::7::8::9",
            "12:34:56:78:9a:bc:de:f0:11", "::1.2.3", "1.2.3.4::",
        };
        for (String h : bad) assertFalse(String.valueOf(h), PingHost.isValid(h));
        StringBuilder tooLong = new StringBuilder();
        while (tooLong.length() <= PingHost.MAX_LENGTH) tooLong.append("abcdefghi.");
        assertFalse(PingHost.isValid(tooLong + "com"));
        StringBuilder label = new StringBuilder();
        for (int i = 0; i < 64; i++) label.append('a');
        assertFalse("rótulo com mais de 63 letras", PingHost.isValid(label + ".com"));
    }
}
