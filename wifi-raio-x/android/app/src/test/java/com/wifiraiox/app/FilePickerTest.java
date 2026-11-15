package com.wifiraiox.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import org.junit.Test;
import org.robolectric.Robolectric;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.shadows.ShadowActivity;

/**
 * "Escolher arquivo" da página (importar um mapa): o WebView precisa que o app abra o seletor de
 * documentos e devolva a resposta exatamente uma vez, sempre.
 */
public class FilePickerTest extends AllSdks {

    private static final Uri DOCUMENT = Uri.parse("content://com.android.providers.downloads.documents/document/42");

    private ActivityController<MainActivity> controller;

    private MainActivity launch() {
        controller = Robolectric.buildActivity(MainActivity.class).setup();
        return controller.get();
    }

    /** O que a página recebeu de volta. */
    private static final class Answer implements ValueCallback<Uri[]> {
        int calls;
        Uri[] value;

        @Override
        public void onReceiveValue(Uri[] picked) {
            calls++;
            value = picked;
        }
    }

    private static WebChromeClient chrome(MainActivity activity) {
        WebChromeClient client = shadowOf(activity.webView()).getWebChromeClient();
        assertNotNull(client);
        return client;
    }

    private static Answer ask(MainActivity activity) {
        Answer answer = new Answer();
        assertTrue("o app assume o pedido de arquivo", chrome(activity).onShowFileChooser(activity.webView(), answer, null));
        return answer;
    }

    @Test
    public void opensTheSystemDocumentPickerForAnyFileType() {
        MainActivity activity = launch();
        Answer answer = ask(activity);

        ShadowActivity.IntentForResult started = shadowOf(activity).getNextStartedActivityForResult();
        assertNotNull("abre o seletor de documentos", started);
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, started.intent.getAction());
        assertTrue(started.intent.hasCategory(Intent.CATEGORY_OPENABLE));
        // mapas recebidos por mensagem chegam como application/octet-stream: nada de filtro de JSON
        assertEquals("*/*", started.intent.getType());
        assertEquals(FilePicker.REQUEST_CODE, started.requestCode);
        // nenhuma permissão duradoura é pedida
        assertEquals(0, started.intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        assertEquals("a resposta só vem depois da escolha", 0, answer.calls);
        assertTrue(activity.filePicker().isPending());
    }

    @Test
    public void thePickedDocumentGoesBackToThePageExactlyOnce() {
        MainActivity activity = launch();
        Answer answer = ask(activity);

        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        assertEquals(1, answer.calls);
        assertArrayEquals(new Uri[] {DOCUMENT}, answer.value);
        assertFalse(activity.filePicker().isPending());

        // um resultado repetido (ou atrasado) não chega duas vezes à página
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        controller.destroy();
        assertEquals(1, answer.calls);
    }

    @Test
    public void givingUpAnswersNoFile() {
        MainActivity activity = launch();
        Answer cancelled = ask(activity);
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_CANCELED, null);
        assertEquals(1, cancelled.calls);
        assertNull(cancelled.value);

        // "OK" sem arquivo nenhum também é "nenhum arquivo"
        Answer empty = ask(activity);
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent());
        assertEquals(1, empty.calls);
        assertNull(empty.value);
    }

    @Test
    public void onlyContentUrisReachThePage() {
        MainActivity activity = launch();
        // quem respondesse ao pedido com um caminho de arquivo apontaria para os dados internos do app
        String[] refused = {
            "file:///data/data/com.wifiraiox.app/shared_prefs/x.xml",
            "file:///sdcard/mapa.json",
            "https://exemplo.com/mapa.json",
            "javascript:alert(1)",
            "/data/local/tmp/mapa.json",
        };
        for (String uri : refused) {
            Answer answer = ask(activity);
            activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(Uri.parse(uri)));
            assertEquals(uri, 1, answer.calls);
            assertNull(uri, answer.value);
        }
    }

    @Test
    public void resultsOfOtherRequestsAreIgnored() {
        MainActivity activity = launch();
        Answer answer = ask(activity);
        activity.onActivityResult(FilePicker.REQUEST_CODE + 1, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        assertEquals(0, answer.calls);
        assertTrue(activity.filePicker().isPending());
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        assertEquals(1, answer.calls);
    }

    @Test
    public void aSecondRequestClosesTheFirstWithNoFile() {
        MainActivity activity = launch();
        Answer first = ask(activity);
        Answer second = ask(activity);
        assertEquals(1, first.calls);
        assertNull(first.value);
        assertEquals(0, second.calls);
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        assertEquals(1, first.calls);
        assertEquals(1, second.calls);
        assertArrayEquals(new Uri[] {DOCUMENT}, second.value);
    }

    @Test
    public void closingTheScreenAnswersThePendingRequest() {
        MainActivity activity = launch();
        Answer answer = ask(activity);
        controller.pause().stop().destroy();
        assertEquals("o campo de arquivo da página não fica travado", 1, answer.calls);
        assertNull(answer.value);
        assertFalse(activity.filePicker().isPending());
    }

    @Test
    public void aLostRendererAnswersThePendingRequestAndTheNewPageCanAskAgain() {
        MainActivity activity = launch();
        WebView before = activity.webView();
        Answer answer = ask(activity);
        activity.onRendererGone(before);
        assertEquals(1, answer.calls);
        assertNull(answer.value);

        // a escolha feita para a página que morreu não vai para a página nova
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        assertEquals(1, answer.calls);

        shadowOf(android.os.Looper.getMainLooper()).idle();
        WebView rebuilt = activity.webView();
        assertNotNull(rebuilt);
        // um pedido vindo do WebView descartado é recusado sem abrir nada
        while (shadowOf(activity).getNextStartedActivityForResult() != null) {
            // esvazia os pedidos anteriores
        }
        Answer stale = new Answer();
        assertTrue(shadowOf(before).getWebChromeClient().onShowFileChooser(before, stale, null));
        assertEquals(1, stale.calls);
        assertNull(stale.value);
        assertNull(shadowOf(activity).getNextStartedActivityForResult());
        // e a página nova pede normalmente
        Answer again = ask(activity);
        assertNotNull(shadowOf(activity).getNextStartedActivityForResult());
        activity.onActivityResult(FilePicker.REQUEST_CODE, Activity.RESULT_OK, new Intent().setData(DOCUMENT));
        assertArrayEquals(new Uri[] {DOCUMENT}, again.value);
    }

    @Test
    public void aPhoneWithoutDocumentPickerAnswersNoFile() {
        MainActivity activity = launch();
        // nenhum app responde ao pedido: startActivityForResult lança ActivityNotFoundException
        shadowOf(Fixtures.app()).checkActivities(true);
        Answer answer = ask(activity);
        assertEquals(1, answer.calls);
        assertNull(answer.value);
        assertFalse(activity.filePicker().isPending());
    }
}
