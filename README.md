# 💑 Contas a Dois

App simples e leve para o casal controlar as despesas juntos. Cada um lança o que
ganha e o que gasta, e os dois veem tudo no mesmo lugar: saldo do mês, quanto cada
um ganhou e gastou, para onde foi o dinheiro e a evolução dos últimos meses.

- **Sem login e sem cadastro.** Cada um instala o app, cola o link da planilha do casal e escolhe “quem é você”.
- **Banco de dados = uma planilha do Google Sheets** de vocês. Dá para abrir e editar a planilha quando quiser.
- **App Android** que já traz tudo dentro dele: não precisa de site, servidor nem GitHub para funcionar.
- **Funciona sem internet:** o que você lança offline fica guardado e vai para a planilha quando a conexão volta.
- **Os dois ao mesmo tempo:** o script da planilha grava um de cada vez, então nada se perde.
- **Categorias editáveis** e **gráficos** (receitas x despesas em 6 meses, por categoria e por pessoa).

---

## Como funciona

```
 Celular da Ana ─┐                               ┌─ aba Lancamentos
                 ├─► link /exec ─► script ─► planilha ─┼─ aba Categorias
 Celular do Beto ┘   (Apps Script dentro da planilha)  └─ aba Membros
```

O Google **não deixa** nenhum app gravar numa planilha só com o link de
compartilhamento sem login. Por isso a planilha leva um pequeno script (o código
fica em [`apps-script/Codigo.gs`](apps-script/Codigo.gs)). Ao publicar o script, o
Google gera um link que termina em **`/exec`**. **Esse** é o link que os dois colam
no app.

---

## Passo 1 — Criar a planilha do casal (uma vez só, ~3 minutos)

Só **um** de vocês faz, num **computador** (no celular o Google não mostra essas opções).
O passo a passo também aparece no app, em **“Ver como criar”**, com um botão para
mandar o código para o computador.

1. Abra **[sheets.new](https://sheets.new)**. Isso cria uma planilha nova no seu Google Drive. Dê um nome, por exemplo *Contas a Dois*.
2. No menu da planilha: **Extensões → Apps Script**.
3. Apague o que estiver no editor, cole todo o conteúdo de [`apps-script/Codigo.gs`](apps-script/Codigo.gs) e salve (💾).
4. **Implantar → Nova implantação**. Na engrenagem ⚙️, escolha **App da Web** e deixe:
   - **Executar como:** Eu
   - **Quem pode acessar:** Qualquer pessoa
5. **Implantar → Autorizar acesso** e escolha sua conta. Se aparecer *“O Google não
   verificou este app”*, clique em **Avançado → Acessar** (é o seu próprio script).
6. Copie o **URL do app da Web** (termina em `/exec`) e mande para o celular de vocês dois.

> 🔒 Quem tiver o link `/exec` consegue ver e editar as contas. Mande só para o seu amor.
> Se o link vazar, faça uma **nova implantação** (gera um link novo) e arquive a antiga.

As abas `Lancamentos`, `Categorias` e `Membros` são criadas sozinhas na primeira vez.

## Passo 2 — Instalar o app nos dois celulares

1. Baixe o **[contas-a-dois.apk](https://github.com/ragzonte/trabalho_rh/releases/download/android/contas-a-dois.apk)**
   no celular (ou receba o arquivo pelo WhatsApp) e toque nele para instalar.
   O Android pede para permitir “instalar apps desta fonte”: é só permitir.
2. Abra o app, toque em **Colar** (ou cole o link no campo) e em **Conectar**.
3. Em **“Quem é você?”**, digite seu nome (o segundo a entrar escolhe o próprio nome ou digita um novo).

> Já instalou a versão antiga do Contas a Dois (a que pedia login do Google)? Pode desinstalar: esta é um app novo.

Pronto. Em **Ajustes → Mandar o link para meu amor** o app monta a mensagem com o
link do app e o link da planilha.

---

## A planilha

| Aba | Colunas |
|---|---|
| `Lancamentos` | id, data, tipo (`despesa`/`receita`), valor, descricao, categoria, pessoa, criado_por, criado_em, atualizado_em |
| `Categorias` | id, nome, tipo, icone |
| `Membros` | nome, entrou_em |

Pode editar e até digitar lançamentos direto na planilha: o app pega as mudanças ao
abrir ou ao tocar em *Salvo/Sincronizar* (linhas novas sem `id` ganham um sozinhas).
Só **não renomeie as abas** e **não mude a ordem das colunas**.

**Atualizar o script:** se um dia o `Codigo.gs` mudar, cole o código novo no Apps
Script e vá em **Implantar → Gerenciar implantações → ✏️ → Versão: Nova versão →
Implantar**. Assim o link continua o mesmo.

---

## Desenvolvimento

Não tem etapa de build: o app são arquivos estáticos (HTML, CSS e JavaScript puro).

```bash
npm start                         # http://localhost:8080 (use ?demo para dados de exemplo)

npm install                       # instala o Playwright (só para os testes)
npx playwright install chromium
npm test                          # teste ponta a ponta do casal inteiro
```

O teste (`tests/e2e.mjs`) simula dois celulares usando o app: links errados, criação
das abas, os dois lançando (inclusive ao mesmo tempo), edição, exclusão, categorias,
troca de nome, modo offline, linhas digitadas direto na planilha e a demonstração. O
Google é substituído por um emulador (`js/fake-sheets.js`) que roda **o mesmo
`Codigo.gs`** que vai na planilha.

### App Android

A pasta `android/` é um app nativo mínimo (uma tela com WebView) que leva os arquivos
do app dentro do APK. O workflow **App Android** compila e publica o APK em
*Releases* a cada mudança. Para compilar no computador: `cd android && ./gradlew assembleRelease`
(precisa do Android SDK).

**Atualizações do APK.** Sem configurar nada, cada APK sai com uma chave de
assinatura temporária: para instalar uma versão nova, sincronize, desinstale a
anterior e instale a nova (os dados ficam na planilha; é só colar o link de novo).
Para as versões novas instalarem por cima, configure uma chave fixa uma vez, num
computador com Java:

```bash
keytool -genkeypair -keystore contas-a-dois.jks -alias contasadois -keyalg RSA \
  -keysize 2048 -validity 10000 -dname "CN=Contas a Dois"
base64 -w0 contas-a-dois.jks      # no macOS: base64 -i contas-a-dois.jks
```

No GitHub, em **Settings → Secrets and variables → Actions**, crie
`ANDROID_KEYSTORE_BASE64` (o texto gerado pelo `base64`) e `ANDROID_KEYSTORE_PASSWORD`
(a senha escolhida). Guarde o `.jks` num lugar seguro e **nunca** o coloque no repositório.

### Estrutura

```
apps-script/Codigo.gs   script que vai dentro da planilha (o "servidor")
android/                app Android (WebView com o app dentro do APK)
index.html              página única do app
css/app.css             visual (claro e escuro automático)
js/app.js               telas e navegação
js/api.js               conversa com o script da planilha (link /exec)
js/db.js                dados + fila offline
js/native.js            compartilhar/copiar/colar no Android
js/stats.js             cálculos dos totais e gráficos
js/charts.js            gráficos em SVG (sem bibliotecas)
js/fake-sheets.js       emulador do Google Sheets (demonstração e testes)
```
