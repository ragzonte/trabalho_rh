package com.wifiraiox.app;

/** Executa JavaScript na página; pode ser chamado de qualquer thread e descarta em silêncio se a página já se foi. */
interface JsSink {
    void eval(String script);
}
