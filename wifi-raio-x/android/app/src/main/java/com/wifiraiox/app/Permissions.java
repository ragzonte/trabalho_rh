package com.wifiraiox.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import java.util.ArrayList;
import java.util.List;

/**
 * Permissões em tempo de execução: Localização (sem a precisa o Android devolve varreduras vazias)
 * e, do Android 13 em diante, "Dispositivos por perto" (medição de distância por Wi-Fi RTT).
 *
 * O Android não diz "o usuário bloqueou de vez". O que dá para observar é: o pedido volta negado
 * e shouldShowRequestPermissionRationale() devolve false. Só que isso também acontece antes do
 * primeiro pedido e quando o diálogo é fechado sem escolha (Android 11+). Por isso guardamos o que
 * aconteceu nos pedidos anteriores.
 *
 * Todos os métodos rodam na thread da interface, exceto locationState(), que pode vir de qualquer
 * thread: só lê (e, no máximo, apaga nas preferências um bloqueio que deixou de valer).
 */
final class Permissions {

    static final int REQUEST_LOCATION = 4101;
    static final int REQUEST_NEARBY = 4102;

    static final String FINE = Manifest.permission.ACCESS_FINE_LOCATION;
    static final String COARSE = Manifest.permission.ACCESS_COARSE_LOCATION;
    /** Manifest.permission.NEARBY_WIFI_DEVICES só existe como constante no SDK 33. */
    static final String NEARBY = "android.permission.NEARBY_WIFI_DEVICES";

    static final String GRANTED = "granted";
    static final String DENIED = "denied";
    static final String BLOCKED = "blocked";

    /** Uma negativa mais rápida que isto não passou por um diálogo: foi o próprio Android recusando. */
    static final long INSTANT_DENIAL_MS = 700;
    /** Tempo de sobra para o diálogo do Android tomar o foco da nossa janela. */
    static final long LOST_REQUEST_MS = 3000;

    private static final String PREFS = "wrx_permissions";
    private static final String KEY_ASKED = "location_asked";
    private static final String KEY_BLOCKED = "location_blocked";
    private static final String KEY_SILENT = "location_silent_denials";
    private static final String KEY_NEARBY_ASKED = "nearby_asked";

    private final Activity activity;
    private final SharedPreferences prefs;
    private final List<Runnable> locationWaiters = new ArrayList<>();
    private Runnable nearbyWaiter;
    private boolean locationInFlight;
    private boolean nearbyInFlight;
    private boolean rationaleBefore;
    private long requestedAt;

    Permissions(Activity activity) {
        this.activity = activity;
        this.prefs = activity.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    boolean hasFineLocation() {
        return Sys.granted(activity, FINE);
    }

    /** 'granted' | 'denied' | 'blocked'. Só a localização precisa conta: a aproximada não libera a varredura. */
    String locationState() {
        if (hasFineLocation()) {
            // Liberada (talvez pelas configurações): um bloqueio anotado antes já não vale. Se ficasse,
            // uma revogação futura apareceria como "bloqueada" mesmo com o Android disposto a perguntar.
            if (prefs.getBoolean(KEY_BLOCKED, false)) setBlocked(false);
            return GRANTED;
        }
        if (prefs.getBoolean(KEY_BLOCKED, false) && !showRationale()) return BLOCKED;
        return DENIED;
    }

    /** Já pedimos a localização alguma vez neste aparelho? */
    boolean alreadyAsked() {
        return prefs.getBoolean(KEY_ASKED, false);
    }

    /** Pede FINE + COARSE juntas (o Android 12 ignora a precisa pedida sozinha). `done` sempre é chamado. */
    void requestLocation(Runnable done) {
        if (hasFineLocation()) {
            setBlocked(false);
            if (done != null) done.run();
            return;
        }
        if (done != null) locationWaiters.add(done);
        if (locationInFlight) {
            // O Android só mostra um pedido por vez: pega carona no que está aberto...
            if (!requestLooksLost()) return;
            // ...a menos que o diálogo tenha sumido sem resposta; aí pede de novo em vez de esperar para sempre.
            locationInFlight = false;
        }
        if (nearbyInFlight) {
            drainLocation();
            return;
        }
        locationInFlight = true;
        rationaleBefore = showRationale();
        requestedAt = SystemClock.elapsedRealtime();
        prefs.edit().putBoolean(KEY_ASKED, true).apply();
        try {
            activity.requestPermissions(new String[] {FINE, COARSE}, REQUEST_LOCATION);
        } catch (RuntimeException e) {
            locationInFlight = false;
            drainLocation();
        }
    }

    /**
     * Android 13+: pede "Dispositivos por perto" uma única vez. `done` é chamado com qualquer resposta
     * (o Android não exige essa permissão para medir até um roteador, então seguimos de qualquer jeito).
     */
    void requestNearbyOnce(Runnable done) {
        if (Build.VERSION.SDK_INT < 33 || Sys.granted(activity, NEARBY)
                || prefs.getBoolean(KEY_NEARBY_ASKED, false) || locationInFlight || nearbyInFlight) {
            done.run();
            return;
        }
        prefs.edit().putBoolean(KEY_NEARBY_ASKED, true).apply();
        nearbyInFlight = true;
        nearbyWaiter = done;
        try {
            activity.requestPermissions(new String[] {NEARBY}, REQUEST_NEARBY);
        } catch (RuntimeException e) {
            finishNearby();
        }
    }

    /** Chamado pela Activity. Devolve true quando o resultado era de um pedido nosso. */
    boolean onResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQUEST_NEARBY) {
            finishNearby();
            return true;
        }
        if (requestCode != REQUEST_LOCATION) return false;
        boolean ours = locationInFlight;
        locationInFlight = false;
        if (hasFineLocation()) {
            setBlocked(false);
        } else if (permissions != null && permissions.length > 0) { // vetor vazio = pedido interrompido, nada a concluir
            if (showRationale()) {
                setBlocked(false); // o Android ainda aceita mostrar o diálogo
            } else if (ours) {
                long took = SystemClock.elapsedRealtime() - requestedAt;
                if (rationaleBefore || took < INSTANT_DENIAL_MS) {
                    // já tinha negado antes e agora negou de novo, ou o Android nem mostrou o diálogo
                    setBlocked(true);
                } else {
                    // diálogo fechado sem escolher (ou aparelho lento): na segunda vez seguida, mandamos às configurações
                    int silent = prefs.getInt(KEY_SILENT, 0) + 1;
                    prefs.edit().putInt(KEY_SILENT, silent).apply();
                    if (silent >= 2) setBlocked(true);
                }
            }
        }
        drainLocation();
        return true;
    }

    /**
     * A página foi recarregada: quem esperava a resposta não existe mais. O diálogo do Android pode
     * continuar aberto; um pedido da página nova pega carona nele.
     */
    void dropWaiters() {
        locationWaiters.clear();
    }

    /** A Activity está morrendo: ninguém pode ficar esperando uma resposta que não virá. */
    void flush() {
        locationInFlight = false;
        drainLocation();
        finishNearby();
    }

    /**
     * Um pedido em aberto há algum tempo com a nossa janela em foco: não há diálogo por cima, então
     * a resposta dele se perdeu. (Se o palpite estiver errado o Android apenas recusa o pedido
     * repetido na hora, e a resposta do diálogo de verdade ainda chega depois.)
     */
    private boolean requestLooksLost() {
        try {
            return activity.hasWindowFocus() && SystemClock.elapsedRealtime() - requestedAt > LOST_REQUEST_MS;
        } catch (RuntimeException e) {
            return false;
        }
    }

    private boolean showRationale() {
        try {
            return activity.shouldShowRequestPermissionRationale(FINE);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private void setBlocked(boolean blocked) {
        SharedPreferences.Editor e = prefs.edit().putBoolean(KEY_BLOCKED, blocked);
        if (!blocked) e.putInt(KEY_SILENT, 0);
        e.apply();
    }

    private void drainLocation() {
        List<Runnable> copy = new ArrayList<>(locationWaiters);
        locationWaiters.clear();
        for (Runnable r : copy) r.run();
    }

    private void finishNearby() {
        nearbyInFlight = false;
        Runnable r = nearbyWaiter;
        nearbyWaiter = null;
        if (r != null) r.run();
    }
}
