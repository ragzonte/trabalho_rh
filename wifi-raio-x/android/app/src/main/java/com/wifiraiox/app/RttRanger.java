package com.wifiraiox.app;

import android.content.Context;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Medição de distância por Wi-Fi RTT. Só funciona com Android 9+, rádio compatível e roteadores
 * que anunciam 802.11mc; em qualquer outro caso responde {results: []} ou marca o roteador com
 * ok:false. Usar na thread da interface.
 */
final class RttRanger {

    interface Callback {
        void onDone(JSONObject result);
    }

    /** O Android costuma responder em 1 a 2 s; depois disto desistimos para não deixar a página esperando. */
    static final long TIMEOUT_MS = 8000;
    /** Tempo para o usuário responder ao diálogo de permissão (Android 13+) antes de a medição começar. */
    static final long DIALOG_TIMEOUT_MS = 120_000;
    private static final int MAX_REQUESTED = 64;

    private final Context context;
    private final Handler main;
    private final Permissions permissions;
    private final List<Session> sessions = new ArrayList<>();

    RttRanger(Context context, Handler main, Permissions permissions) {
        this.context = context.getApplicationContext();
        this.main = main;
        this.permissions = permissions;
    }

    void range(List<String> requested, final Callback callback) {
        final Set<String> wanted = new LinkedHashSet<>();
        if (requested != null) {
            for (String b : requested) {
                if (b == null || wanted.size() >= MAX_REQUESTED) continue;
                String bssid = b.trim().toLowerCase(Locale.ROOT);
                if (isBssid(bssid)) wanted.add(bssid); // o que não é um MAC não tem como ser medido (nem volta na resposta)
            }
        }
        if (Build.VERSION.SDK_INT < 28 || !DeviceInfoReader.rttSupported(context) || wanted.isEmpty()) {
            callback.onDone(Json.put(new JSONObject(), "results", new JSONArray()));
            return;
        }
        final Session session = new Session(wanted, callback);
        final List<ScanResult> targets = targets(wanted);
        if (targets.isEmpty()) {
            session.finish(null); // nenhum dos pedidos está na última varredura como 802.11mc
            return;
        }
        sessions.add(session);
        main.postDelayed(session.timeout, DIALOG_TIMEOUT_MS);
        // Android 13+: "Dispositivos por perto" é pedida uma única vez; seguimos com qualquer resposta.
        permissions.requestNearbyOnce(() -> {
            if (session.done) return;
            // Só agora corre o prazo curto: o tempo que a pessoa levou lendo o diálogo não conta.
            main.removeCallbacks(session.timeout);
            main.postDelayed(session.timeout, TIMEOUT_MS);
            try {
                if (Build.VERSION.SDK_INT < 28 || !Api28.range(context, targets, session::finish)) session.finish(null);
            } catch (RuntimeException e) {
                session.finish(null); // SecurityException sem localização, serviço indisponível...
            }
        });
    }

    /** "aa:bb:cc:dd:ee:ff", já em minúsculas. */
    static boolean isBssid(String s) {
        if (s == null || s.length() != 17) return false;
        for (int i = 0; i < 17; i++) {
            char c = s.charAt(i);
            if (i % 3 == 2 ? c != ':' : !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    /** A Activity está morrendo: responde o que estiver pendente. */
    void cancelAll() {
        for (Session s : new ArrayList<>(sessions)) s.finish(null);
    }

    /** Os pedidos que aparecem na última varredura e anunciam 802.11mc, até o máximo que o Android aceita de uma vez. */
    private List<ScanResult> targets(Set<String> wanted) {
        List<ScanResult> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT < 28) return out;
        try {
            WifiManager wifi = Sys.wifi(context);
            List<ScanResult> scan = wifi == null ? null : wifi.getScanResults();
            if (scan == null) return out;
            int max = Api28.maxPeers();
            Set<String> seen = new LinkedHashSet<>();
            for (ScanResult r : scan) {
                if (out.size() >= max) break;
                if (r == null || r.BSSID == null || !r.is80211mcResponder()) continue;
                String bssid = r.BSSID.toLowerCase(Locale.ROOT);
                if (wanted.contains(bssid) && seen.add(bssid)) out.add(r);
            }
        } catch (SecurityException ignored) {
            // sem permissão não há varredura; ninguém é medido
        } catch (RuntimeException ignored) {
            // serviço de Wi-Fi indisponível
        }
        return out;
    }

    private final class Session {
        final Set<String> wanted;
        final Callback callback;
        boolean done;
        final Runnable timeout = () -> finish(null);

        Session(Set<String> wanted, Callback callback) {
            this.wanted = wanted;
            this.callback = callback;
        }

        /** Uma resposta por BSSID pedido, na ordem do pedido; quem não foi medido sai com ok:false. */
        void finish(Map<String, JSONObject> measured) {
            if (done) return;
            done = true;
            main.removeCallbacks(timeout);
            sessions.remove(this);
            Map<String, JSONObject> got = measured == null ? new HashMap<>() : measured;
            JSONArray results = new JSONArray();
            for (String bssid : wanted) {
                JSONObject r = got.get(bssid);
                if (r == null) {
                    r = new JSONObject();
                    Json.put(r, "bssid", bssid);
                    Json.put(r, "ok", false);
                }
                results.put(r);
            }
            callback.onDone(Json.put(new JSONObject(), "results", results));
        }
    }
}
