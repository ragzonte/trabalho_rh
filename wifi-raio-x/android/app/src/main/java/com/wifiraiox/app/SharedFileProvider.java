package com.wifiraiox.app;

import androidx.core.content.FileProvider;

/**
 * Entrega os arquivos exportados (cache/shared) para outros apps com permissão temporária de
 * leitura. É uma subclasse própria porque declarar o FileProvider do androidx direto no manifesto
 * entra em conflito com bibliotecas que fazem o mesmo.
 */
public final class SharedFileProvider extends FileProvider {
    public SharedFileProvider() {
        super(R.xml.file_paths);
    }
}
