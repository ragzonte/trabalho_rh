package com.wifiraiox.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.net.Uri;
import android.util.Base64;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** share / saveFile: nome de arquivo seguro, limites e a entrega pelo FileProvider. */
public class SharerTest extends AllSdks {

    private Activity activity;
    private Bridge bridge;

    @Before
    public void setUp() {
        Fixtures.forgetFileProviderPaths();
        activity = Fixtures.activity();
        bridge = Fixtures.bridge(activity, new Fixtures.Page());
    }

    private File sharedDir() {
        return new File(activity.getCacheDir(), Sharer.FOLDER);
    }

    private Intent nextStarted() {
        return shadowOf(activity).getNextStartedActivity();
    }

    @Test
    public void fileNamesAreSanitised() {
        String[][] table = {
            {"relatorio.pdf", "relatorio.pdf"},
            {"Relatório de Wi-Fi (casa) 2026-11-15.csv", "Relatório de Wi-Fi (casa) 2026-11-15.csv"},
            {"../../../data/data/outro.app/files/segredo", "segredo"},
            {"..\\..\\windows\\system32\\cmd.exe", "cmd.exe"},
            {"/etc/passwd", "passwd"},
            {"C:\\Users\\ana\\mapa.json", "mapa.json"},
            {"..", "arquivo"},
            {".", "arquivo"},
            {"...oculto", "oculto"},
            {".htaccess", "htaccess"},
            {"", "arquivo"},
            {"   ", "arquivo"},
            {null, "arquivo"},
            {"pasta/", "arquivo"},
            {"a\u0000b\nc\td.txt", "abcd.txt"},
            {"mapa:3d*?\"<>|.png", "mapa_3d______.png"},
            {"nome;rm -rf $HOME`x`.txt", "nome_rm -rf _HOME_x_.txt"},
            {"日本語のファイル.txt", "日本語のファイル.txt"},
            {"emoji \uD83D\uDCF6 sinal.txt", "emoji __ sinal.txt"},
        };
        for (String[] row : table) assertEquals(String.valueOf(row[0]), row[1], Sharer.sanitizeName(row[0]));

        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 300; i++) huge.append('x');
        String cut = Sharer.sanitizeName(huge + ".json");
        assertEquals(80, cut.length());
        assertTrue("a extensão sobrevive ao corte", cut.endsWith(".json"));
        assertEquals(80, Sharer.sanitizeName(huge.toString()).length());
    }

    @Test
    public void mimeTypesAreValidatedOrReplaced() {
        assertEquals("application/json", Sharer.sanitizeMime("application/json"));
        assertEquals("text/csv", Sharer.sanitizeMime(" Text/CSV "));
        assertEquals("image/svg+xml", Sharer.sanitizeMime("image/svg+xml"));
        assertEquals("application/vnd.ms-excel", Sharer.sanitizeMime("application/vnd.ms-excel"));
        for (String bad : new String[] {null, "", "json", "text/", "/plain", "text/plain; charset=utf-8", "text/pl ain", "a/b/c", "te\nxt/plain"}) {
            assertEquals(String.valueOf(bad), "application/octet-stream", Sharer.sanitizeMime(bad));
        }
    }

    @Test
    public void writtenFileStaysInsideTheSharedFolder() throws Exception {
        File f = Sharer.write(activity, "../../fuga.txt", "oi".getBytes(StandardCharsets.UTF_8));
        assertEquals(sharedDir().getCanonicalFile(), f.getCanonicalFile().getParentFile());
        assertEquals("fuga.txt", f.getName());
        assertEquals("oi", new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
    }

    @Test
    public void oldExportsAreDeletedRecentOnesKept() throws Exception {
        File old = Sharer.write(activity, "antigo.csv", new byte[] {1});
        File recent = Sharer.write(activity, "recente.csv", new byte[] {2});
        assertTrue(old.setLastModified(System.currentTimeMillis() - Sharer.KEEP_MS - 60_000));
        File again = Sharer.write(activity, "recente.csv", new byte[] {3, 4});
        assertFalse(old.exists());
        assertTrue(recent.exists());
        assertEquals(recent, again);
        assertEquals("mesmo nome: substitui", 2, again.length());
    }

    @Test
    public void payloadFromTextAndBase64() {
        assertArrayEquals("ção".getBytes(StandardCharsets.UTF_8), Sharer.payload("ção", null));
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0, 1, 2, (byte) 0xff};
        assertArrayEquals(png, Sharer.payload(null, Base64.encodeToString(png, Base64.NO_WRAP)));
        assertArrayEquals(png, Sharer.payload(null, Base64.encodeToString(png, Base64.DEFAULT))); // com quebras de linha
        assertEquals(0, Sharer.payload("", null).length);
    }

    @Test
    public void oversizedPayloadIsRefused() {
        StringBuilder big = new StringBuilder();
        String chunk = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64
        int n = (int) (Sharer.MAX_BYTES / 64) + 1;
        big.ensureCapacity(n * 64);
        for (int i = 0; i < n; i++) big.append(chunk);
        String text = big.toString();
        assertNull("texto acima do teto", Sharer.payload(text, null));
        assertNull("base64 que decodifica acima do teto", Sharer.payload(null, text + text.substring(0, text.length() / 2)));
        assertNotNull(Sharer.payload(text.substring(0, 1024), null));
    }

    @Test
    public void providerIsDeclaredPrivateWithUriGrants() throws Exception {
        ProviderInfo info = activity.getPackageManager().resolveContentProvider(Sharer.authority(activity), PackageManager.GET_META_DATA);
        assertNotNull(info);
        assertEquals("com.wifiraiox.app.fileprovider", info.authority);
        assertEquals(SharedFileProvider.class.getName(), info.name);
        assertFalse("exportado, o FileProvider derruba o app na partida", info.exported);
        assertTrue(info.grantUriPermissions);
    }

    @Test
    public void saveFileSharesAContentUriWithReadGrant() throws Exception {
        JSONObject args = new JSONObject()
                .put("name", "../relatorio wifi.csv") // (acentos no nome dependem do locale da JVM de teste; no Android é sempre UTF-8)
                .put("mime", "text/csv")
                .put("text", "ssid;sinal\nCasa;-52\n");
        assertEquals("{\"ok\":true}", bridge.call("saveFile", args.toString()));

        Intent chooser = nextStarted();
        assertNotNull(chooser);
        assertEquals(Intent.ACTION_CHOOSER, chooser.getAction());
        assertTrue((chooser.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        Intent send = chooser.getParcelableExtra(Intent.EXTRA_INTENT);
        assertNotNull(send);
        assertEquals(Intent.ACTION_SEND, send.getAction());
        assertEquals("text/csv", send.getType());
        assertTrue((send.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);

        Uri uri = send.getParcelableExtra(Intent.EXTRA_STREAM);
        assertNotNull(uri);
        assertEquals("content", uri.getScheme());
        assertEquals("com.wifiraiox.app.fileprovider", uri.getAuthority());
        assertEquals("/shared/relatorio wifi.csv", uri.getPath());
        ClipData clip = send.getClipData();
        assertNotNull("sem ClipData a permissão de leitura não chega ao app de destino", clip);
        assertEquals(uri, clip.getItemAt(0).getUri());

        // o conteúdo que o outro app vai ler pelo provedor
        try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            assertEquals("ssid;sinal\nCasa;-52\n", new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
        assertTrue(new File(sharedDir(), "relatorio wifi.csv").isFile());
    }

    @Test
    public void saveFileFromBase64AndWithUnknownMime() throws Exception {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
        JSONObject args = new JSONObject().put("name", "mapa.png").put("mime", "isto não é mime")
                .put("base64", Base64.encodeToString(png, Base64.NO_WRAP));
        assertEquals("{\"ok\":true}", bridge.call("saveFile", args.toString()));
        Intent send = nextStarted().getParcelableExtra(Intent.EXTRA_INTENT);
        assertEquals("application/octet-stream", send.getType());
        assertArrayEquals(png, Files.readAllBytes(new File(sharedDir(), "mapa.png").toPath()));
    }

    @Test
    public void saveFileRejectsBadArguments() throws Exception {
        String[] bad = {
            "{}",
            "{\"name\":\"a.txt\"}",
            "{\"text\":\"x\"}",
            "{\"name\":\"\",\"text\":\"x\"}",
            "{\"name\":\"a.txt\",\"text\":\"x\",\"base64\":\"eA==\"}",
            "{\"name\":\"a.txt\",\"text\":5}",
            "{\"name\":7,\"text\":\"x\"}",
            "{\"name\":\"a.bin\",\"base64\":\"A\"}",      // base64 truncado
            "{\"name\":\"a.bin\",\"base64\":\"=AAA\"}",   // preenchimento no lugar errado
        };
        for (String args : bad) {
            JSONObject r = new JSONObject(bridge.call("saveFile", args));
            assertTrue(args + " -> " + r, r.has("error"));
        }
        assertNull("nada foi aberto", nextStarted());
        File[] files = sharedDir().listFiles();
        assertTrue(files == null || files.length == 0);
    }

    @Test
    public void shareSendsPlainTextThroughTheChooser() throws Exception {
        JSONObject args = new JSONObject().put("title", "Minha rede").put("text", "Canal 6, -52 dBm \u2028 \"ok\"");
        assertEquals("{\"ok\":true}", bridge.call("share", args.toString()));
        Intent chooser = nextStarted();
        assertEquals(Intent.ACTION_CHOOSER, chooser.getAction());
        assertEquals("Minha rede", chooser.getStringExtra(Intent.EXTRA_TITLE));
        Intent send = chooser.getParcelableExtra(Intent.EXTRA_INTENT);
        assertEquals(Intent.ACTION_SEND, send.getAction());
        assertEquals("text/plain", send.getType());
        assertEquals("Canal 6, -52 dBm \u2028 \"ok\"", send.getStringExtra(Intent.EXTRA_TEXT));
        assertEquals("Minha rede", send.getStringExtra(Intent.EXTRA_SUBJECT));

        assertEquals("{\"ok\":true}", bridge.call("share", "{\"text\":\"sem título\"}"));
        assertNotNull(nextStarted());
        assertTrue(new JSONObject(bridge.call("share", "{\"title\":\"sem texto\"}")).has("error"));
        assertTrue(new JSONObject(bridge.call("share", "{\"text\":123}")).has("error"));
    }

    @Test
    public void noAppToReceiveGivesOkFalseInsteadOfCrashing() throws Exception {
        shadowOf(Fixtures.app()).checkActivities(true); // startActivity passa a lançar ActivityNotFoundException
        assertEquals("{\"ok\":false}", bridge.call("share", "{\"text\":\"oi\"}"));
        assertEquals("{\"ok\":false}", bridge.call("saveFile", "{\"name\":\"a.txt\",\"text\":\"oi\"}"));
    }
}
