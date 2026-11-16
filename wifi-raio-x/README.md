# 📶 WiFi Raio-X

App Android para **analisar o Wi-Fi** ao seu redor e, de quebra, **desenhar um mapa 3D do
lugar usando só o sinal do Wi-Fi**.

- **Redes** — tudo o que o celular enxerga: sinal, canal, largura, segurança, geração do
  Wi-Fi, fabricante, quantos aparelhos estão em cada roteador (quando ele informa) e mais.
- **Melhor canal** — gráfico de canais de 2,4 / 5 / 6 GHz e a recomendação, em português
  claro, de qual canal o seu roteador deveria usar.
- **Melhor Wi-Fi** — qual rede deve render mais *aqui e agora* (velocidade estimada, sinal,
  congestionamento e segurança) e um diagnóstico automático do que pode melhorar.
- **Mapa 3D (o extra)** — você anda pela casa com o celular, marca os cômodos e o app
  monta um mapa 3D aproximado: a área, os ambientes, o calor do sinal em cada lugar e onde
  o roteador provavelmente está. **Só com o Wi-Fi**: sem GPS, sem câmera, sem sensores de
  movimento.
- **Ferramentas** — medidor de sinal e "caça-roteador", sinal ao longo do tempo, teste de
  velocidade, latência (ping), aparelhos conectados à rede, detalhes da conexão, exportar.
- **Modo demonstração** — uma casa virtual com vizinhos, para conhecer o app (e o mapa 3D)
  sem sair do sofá.

Nada do que o app analisa sai do celular: ele não tem servidor, cadastro nem anúncios. A internet
só é usada quando você pede: no teste de velocidade (servidores da Cloudflare) e no teste de
latência até a internet (o destino que você escolher: Cloudflare 1.1.1.1, Google 8.8.8.8 ou um site).

---

## Instalar

Baixe o **wifi-raio-x.apk** no celular e toque para instalar (o Android pede para permitir
"instalar apps desta fonte"). Funciona no Android 7 ou mais novo.

Na primeira vez o app pede a permissão de **Localização (precisa)**. É uma exigência do
Android: sem ela, nenhum app consegue listar as redes Wi-Fi. O WiFi Raio-X não usa o GPS e
não guarda nem envia a sua localização.

> **Dica:** o Android limita os apps a 4 varreduras de Wi-Fi a cada 2 minutos. Para o mapa
> 3D ficar bem melhor (e a lista atualizar mais rápido), desligue esse limite em
> *Configurações → Opções do desenvolvedor → Limitar busca por Wi-Fi*. O próprio app
> explica como.

## O que esperar do mapa 3D (com honestidade)

Só o sinal do Wi-Fi permite dizer **em que cômodo** você estava e mais ou menos onde dentro
dele. Os números abaixo são de **casas simuladas**: 184 levantamentos, dos quais 96 em
plantas, vizinhanças e caminhadas que não serviram para ajustar nada no app (os dois grupos
dão quase o mesmo). Num celular de verdade o mapa ainda não foi medido, e o mundo real é mais
bagunçado que o simulador.

| Lugar (simulado)                 | Erro típico de posição | Leituras no cômodo certo | Tamanho do desenho / real | Área desenhada / real |
| -------------------------------- | ---------------------- | ------------------------ | ------------------------- | --------------------- |
| Kitnet, 30 m²                    | 0,9 m                  | 96%                      | 0,89                      | 1,33                  |
| Casa térrea pequena, 30 a 45 m²  | 1,0 m                  | 89%                      | 1,01                      | 1,35                  |
| Apartamento, 63 m²               | 1,2 m                  | 78%                      | 0,92                      | 1,03                  |
| Casa térrea média, 55 a 80 m²    | 1,3 m                  | 81%                      | 0,92                      | 1,02                  |
| Casa térrea grande, 90 a 140 m²  | 1,4 m                  | 86%                      | 0,91                      | 0,92                  |
| Sobrado, 2 andares de 80 m²      | 1,6 m                  | 64%                      | 0,89                      | 0,88                  |
| Escritório, 280 m²               | 2,4 m                  | 77%                      | 0,73                      | 0,56                  |

- **Posição**: o "erro típico" é o mediano, depois do melhor encaixe do desenho na planta; 9 em
  cada 10 posições erram menos que o dobro dele. Andando com as varreduras livres o erro fica
  em 1,2 a 1,5 m; com o limite do Android (uma varredura a cada 30 s), em 1,6 m.
- **Tamanho**: as distâncias em metros são a parte mais fraca. Saem em média 11% menores que
  as reais (com o app inteiro conduzido no simulador, de 12 a 38% menores, conforme o lugar)
  e, num mapa só, podem errar 25% ou mais (o pior caso visto na bancada: 40%). Informar uma
  distância medida ("Ajustar a escala") só faz o mapa crescer, e só quando a distância não
  cabe nele de ponta a ponta: com os dois lugares marcados mais distantes de verdade o erro
  médio de tamanho cai de 17% para 6%; com o par que o app propõe (o mais distante no mapa),
  para 13%; com uma distância curta nada muda, e um mapa que saiu grande não é corrigido.
- **Área**: o app alarga a área desenhada para compensar o encolhimento. Na média dá certo
  (1,01), mas não mapa a mapa: de cada dez, um sai com menos de 0,6 e um com mais de 1,5 da
  área real. Casa pequena costuma sair uns 30% maior; lugar grande, pela metade.
- **Ambientes**: o mapa só é dividido em ambientes com os **nomes que você der** (pelo menos
  dois lugares com nomes diferentes no andar). Sem nomes, as divisões tiradas só do sinal
  ficam perto de um corte ao acaso, e o app não as desenha. Cada nome vale perto de onde foi
  dado: com todos os cômodos marcados, cerca de 3/4 da área de cada ambiente é mesmo do
  cômodo daquele nome (cerca de 65% com só metade dos cômodos marcados); a parte da casa sem
  nome por perto aparece como "Ambiente", sem divisões.
- **Sinal**: os valores são medidos; o lugar onde cada um cai no desenho é estimado. O mapa
  de sinal erra cerca de 5 dB (3 dB se as posições fossem perfeitas).
- **Roteador**: a posição do roteador da casa erra 1,7 m, em média.
- A orientação (onde é o "norte") e o espelhamento são arbitrários.

Por isso o mapa mostra uma **área aproximada** por onde você andou, os **ambientes** com os
nomes que você deu, o **sinal medido** nos lugares estimados e a **posição provável** dos
roteadores. Não é uma planta com paredes exatas — isso o Wi-Fi sozinho não consegue entregar
— e o app não finge que é. Para um mapa melhor: ande devagar por todos os cômodos, pare e
marque cada um com o nome, e desligue o limite de varreduras.

---

## Como é feito

```
 Android (Java)                      Interface (HTML + JS, dentro do APK)
 ┌──────────────────────┐  JSON cru  ┌─────────────────────────────────────────────┐
 │ WifiManager, RTT,    │ ─────────► │ js/core     análise: canais, segurança,      │
 │ ping, rede local,    │            │             elementos de informação, notas   │
 │ teste de velocidade  │ ◄───────── │ js/mapping  mapa só com Wi-Fi (solucionador) │
 └──────────────────────┘   pedidos  │ js/ui       telas e gráficos                 │
        "ponte burra"                │ js/sim      casa virtual (demonstração)      │
                                     └─────────────────────────────────────────────┘
```

- O lado Android só entrega os dados crus; toda a interpretação é JavaScript puro, que roda
  igual no celular, no navegador e nos testes.
- O contrato entre os dois lados está no cabeçalho de [`app/js/bridge.js`](app/js/bridge.js).
- No navegador, quem responde é o simulador (`app/js/sim`): uma casa virtual com paredes,
  roteadores e vizinhos, com propagação de rádio simulada. É o "modo demonstração" e também
  o ambiente dos testes.

### O mapa só com Wi-Fi

1. **Levantamento**: enquanto você anda, o app grava as varreduras (o nível de cada rede em
   cada instante), os lugares que você marcou e o andar.
2. **Solucionador** (`app/js/mapping/solver.js`): descobre onde cada varredura foi feita e
   onde estão os roteadores, só a partir do sinal — usando que o sinal cai com a distância,
   que você não atravessa a casa em um segundo e que o "retrato" do Wi-Fi se repete quando
   você volta ao mesmo lugar. Saiu de um torneio entre quatro abordagens, julgadas em casas
   simuladas inéditas.
3. **Modelo do mapa** (`app/js/mapping/mapmodel.js`): área, ambientes, calor do sinal,
   cobertura e zonas de sombra.
4. **Visualizador** (`app/js/ui/map/viewer3d.js`): WebGL (three.js), com alternativa 2D.

A bancada que mede a qualidade disso tudo fica em `tests/mapping/` (veja
`node tests/mapping/harness.mjs --help`).

## Desenvolvimento

Sem etapa de build na interface: são arquivos estáticos.

```bash
cd wifi-raio-x
npm start                    # http://localhost:8090  (abre no modo demonstração)
npm test                     # testes de unidade (Node 22+)
npm run test:e2e             # testes ponta a ponta no Chromium (precisa do Playwright)
```

Parâmetros úteis no navegador: `?world=apartamento|sobrado|escritorio|kitnet`, `&speed=10`
(o tempo da casa virtual corre mais rápido), `&throttle=1` (simula o limite de varreduras do
Android), `&permission=denied`, `&theme=light`.

### App Android

```bash
cd wifi-raio-x/android
./gradlew assembleRelease        # precisa do Android SDK (compileSdk 35)
./gradlew testDebugUnitTest      # testes Robolectric do lado nativo, em vários níveis de API
./gradlew lintDebug
```

O workflow **WiFi Raio-X** do GitHub Actions roda os testes, compila o APK e, na branch
principal, publica em *Releases*. A assinatura segue o mesmo esquema do outro app deste
repositório: sem as secrets `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` o APK sai
com uma chave temporária (para atualizar é preciso desinstalar a versão anterior).

### Estrutura

```
app/                 a interface (vai inteira para dentro do APK)
  js/bridge.js       contrato com o Android
  js/core/           análise de Wi-Fi (pura, testada)
  js/mapping/        gravação, solucionador, modelo do mapa
  js/sim/            casa virtual e simulador do Android
  js/ui/             telas, gráficos, visualizador 3D
  assets/oui.json    fabricantes por prefixo de MAC (registro público do IEEE)
  vendor/            three.js (MIT)
android/             projeto Gradle (Java puro, uma Activity com WebView)
tests/               unidade (*.test.mjs), ponta a ponta (e2e/), bancada do mapa (mapping/)
tools/               servidor de desenvolvimento e geradores (ícones, OUI, three.js)
```

## Limitações conhecidas

- O Android não deixa apps comuns trocar o canal do roteador nem conectar em redes por você:
  o app recomenda, quem muda é você.
- Android 11 ou mais novo esconde o endereço MAC dos aparelhos da rede local: na lista de
  dispositivos, alguns aparecem só com o IP.
- Velocidades e distâncias são **estimativas** calculadas a partir do sinal.
- Medição de distância real por Wi-Fi (RTT) só funciona quando o celular e o roteador
  suportam 802.11mc.
