# 💑 Contas a Dois

App simples e leve para o casal controlar as despesas juntos. Cada um lança o que
ganha e o que gasta, e os dois veem tudo no mesmo lugar: saldo do mês, quanto cada
um ganhou e gastou, para onde foi o dinheiro e a evolução dos últimos meses.

- **Banco de dados = uma planilha do Google Sheets** no Drive de quem cria, compartilhada com o parceiro(a). Dá para abrir e editar a planilha quando quiser.
- **Login com a conta Google.** Não precisa criar senha nem cadastro.
- **Instala como app** (PWA) no Android e no iPhone, direto do navegador, sem loja.
- **Funciona offline:** o que você lança sem internet fica guardado e vai para a planilha quando a conexão volta.
- **Categorias editáveis:** já vem com as mais comuns, e dá para criar, renomear e apagar.
- **Gráficos:** receitas x despesas dos últimos 6 meses, gastos por categoria e por pessoa.
- Sem servidor, sem mensalidade e sem bibliotecas externas. Hospedagem grátis no GitHub Pages.

> 🧪 **Quer só ver como é?** Abra o app com `?demo` no final do endereço
> (ex.: `https://ragzonte.github.io/trabalho_rh/?demo`). A demonstração usa dados de exemplo
> e não precisa de conta Google.

---

## Como o casal usa

1. **Instalar o app no celular:**
   - **Android:** baixe o APK em
     [`contas-a-dois.apk`](https://github.com/ragzonte/trabalho_rh/releases/download/android/contas-a-dois.apk)
     e toque para instalar (o Android pede para permitir “instalar apps desta fonte”).
     Também dá para abrir o site no Chrome e tocar em *Instalar app*. As duas opções
     viram um app de verdade no celular.
   - **iPhone (Safari):** abra o site e toque em *Compartilhar* → *Adicionar à Tela de Início*.
2. **Quem chegar primeiro** toca em *Entrar com Google* → *Criar nosso espaço*, informa
   o e-mail Google do parceiro(a) e o app cria a planilha e já libera o acesso.
3. Na tela seguinte, toque em **Enviar link do convite** (WhatsApp, por exemplo).
4. **O parceiro(a)** abre o link, toca em *Entrar com Google* e pronto: os dois estão conectados.

Depois disso é só usar o botão **+** para lançar salários e despesas.
Se trocar de celular, é só entrar com a mesma conta Google: o app acha a planilha sozinho.

---

## Configuração (uma vez só, por quem publica o app)

O app roda 100% no navegador. Para ele poder ler e gravar na planilha, o Google
exige um **ID do cliente OAuth**. É grátis e leva uns 10 minutos.

### 1. Publicar no GitHub Pages

1. No GitHub: **Settings → Pages → Build and deployment → Source: “GitHub Actions”**.
2. Em **Actions → Publicar no GitHub Pages → Run workflow**, rode a primeira publicação.
3. Depois disso, a cada push na branch principal do repositório, o app é publicado
   sozinho em **`https://ragzonte.github.io/trabalho_rh/`**.

### 2. Criar o login do Google

No [Google Cloud Console](https://console.cloud.google.com/):

1. **Crie um projeto** (ex.: “Contas a Dois”).
2. **APIs e serviços → Biblioteca:** ative a **Google Sheets API** e a **Google Drive API**.
3. **Google Auth Platform** (ou “Tela de consentimento OAuth”):
   - Tipo de usuário: **Externo**.
   - Nome do app: *Contas a Dois*; e-mail de suporte: o seu.
   - **Acesso a dados / Escopos:** adicione
     `.../auth/spreadsheets`, `.../auth/drive.file` e `.../auth/drive.appdata`
     (além de `openid`, `email` e `profile`).
   - **Público:** escolha uma das opções:
     - **Publicar o app** (“Em produção”) — recomendado. Sem verificação do Google, cada
       um verá uma vez o aviso *“O Google não verificou este app”*: toque em
       **Avançado → Acessar Contas a Dois**. (Limite de 100 usuários, mais que suficiente.)
     - ou deixar **“Em teste”** e adicionar os dois e-mails em **Usuários de teste**.
4. **Clientes → Criar cliente → Aplicativo da Web**:
   - **Origens JavaScript autorizadas:** `https://ragzonte.github.io`
   - **URIs de redirecionamento autorizados:** `https://ragzonte.github.io/trabalho_rh/`
     (com a barra no final)
   - Para testar no computador, adicione também `http://localhost:8080` e `http://localhost:8080/`.
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`).

### 3. Colar o ID no app

Edite `js/config.js`:

```js
export const CONFIG = {
  GOOGLE_CLIENT_ID: 'SEU-ID.apps.googleusercontent.com',
  ...
};
```

Faça commit e push na `main`. Pronto! (O ID do cliente não é segredo: pode ficar no código.)

### 4. App Android (APK)

O app Android fica na pasta `android/`. É uma **Trusted Web Activity**: um APK de
verdade que abre o app em tela cheia usando o Chrome do celular. Por isso o login
com Google funciona igual, e **toda melhoria publicada no site chega no app sem
reinstalar**.

O workflow `App Android` compila o APK sozinho. A cada push na branch principal que
mexa em `android/`, ele publica em **Releases → App Android** (link fixo para baixar:
`https://github.com/ragzonte/trabalho_rh/releases/download/android/contas-a-dois.apk`).
Para gerar na hora: aba **Actions → App Android → Run workflow**.

Duas configurações opcionais (recomendadas) deixam o app perfeito:

**a) Chave de assinatura fixa.** Sem ela, cada APK sai com uma chave temporária, e
para atualizar o APK é preciso desinstalar o anterior (os dados ficam na planilha,
nada se perde). Para fixar, num computador com Java:

```bash
keytool -genkeypair -keystore contas-a-dois.jks -alias contasadois -keyalg RSA \
  -keysize 2048 -validity 10000 -dname "CN=Contas a Dois"
base64 -w0 contas-a-dois.jks   # no macOS: base64 -i contas-a-dois.jks
```

Em **Settings → Secrets and variables → Actions**, crie
`ANDROID_KEYSTORE_BASE64` (o texto do `base64`) e `ANDROID_KEYSTORE_PASSWORD`
(a senha que você escolheu). Guarde o arquivo `.jks` num lugar seguro e **não** o
coloque no repositório.

**b) Tela cheia e convites abrindo direto no app.** O Android só tira a barra de
endereço depois de confirmar que o site é seu, lendo o arquivo
`https://ragzonte.github.io/.well-known/assetlinks.json`, que fica na raiz do domínio:

1. Crie um repositório **público** chamado `ragzonte.github.io`.
2. Adicione um arquivo vazio `.nojekyll` e o arquivo `.well-known/assetlinks.json`
   com o conteúdo que o workflow mostra no resumo da execução (também anexado em
   Releases como `assetlinks.json`). Ele depende da chave do item (a).
3. Em *Settings → Pages* desse repositório, publique a branch `main`.

Sem isso o app funciona normalmente, só que com uma barrinha com o endereço no topo.

---

## A planilha

O app cria uma planilha chamada **“Contas a Dois — planilha do casal”** com estas abas:

| Aba | Colunas |
|---|---|
| `Lancamentos` | id, data, tipo (`despesa`/`receita`), valor, descricao, categoria, pessoa (e-mail), criado_por, criado_em, atualizado_em |
| `Categorias` | id, nome, tipo, icone |
| `Membros` | email, nome, entrou_em |
| `Config` | chave, valor |

Pode editar valores, datas, descrições e categorias direto na planilha (o app pega as
mudanças ao abrir ou ao tocar em *Salvo/Sincronizar*). Só **não renomeie as abas, não
mude a ordem das colunas e não apague a coluna `id`**.

### Permissões que o app pede

| Permissão | Para quê |
|---|---|
| Ver seu e-mail e nome | Saber quem lançou o quê |
| Planilhas (Sheets) | Ler e gravar na planilha do casal |
| Arquivos criados pelo app (`drive.file`) | Criar a planilha e compartilhar com o parceiro(a) |
| Dados do app (`drive.appdata`) | Guardar, numa pasta oculta do seu Drive, qual é a planilha — para achar sozinho em outro celular |

Nenhum dado passa por servidor nosso: o app conversa direto com o Google.

---

## Desenvolvimento

Não tem etapa de build: são arquivos estáticos (HTML, CSS e JavaScript puro).

```bash
npm start                         # servidor local em http://localhost:8080
# abra http://localhost:8080/?demo para usar sem conta Google

npm install                       # instala o Playwright (só para os testes)
npx playwright install chromium
npm test                          # teste ponta a ponta do casal inteiro
```

O teste (`tests/e2e.mjs`) simula dois celulares: a Ana cria a planilha e convida o Beto,
os dois lançam, editam e apagam, a sessão do Google expira no meio, a internet cai, a Ana
entra em outro aparelho e uma terceira pessoa tenta usar o convite sem permissão. As APIs
do Google são substituídas por um emulador (`js/fake-google.js`), o mesmo usado no modo
demonstração.

### Estrutura

```
android/              app Android (Trusted Web Activity, sem código nativo)
index.html            página única do app
manifest.webmanifest  dados para instalar como app
sw.js                 service worker (abre offline)
css/app.css           visual (claro e escuro automático)
js/config.js          ⚙️ ID do cliente Google
js/app.js             telas e navegação
js/auth.js            login Google (OAuth por redirecionamento)
js/google.js          chamadas às APIs do Sheets e do Drive
js/db.js              planilha como banco de dados + fila offline
js/stats.js           cálculos dos totais e gráficos
js/charts.js          gráficos em SVG (sem bibliotecas)
js/fake-google.js     emulador das APIs (demonstração e testes)
```

### Ponto de atenção

O login usa o fluxo OAuth do Google para apps só de navegador (`response_type=token`,
por redirecionamento), que funciona igual no Android, no iPhone instalado e no
computador, sem pop-ups. Se um dia o Google desativar esse fluxo, a troca fica
concentrada em `js/auth.js` (ex.: para a biblioteca Google Identity Services).
