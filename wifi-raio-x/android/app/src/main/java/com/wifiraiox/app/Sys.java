package com.wifiraiox.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;

import androidx.core.location.LocationManagerCompat;

import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Acesso aos serviços do sistema e utilidades de thread usadas por todo o lado nativo. */
final class Sys {

    private Sys() {}

    /** Sempre pelo contexto da aplicação: o WifiManager preso a uma Activity vaza memória em Androids antigos. */
    static WifiManager wifi(Context context) {
        return (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    }

    static ConnectivityManager connectivity(Context context) {
        return (ConnectivityManager) context.getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    static boolean locationEnabled(Context context) {
        try {
            LocationManager lm = (LocationManager) context.getApplicationContext().getSystemService(Context.LOCATION_SERVICE);
            return lm != null && LocationManagerCompat.isLocationEnabled(lm);
        } catch (RuntimeException e) {
            return false;
        }
    }

    static boolean granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean onMain() {
        return Looper.myLooper() == Looper.getMainLooper();
    }

    /** Roda na thread da interface: na hora se já estamos nela, senão enfileira. */
    static void runOnMain(Handler main, Runnable task) {
        if (onMain()) task.run();
        else main.post(task);
    }

    /**
     * Roda na thread da interface e espera a resposta por um tempo curto. A ponte usa isto quando o
     * resultado (ex.: "a tela de configurações abriu?") precisa voltar na mesma chamada.
     */
    static <T> T callOnMain(Handler main, Callable<T> task, long timeoutMs, T fallback) {
        try {
            if (onMain()) return task.call();
            FutureTask<T> future = new FutureTask<>(task);
            if (!main.post(future)) return fallback;
            return future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    /** Threads de trabalho com nome (ajuda a ler um ANR/trace) que não seguram o processo aberto. */
    static ThreadFactory threads(final String name) {
        final AtomicInteger n = new AtomicInteger();
        return r -> {
            Thread t = new Thread(r, "wrx-" + name + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }
}
