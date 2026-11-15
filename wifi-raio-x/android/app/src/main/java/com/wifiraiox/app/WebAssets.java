package com.wifiraiox.app;

import android.content.Context;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serve a interface (assets/www do APK) como se fosse um site https. O tipo de cada arquivo é
 * decidido aqui, e não pelo Android: módulos ES e Web Workers só carregam se o .js chegar como
 * text/javascript, e a tabela do sistema varia de aparelho para aparelho.
 */
final class WebAssets implements WebViewAssetLoader.PathHandler {

    /** Caminho na URL e pasta correspondente dentro de assets/. */
    static final String URL_PATH = "/assets/www/";
    private static final String ROOT = "www/";

    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("htm", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("mjs", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("json", "application/json");
        TYPES.put("map", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("txt", "text/plain");
        TYPES.put("csv", "text/csv");
        TYPES.put("xml", "application/xml");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("jpeg", "image/jpeg");
        TYPES.put("gif", "image/gif");
        TYPES.put("webp", "image/webp");
        TYPES.put("avif", "image/avif");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("woff", "font/woff");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("ttf", "font/ttf");
        TYPES.put("otf", "font/otf");
        TYPES.put("wasm", "application/wasm");
        TYPES.put("glb", "model/gltf-binary");
        TYPES.put("gltf", "model/gltf+json");
        TYPES.put("bin", "application/octet-stream");
        TYPES.put("mp3", "audio/mpeg");
        TYPES.put("ogg", "audio/ogg");
        TYPES.put("wav", "audio/wav");
    }

    private final Context context;

    WebAssets(Context context) {
        this.context = context.getApplicationContext();
    }

    static String mimeOf(String path) {
        int slash = path.lastIndexOf('/');
        int dot = path.lastIndexOf('.');
        if (dot <= slash) return "text/plain";
        String type = TYPES.get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "text/plain" : type;
    }

    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("xml")
                || mime.equals("application/javascript");
    }

    @Override
    public WebResourceResponse handle(@NonNull String path) {
        String clean = path.startsWith("/") ? path.substring(1) : path;
        if (clean.isEmpty() || clean.endsWith("/")) clean += "index.html";
        if (clean.contains("..") || clean.indexOf('\\') >= 0) return status(404, "Not Found");
        String mime = mimeOf(clean);
        InputStream in;
        try {
            in = context.getAssets().open(ROOT + clean);
        } catch (IOException e) {
            // Responder 404 na hora: sem isto o WebView iria procurar o domínio reservado na internet.
            return status(404, "Not Found");
        }
        Map<String, String> headers = new HashMap<>();
        if ("text/html".equals(mime)) {
            // A ponte nativa é injetada em todo quadro da página; um iframe de outro site também a
            // receberia. A interface é toda local, então quadros externos ficam proibidos.
            headers.put("Content-Security-Policy", "frame-src 'self' blob: data:");
        }
        return new WebResourceResponse(mime, isText(mime) ? "UTF-8" : null, 200, "OK", headers, in);
    }

    /** Resposta vazia com o código informado. */
    static WebResourceResponse status(int code, String reason) {
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, new HashMap<>(),
                new ByteArrayInputStream(new byte[0]));
    }
}
