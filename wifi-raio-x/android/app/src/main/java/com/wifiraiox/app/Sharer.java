package com.wifiraiox.app;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/** Compartilhar texto e exportar arquivos (relatórios, mapas) pelo "compartilhar/salvar" do Android. */
final class Sharer {

    /** Teto do arquivo exportado: acima disto é erro da página, não um relatório. */
    static final long MAX_BYTES = 20L * 1024 * 1024;
    /** Pasta dentro do cache; precisa bater com res/xml/file_paths.xml. */
    static final String FOLDER = "shared";
    /** Exportações antigas são apagadas; as recentes ficam porque o app de destino pode ainda estar lendo. */
    static final long KEEP_MS = 60L * 60 * 1000;
    private static final int MAX_NAME = 80;
    private static final String DEFAULT_NAME = "arquivo";
    private static final String DEFAULT_MIME = "application/octet-stream";

    private Sharer() {}

    static String authority(Context context) {
        return context.getPackageName() + ".fileprovider";
    }

    /**
     * Nome de arquivo seguro: sem pastas ("../", "C:\..."), sem caracteres de controle ou símbolos
     * estranhos, sem ponto inicial e com tamanho limitado.
     */
    static String sanitizeName(String raw) {
        if (raw == null) return DEFAULT_NAME;
        String s = raw;
        int cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        if (cut >= 0) s = s.substring(cut + 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isLetterOrDigit(c) || c == '.' || c == '-' || c == '_' || c == ' '
                    || c == '(' || c == ')' || c == '+') {
                sb.append(c);
            } else if (!Character.isISOControl(c)) {
                sb.append('_');
            }
        }
        s = sb.toString().trim();
        int start = 0;
        while (start < s.length() && s.charAt(start) == '.') start++;
        s = s.substring(start).trim();
        if (s.length() > MAX_NAME) {
            // corta o meio e preserva a extensão
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 && s.length() - dot <= 10 ? s.substring(dot) : "";
            s = s.substring(0, MAX_NAME - ext.length()).trim() + ext;
        }
        return s.isEmpty() ? DEFAULT_NAME : s;
    }

    /** "tipo/subtipo" simples ou o genérico. */
    static String sanitizeMime(String raw) {
        if (raw == null) return DEFAULT_MIME;
        String s = raw.trim().toLowerCase(Locale.ROOT);
        return s.matches("[a-z0-9][a-z0-9.+-]{0,60}/[a-z0-9*][a-z0-9.+*-]{0,80}") ? s : DEFAULT_MIME;
    }

    /** Bytes do arquivo a partir de `text` (UTF-8) ou `base64`. null = grande demais. Base64 inválido lança. */
    static byte[] payload(String text, String base64) {
        if (text != null) {
            if (text.length() > MAX_BYTES) return null;
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            return bytes.length > MAX_BYTES ? null : bytes;
        }
        if (base64.length() / 4L * 3L > MAX_BYTES + 3) return null;
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        return bytes.length > MAX_BYTES ? null : bytes;
    }

    /** Grava em cache/shared/<nome limpo>, apagando exportações antigas. */
    static File write(Context context, String rawName, byte[] data) throws IOException {
        File dir = new File(context.getCacheDir(), FOLDER);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("sem pasta de exportação");
        String name = sanitizeName(rawName);
        long now = System.currentTimeMillis();
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                if (f.isFile() && (f.getName().equals(name) || now - f.lastModified() > KEEP_MS)) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        }
        File file = new File(dir, name);
        // Cinto e suspensório: depois da limpeza do nome o arquivo tem de estar dentro da pasta.
        if (!dir.getCanonicalFile().equals(file.getCanonicalFile().getParentFile())) {
            throw new IOException("nome de arquivo inválido");
        }
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
        return file;
    }

    static Uri uriFor(Context context, File file) {
        return FileProvider.getUriForFile(context, authority(context), file);
    }

    /** "Enviar para..." com o arquivo e permissão de leitura só para o app escolhido. */
    static Intent sendFile(Uri uri, String mime, String name, CharSequence chooserTitle) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(sanitizeMime(mime));
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_TITLE, name);
        send.setClipData(ClipData.newRawUri(name, uri)); // é o ClipData que carrega a permissão até o destino
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, chooserTitle);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return chooser;
    }

    static Intent sendText(String title, String text) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        if (title != null && !title.isEmpty()) {
            send.putExtra(Intent.EXTRA_SUBJECT, title);
            send.putExtra(Intent.EXTRA_TITLE, title);
        }
        return Intent.createChooser(send, title == null || title.isEmpty() ? null : title);
    }
}
