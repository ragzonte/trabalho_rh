package com.wifiraiox.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.ValueCallback;

/**
 * O "Escolher arquivo" da página ({@code <input type="file">}, usado para importar um mapa
 * exportado): sem isto o WebView responde "nenhum arquivo" e o toque no botão não faz nada.
 *
 * Abre o seletor de documentos do Android e devolve à página o arquivo escolhido. Regras:
 *  - a página recebe a resposta exatamente uma vez, sempre (arquivo, ou null quando o usuário
 *    desiste, o aparelho não tem seletor, a tela fecha ou a página é refeita): um pedido sem
 *    resposta deixaria o campo de arquivo travado;
 *  - só endereços content:// voltam para a página: um file:// daria a quem respondesse ao pedido
 *    um caminho para os arquivos internos do próprio app;
 *  - qualquer tipo de arquivo pode ser escolhido: mapas recebidos por mensagem ou pela nuvem
 *    costumam chegar como "application/octet-stream" e ficariam apagados num filtro de JSON.
 *    Quem confere o conteúdo e o tamanho é a página;
 *  - nenhuma permissão é guardada: a leitura vale só para esta escolha.
 *
 * Só na thread da interface.
 */
final class FilePicker {

    private static final String TAG = "WifiRaioX";
    /** Código do pedido em startActivityForResult ("WF"). */
    static final int REQUEST_CODE = 0x5746;

    private ValueCallback<Uri[]> pending;

    /**
     * A página pediu um arquivo. Devolve true: quem responde é este objeto (pelo callback).
     * Um pedido anterior ainda sem resposta é encerrado com "nenhum arquivo".
     */
    boolean show(Activity activity, ValueCallback<Uri[]> callback) {
        cancel();
        if (callback == null) return false;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        pending = callback;
        try {
            activity.startActivityForResult(intent, REQUEST_CODE);
        } catch (RuntimeException e) {
            // ActivityNotFoundException: aparelho sem seletor de documentos. A página segue com "nenhum arquivo".
            Log.w(TAG, "seletor de arquivos indisponível", e);
            cancel();
        }
        return true;
    }

    /** Resposta do seletor. Devolve true se o resultado era deste pedido. */
    boolean onResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_CODE) return false;
        ValueCallback<Uri[]> callback = pending;
        pending = null;
        if (callback != null) deliver(callback, resultCode == Activity.RESULT_OK ? picked(data) : null);
        return true;
    }

    /** A tela está fechando ou a página foi descartada: o pedido pendente termina sem arquivo. */
    void cancel() {
        ValueCallback<Uri[]> callback = pending;
        pending = null;
        if (callback != null) deliver(callback, null);
    }

    boolean isPending() {
        return pending != null;
    }

    private static Uri[] picked(Intent data) {
        Uri uri = data == null ? null : data.getData();
        if (uri == null || !"content".equals(uri.getScheme())) return null;
        return new Uri[] {uri};
    }

    private static void deliver(ValueCallback<Uri[]> callback, Uri[] value) {
        try {
            callback.onReceiveValue(value);
        } catch (RuntimeException e) {
            Log.w(TAG, "a página já não aceita a resposta do seletor de arquivos", e);
        }
    }
}
