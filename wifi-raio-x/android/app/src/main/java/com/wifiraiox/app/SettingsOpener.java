package com.wifiraiox.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.util.ArrayList;
import java.util.List;

/**
 * Abre telas de configuração do Android. Nenhuma delas é garantida em todo aparelho (fabricantes
 * removem telas), então cada pedido tem uma lista de alternativas e nunca lança.
 */
final class SettingsOpener {

    static final String WIFI = "wifi";
    static final String LOCATION = "location";
    static final String APP = "app";
    static final String DEVELOPER = "developer";
    static final String PANEL = "panel";

    private SettingsOpener() {}

    static boolean known(String which) {
        return WIFI.equals(which) || LOCATION.equals(which) || APP.equals(which)
                || DEVELOPER.equals(which) || PANEL.equals(which);
    }

    /** As telas a tentar, em ordem de preferência. */
    static List<Intent> candidates(Activity activity, String which) {
        List<Intent> out = new ArrayList<>();
        if (which == null) return out;
        switch (which) {
            case PANEL:
                // Painel que abre por cima do app (Android 10+); nos mais antigos, a tela de Wi-Fi.
                if (Build.VERSION.SDK_INT >= 29) out.add(Api29.wifiPanel());
                out.add(new Intent(Settings.ACTION_WIFI_SETTINGS));
                break;
            case WIFI:
                out.add(new Intent(Settings.ACTION_WIFI_SETTINGS));
                out.add(new Intent(Settings.ACTION_WIRELESS_SETTINGS));
                break;
            case LOCATION:
                out.add(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                break;
            case APP:
                out.add(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", activity.getPackageName(), null)));
                out.add(new Intent(Settings.ACTION_MANAGE_APPLICATIONS_SETTINGS));
                break;
            case DEVELOPER:
                out.add(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
                break;
            default:
                return out;
        }
        out.add(new Intent(Settings.ACTION_SETTINGS)); // último recurso: a tela geral
        return out;
    }

    /** Abre a primeira tela que existir. Thread da interface. */
    static boolean open(Activity activity, String which) {
        for (Intent intent : candidates(activity, which)) {
            try {
                activity.startActivity(intent);
                return true;
            } catch (RuntimeException e) {
                // ActivityNotFoundException (tela inexistente) ou SecurityException (tela protegida): tenta a próxima
            }
        }
        return false;
    }
}
