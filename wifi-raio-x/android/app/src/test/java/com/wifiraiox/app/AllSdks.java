package com.wifiraiox.app;

import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Base dos testes que dependem da versão do Android: cada teste roda uma vez por nível de API,
 * contra as classes de verdade daquela versão. Chamar um método que não existe num nível falha
 * aqui exatamente como falharia no celular.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = {24, 26, 28, 29, 30, 31, 33, 34})
public abstract class AllSdks {
}
