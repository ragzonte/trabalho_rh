package com.wifiraiox.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;

/**
 * A ponte nativa: o objeto que a página enxerga como window.WrxNative. O contrato (métodos,
 * argumentos, formato das respostas e dos eventos) está no cabeçalho de app/js/bridge.js.
 *
 * Este lado é propositalmente burro: lê o Android e entrega os dados crus; quem interpreta é o JS.
 * Os métodos @JavascriptInterface rodam numa thread do WebView, então: nada de tocar na interface
 * dali, respostas rápidas, e qualquer erro vira {"error": "..."} em vez de derrubar o app.
 */
public final class Bridge implements Emitter {

    /** Nome com que o objeto aparece na página. */
    public static final String JS_NAME = "WrxNative";

    static final String ERR_FORBIDDEN = "origem não autorizada";
    static final String ERR_ARGS = "argumentos inválidos";
    static final String ERR_UNKNOWN = "método desconhecido: ";
    static final String ERR_ASYNC_ONLY = "método assíncrono, use callAsync: ";
    static final String ERR_CLOSED = "encerrado";
    private static final long UI_WAIT_MS = 1500;

    private final Activity activity;
    private final JsSink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Executor scanWorker;
    private final ExecutorService ownedScanWorker;
    private final ExecutorService io = Executors.newCachedThreadPool(Sys.threads("io"));
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(Sys.threads("timer"));

    private final Permissions permissions;
    private final StatusReader status;
    private final StatusWatcher statusWatcher;
    private final DeviceInfoReader deviceInfo;
    private final WifiScanner scanner;
    private final ConnectionTracker connection;
    private final RssiWatcher rssi;
    private final RttRanger rtt;
    private final Pinger pinger;
    private final LanScanner lan;
    private final SpeedTester speed;
    private final Haptics haptics;

    /** ids de callAsync ainda sem resposta. Cada um é respondido exatamente uma vez. */
    private final Set<Integer> pending = ConcurrentHashMap.newKeySet();
    private volatile boolean trustedPage;
    private volatile boolean destroyed;
    private String lastStatus;

    public Bridge(Activity activity, JsSink sink) {
        this(activity, sink, null, null, null, null);
    }

    /** Para os testes: permite trocar a thread da varredura e as partes que falam com a rede. */
    Bridge(Activity activity, JsSink sink, Executor scanExecutor, Pinger customPinger, LanScanner customLan,
           SpeedTester customSpeed) {
        this.activity = activity;
        this.sink = sink;
        if (scanExecutor == null) {
            ownedScanWorker = Executors.newSingleThreadExecutor(Sys.threads("scan"));
            scanWorker = ownedScanWorker;
        } else {
            ownedScanWorker = null;
            scanWorker = scanExecutor;
        }
        permissions = new Permissions(activity);
        status = new StatusReader(activity, permissions);
        statusWatcher = new StatusWatcher(activity, () -> emitStatus(false));
        deviceInfo = new DeviceInfoReader(activity);
        scanner = new WifiScanner(activity, permissions, scanWorker, event -> emit("scan", event));
        connection = new ConnectionTracker(activity, main, c -> emit("connection", c));
        rssi = new RssiWatcher(main, connection::rssiSample, sample -> emit("rssi", sample));
        rtt = new RttRanger(activity, main, permissions);
        pinger = customPinger != null ? customPinger : new Pinger(timer);
        lan = customLan != null ? customLan : new LanScanner();
        speed = customSpeed != null ? customSpeed : new SpeedTester();
        haptics = new Haptics(activity);
    }

    // ------------------------------------------------------------------ vindo da página

    /** Chamada com resposta imediata. Sempre devolve JSON; falhas voltam como {"error": "..."}. */
    @JavascriptInterface
    public String call(String method, String argsJson) {
        try {
            if (!trustedPage) return Json.error(ERR_FORBIDDEN).toString();
            if (destroyed) return Json.error(ERR_CLOSED).toString();
            if (method == null) return Json.error(ERR_UNKNOWN + "null").toString();
            JSONObject args = parseArgs(argsJson);
            if (args == null) return Json.error(ERR_ARGS).toString();
            JSONObject out = dispatch(method, args);
            if (out == null) out = Json.error((isAsyncMethod(method) ? ERR_ASYNC_ONLY : ERR_UNKNOWN) + method);
            return out.toString();
        } catch (Throwable t) {
            return Json.error(describe(t)).toString();
        }
    }

    /** Chamada com resposta posterior, entregue por window.__wrx.resolve(id, resultado). */
    @JavascriptInterface
    public void callAsync(final int id, String method, String argsJson) {
        if (!trustedPage || destroyed) return; // página estranha: nem resposta recebe
        pending.add(id);
        try {
            if (method == null) {
                finish(id, Json.error(ERR_UNKNOWN + "null"));
                return;
            }
            JSONObject args = parseArgs(argsJson);
            if (args == null) {
                finish(id, Json.error(ERR_ARGS));
                return;
            }
            dispatchAsync(id, method, args);
        } catch (Throwable t) {
            finish(id, Json.error(describe(t)));
        }
    }

    /** Ausência de argumentos vale como {}; qualquer coisa que não seja um objeto JSON é erro. */
    private static JSONObject parseArgs(String argsJson) {
        if (argsJson == null) return new JSONObject();
        String s = argsJson.trim();
        if (s.isEmpty() || "null".equals(s) || "undefined".equals(s)) return new JSONObject();
        if (s.charAt(0) != '{') return null;
        try {
            return new JSONObject(s);
        } catch (JSONException e) {
            return null;
        }
    }

    private static boolean isAsyncMethod(String method) {
        return "requestPermission".equals(method) || "scan".equals(method) || "rtt".equals(method)
                || "ping".equals(method) || "lanScan".equals(method) || "speedTest".equals(method);
    }

    /** null = método desconhecido (ou só assíncrono). */
    private JSONObject dispatch(String method, JSONObject args) throws Exception {
        switch (method) {
            case "info":
                return deviceInfo.read();
            case "status":
                return status.read();
            case "lastScan":
                return scanner.lastScan();
            case "connection":
                return connection.read();
            case "watchRssi":
                return watchRssi(args);
            case "unwatchRssi":
                rssi.unwatch();
                return Json.ok();
            case "openSettings":
                return openSettings(args);
            case "keepAwake":
                return keepAwake(args);
            case "vibrate":
                return vibrate(args);
            case "setBars":
                return setBars(args);
            case "share":
                return share(args);
            case "saveFile":
                return saveFile(args);
            case "cancel":
                return cancel(args);
            default:
                return null;
        }
    }

    private void dispatchAsync(final int id, String method, JSONObject args) throws Exception {
        switch (method) {
            case "requestPermission":
                onMain(id, () -> permissions.requestLocation(() -> {
                    finish(id, status.read());
                    emitStatus(true);
                }));
                return;
            case "scan":
                finish(id, scanner.request());
                return;
            case "rtt":
                startRtt(id, args);
                return;
            case "ping":
                startPing(id, args);
                return;
            case "lanScan":
                startLanScan(id);
                return;
            case "speedTest":
                startSpeedTest(id, args);
                return;
            default:
                // Método de resposta imediata chamado pelo caminho assíncrono: atende do mesmo jeito.
                JSONObject out = dispatch(method, args);
                finish(id, out != null ? out : Json.error(ERR_UNKNOWN + method));
        }
    }

    // ------------------------------------------------------------------ métodos de resposta imediata

    private JSONObject watchRssi(JSONObject args) {
        if (args.has("intervalMs") && !(args.opt("intervalMs") instanceof Number)) return Json.error(ERR_ARGS + ": intervalMs");
        rssi.watch(RssiWatcher.clampInterval(Json.number(args, "intervalMs", RssiWatcher.DEFAULT_INTERVAL_MS)));
        return Json.ok();
    }

    private JSONObject openSettings(JSONObject args) {
        final String which = Json.string(args, "which");
        if (!SettingsOpener.known(which)) return Json.error(ERR_ARGS + ": which");
        return Json.ok(Sys.callOnMain(main, () -> SettingsOpener.open(activity, which), UI_WAIT_MS, false));
    }

    private JSONObject keepAwake(JSONObject args) {
        if (!(args.opt("on") instanceof Boolean)) return Json.error(ERR_ARGS + ": on");
        final boolean on = args.optBoolean("on");
        Sys.runOnMain(main, () -> {
            Window window = activity.getWindow();
            if (window == null) return;
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        return Json.ok();
    }

    private JSONObject vibrate(JSONObject args) {
        if (args.has("ms") && !(args.opt("ms") instanceof Number)) return Json.error(ERR_ARGS + ": ms");
        haptics.vibrate(Json.number(args, "ms", 20));
        return Json.ok();
    }

    private JSONObject setBars(JSONObject args) {
        final Integer color = SystemBars.parseColor(Json.string(args, "color"));
        if (color == null) return Json.error(ERR_ARGS + ": color");
        final boolean dark = Json.bool(args, "dark", false);
        Sys.runOnMain(main, () -> {
            try {
                SystemBars.apply(activity, color, dark);
            } catch (RuntimeException ignored) {
                // cor de barra nunca derruba o app
            }
        });
        return Json.ok();
    }

    private JSONObject share(JSONObject args) {
        final String text = Json.string(args, "text");
        if (text == null) return Json.error(ERR_ARGS + ": text");
        final String title = Json.string(args, "title");
        return Json.ok(startOnMain(Sharer.sendText(title, text)));
    }

    private JSONObject saveFile(JSONObject args) {
        String name = Json.string(args, "name");
        String text = Json.string(args, "text");
        String base64 = Json.string(args, "base64");
        if (name == null || name.trim().isEmpty()) return Json.error(ERR_ARGS + ": name");
        if ((text == null) == (base64 == null)) return Json.error(ERR_ARGS + ": text ou base64");
        byte[] data;
        try {
            data = Sharer.payload(text, base64);
        } catch (IllegalArgumentException e) {
            return Json.error(ERR_ARGS + ": base64");
        }
        if (data == null) return Json.ok(false); // grande demais
        try {
            File file = Sharer.write(activity, name, data);
            Uri uri = Sharer.uriFor(activity, file);
            Intent chooser = Sharer.sendFile(uri, Json.string(args, "mime"), file.getName(),
                    activity.getString(R.string.share_file_title));
            return Json.ok(startOnMain(chooser));
        } catch (Exception e) {
            return Json.ok(false); // sem espaço, sem pasta...
        }
    }

    private JSONObject cancel(JSONObject args) {
        String op = Json.string(args, "op");
        if ("ping".equals(op)) pinger.cancel();
        else if ("lan".equals(op)) lan.cancel();
        else if ("speed".equals(op)) speed.cancel();
        else return Json.error(ERR_ARGS + ": op");
        return Json.ok();
    }

    /** startActivity precisa da thread da interface; esperamos um instante para saber se abriu. */
    private boolean startOnMain(final Intent intent) {
        return Sys.callOnMain(main, () -> {
            try {
                activity.startActivity(intent);
                return true;
            } catch (RuntimeException e) {
                return false;
            }
        }, UI_WAIT_MS, false);
    }

    // ------------------------------------------------------------------ métodos de resposta posterior

    private void startRtt(final int id, JSONObject args) {
        JSONArray array = args.optJSONArray("bssids");
        if (array == null) {
            finish(id, Json.error(ERR_ARGS + ": bssids"));
            return;
        }
        final List<String> bssids = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            Object v = array.opt(i);
            if (v instanceof String) bssids.add((String) v);
        }
        onMain(id, () -> rtt.range(bssids, result -> finish(id, result)));
    }

    private void startPing(final int id, JSONObject args) {
        final String host = Json.string(args, "host");
        if (!PingHost.isValid(host)) {
            finish(id, Json.error(Pinger.ERR_INVALID_HOST));
            return;
        }
        final int count = Json.clamp(Json.number(args, "count", 10), Pinger.MIN_COUNT, Pinger.MAX_COUNT);
        final int timeoutMs = Json.clamp(Json.number(args, "timeoutMs", 1000), Pinger.MIN_TIMEOUT_MS, Pinger.MAX_TIMEOUT_MS);
        background(id, () -> finish(id, pinger.run(host, count, timeoutMs, reply -> emit("ping", reply))));
    }

    private void startLanScan(final int id) {
        background(id, () -> finish(id, lan.run(connection.lanTarget(), new LanScanner.Events() {
            @Override
            public void onDevice(JSONObject device) {
                emit("lan", device);
            }

            @Override
            public void onProgress(int done, int total) {
                JSONObject o = new JSONObject();
                Json.put(o, "done", done);
                Json.put(o, "total", total);
                emit("lanProgress", o);
            }
        })));
    }

    private void startSpeedTest(final int id, JSONObject args) {
        final String mode = args.has("mode") ? Json.string(args, "mode") : SpeedTester.MODE_FULL;
        if (!SpeedTester.validMode(mode)) {
            finish(id, Json.error(ERR_ARGS + ": mode"));
            return;
        }
        background(id, () -> finish(id, speed.run(mode, connection.wifiNetwork(), progress -> emit("speed", progress))));
    }

    /** Roda na thread da interface; qualquer falha vira a resposta de erro da chamada. */
    private void onMain(final int id, final Runnable task) {
        Sys.runOnMain(main, () -> {
            try {
                task.run();
            } catch (Throwable t) {
                finish(id, Json.error(describe(t)));
            }
        });
    }

    /** Roda numa thread de trabalho (rede, processos); qualquer falha vira a resposta de erro da chamada. */
    private void background(final int id, final Runnable task) {
        try {
            io.execute(() -> {
                try {
                    task.run();
                } catch (Throwable t) {
                    finish(id, Json.error(describe(t)));
                }
            });
        } catch (RejectedExecutionException e) {
            finish(id, Json.error(ERR_CLOSED));
        }
    }

    // ------------------------------------------------------------------ indo para a página

    /** Responde um callAsync. Só a primeira resposta de cada id passa (ex.: resultado x tempo esgotado). */
    private void finish(int id, JSONObject result) {
        if (!pending.remove(id)) return;
        sink.eval(Js.resolve(id, String.valueOf(result)));
    }

    @Override
    public void emit(String event, JSONObject data) {
        if (destroyed) return;
        sink.eval(Js.emit(event, String.valueOf(data)));
    }

    /** Emite 'status'. Sem `force`, só quando algo mudou desde o último envio. Thread da interface. */
    void emitStatus(boolean force) {
        if (destroyed) return;
        JSONObject now = status.read();
        String text = now.toString();
        if (!force && text.equals(lastStatus)) return;
        lastStatus = text;
        emit("status", now);
    }

    // ------------------------------------------------------------------ vindo da Activity

    /** Endereço da página principal do WebView: a ponte só atende a própria interface do app. */
    void setPageUrl(String url) {
        trustedPage = WebClient.isAppUrl(url);
    }

    /**
     * Uma página nova vai nascer (primeira carga ou recarga). Tudo o que a anterior deixou em
     * andamento é encerrado, e as respostas que ela esperava são descartadas: os ids recomeçam do 1
     * na página nova e uma resposta atrasada cairia na chamada errada. Pode vir de qualquer thread.
     */
    void onNewPage() {
        if (destroyed) return;
        pending.clear();
        pinger.cancel();
        lan.cancel();
        speed.cancel();
        rssi.unwatch();
        Sys.runOnMain(main, () -> {
            rtt.cancelAll();
            permissions.dropWaiters();
            Window window = activity.getWindow();
            if (window != null) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    void onStart() {
        if (destroyed) return;
        scanner.start();
        statusWatcher.start();
        connection.start();
    }

    void onResume() {
        if (destroyed) return;
        rssi.setResumed(true);
        emitStatus(true); // o usuário pode ter voltado das configurações com algo diferente
        connection.refresh(); // ex.: Localização religada -> o nome da rede volta a aparecer
    }

    void onPause() {
        rssi.setResumed(false);
    }

    void onStop() {
        scanner.stop();
        statusWatcher.stop();
        connection.stop();
    }

    void onPermissionsResult(int requestCode, String[] names, int[] results) {
        if (destroyed) return;
        if (!permissions.onResult(requestCode, names, results)) return;
        emitStatus(true);
        if (permissions.hasFineLocation()) connection.restart(); // agora o Android entrega nome e BSSID
    }

    /** Encerra tudo: ninguém fica esperando resposta, nenhuma thread ou registro sobrevive à Activity. */
    void onDestroy() {
        if (destroyed) return;
        pinger.cancel();
        lan.cancel();
        speed.cancel();
        permissions.flush();  // quem pediu permissão recebe o Status atual
        rtt.cancelAll();      // medições pendentes saem com ok:false
        for (Integer id : new ArrayList<>(pending)) finish(id, Json.error(ERR_CLOSED));
        destroyed = true;
        rssi.unwatch();
        onStop();
        io.shutdownNow();
        timer.shutdownNow();
        if (ownedScanWorker != null) ownedScanWorker.shutdownNow();
        main.removeCallbacksAndMessages(null);
    }

    boolean isDestroyed() {
        return destroyed;
    }

    int pendingCalls() {
        return pending.size();
    }

    private static String describe(Throwable t) {
        String message = t.getMessage();
        return t.getClass().getSimpleName() + (message == null || message.isEmpty() ? "" : ": " + message);
    }
}
