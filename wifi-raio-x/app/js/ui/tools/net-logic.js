// Lógica pura das ferramentas de rede (latência, dispositivos na rede e teste de velocidade).
// Nada aqui toca em DOM, ponte ou relógio: entra dado, sai dado. Testado em tests/net-logic.test.mjs.
//
// Destino do ping   isIpv4 · isIpv6 · isHostname · isValidHost (as MESMAS regras de PingHost.java:
//                   o texto vira argumento de um programa no celular) · parseHostInput (limpa o
//                   que a pessoa colou e explica o erro em português)
// Latência          pingStats(respostas) · pingVerdict(resumo, {target}) · whereIsTheDelay(roteador, internet)
//                   niceAxis(máximo) (escala do gráfico)
// Dispositivos      DEVICE_TYPES · guessDeviceType({host, vendor, self, gateway}) · deviceName(host)
//                   ipToNumber · sortDevices · mergeDevice · summarizeDevices
// Velocidade        speedVerdict · wifiVsInternet (o gargalo é o Wi-Fi ou o plano?) · gaugeMax
//                   estimateTestBytes · formatBytes · serverCity · sanitizeSpeedHistory · addSpeedResult
//
// Os textos devolvidos são os que vão para a tela: curtos, em pt-BR, sem culpar ninguém e com
// "provavelmente" / "≈" em tudo o que é estimativa.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const THIN = '\u202f'; // o mesmo espaço fino dos formatadores de ui/dom.js
const round = (v, digits) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k + 0;
};

/** Número com vírgula decimal: num(12.34, 1) -> "12,3". Só para os textos montados aqui. */
function num(value, digits = 0) {
  if (!isNum(value)) return '—';
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Tempo em ms para os textos: abaixo de 10 ms mostra uma casa decimal. */
function ms(value) {
  if (!isNum(value)) return '—';
  return `${num(value, value < 9.95 ? 1 : 0)}${THIN}ms`;
}

function mbps(value) {
  if (!isNum(value)) return '—';
  if (value >= 995) return `${num(value / 1000, 1)}${THIN}Gb/s`;
  return `${num(value, value < 9.95 ? 1 : 0)}${THIN}Mb/s`;
}

// ---------------------------------------------------------------------------
// Destino do ping
// ---------------------------------------------------------------------------

/** Tamanho máximo de um nome de host (o mesmo de PingHost.MAX_LENGTH). */
export const MAX_HOST_LENGTH = 253;

const isAlnum = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isHexDigit = (c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

/** "192.168.0.10" -> número (sem sinal); 0 quando não é um IPv4 escrito por extenso (LanRange.parse). */
function parseDotted(text) {
  if (typeof text !== 'string') return 0;
  const parts = text.split('.');
  if (parts.length !== 4) return 0;
  let out = 0;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return 0;
    let v = 0;
    for (const c of part) {
      if (c < '0' || c > '9') return 0;
      v = v * 10 + (c.charCodeAt(0) - 48);
    }
    if (v > 255) return 0;
    out = out * 256 + v;
  }
  return out;
}

/** Quatro números de 0 a 255 separados por ponto. */
export function isIpv4(text) {
  return parseDotted(text) !== 0 || text === '0.0.0.0';
}

/** Dígitos hexadecimais, ':' e, no fim, um IPv4 embutido ou um escopo ("%wlan0"). */
export function isIpv6(text) {
  if (typeof text !== 'string') return false;
  let address = text;
  const percent = text.indexOf('%');
  if (percent >= 0) {
    const scope = text.slice(percent + 1);
    if (scope.length === 0 || scope.length > 16) return false;
    for (const c of scope) if (!isAlnum(c)) return false;
    address = text.slice(0, percent);
  }
  if (address.length < 2 || address.length > 45) return false;
  let colons = 0;
  for (const c of address) {
    if (c === ':') colons += 1;
    else if (c !== '.' && !isHexDigit(c)) return false;
  }
  if (colons < 2 || colons > 7) return false;
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) return parseDotted(tail) !== 0 && address.indexOf('.') > lastColon;
  return !address.includes('.');
}

/** Rótulos de letras, dígitos, '-' e '_' separados por ponto; nenhum começa ou termina com '-'. */
export function isHostname(text) {
  if (typeof text !== 'string') return false;
  const name = text.endsWith('.') ? text.slice(0, -1) : text;
  if (name.length === 0) return false;
  const labels = name.split('.');
  for (const label of labels) {
    const n = label.length;
    if (n === 0 || n > 63) return false;
    if (label[0] === '-' || label[n - 1] === '-') return false;
    for (const c of label) if (!isAlnum(c) && c !== '-' && c !== '_') return false;
  }
  // um nome de verdade nunca termina num rótulo só de números ("1.2.3", "999.1.1.1")
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/**
 * O celular aceita este destino para o ping? Só passa o que é claramente um IPv4, um IPv6 ou um
 * nome de host, com até 253 caracteres, e nunca algo que comece com '-' (seria lido como opção).
 * @param {unknown} host
 * @returns {boolean}
 */
export function isValidHost(host) {
  if (typeof host !== 'string') return false;
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
  if (host[0] === '-') return false;
  return isIpv4(host) || isIpv6(host) || isHostname(host);
}

/**
 * Limpa o que a pessoa digitou ou colou ("https://www.exemplo.com.br/pagina" vira
 * "www.exemplo.com.br") e confere com a regra do celular.
 * @param {unknown} input
 * @returns {{host:string, error:null}|{host:null, error:string}}
 */
export function parseHostInput(input) {
  let text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { host: null, error: 'Digite um site (exemplo.com.br) ou um endereço IP (192.168.0.1).' };
  // endereço de site colado inteiro: fica só o nome
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const bracket = /^\[([^\]]*)\](?::\d{1,5})?(?:[/?#].*)?$/.exec(text); // [::1]:443/caminho
  if (bracket) text = bracket[1];
  else {
    text = text.replace(/[/?#].*$/, '');
    const at = text.lastIndexOf('@');
    if (at >= 0) text = text.slice(at + 1);
    // porta no fim de um nome ou IPv4 (num IPv6 os dois-pontos fazem parte do endereço)
    if ((text.match(/:/g) || []).length === 1) text = text.replace(/:\d{1,5}$/, '');
  }
  if (!text) return { host: null, error: 'Digite um site (exemplo.com.br) ou um endereço IP (192.168.0.1).' };
  if (text.length > MAX_HOST_LENGTH) return { host: null, error: `Endereço longo demais (o limite é ${MAX_HOST_LENGTH} caracteres).` };
  if (text[0] === '-') return { host: null, error: 'O endereço não pode começar com hífen.' };
  if (/\s/.test(text)) return { host: null, error: 'O endereço não pode ter espaços. Exemplo: exemplo.com.br' };
  if (isIpv4(text) || isIpv6(text)) return { host: text.toLowerCase(), error: null };
  if (/^[0-9.]+$/.test(text)) return { host: null, error: 'Um endereço IP tem quatro números de 0 a 255 separados por ponto, como 192.168.0.1.' };
  if (text.includes(':')) return { host: null, error: 'Este endereço IPv6 parece incompleto. Exemplo: 2606:4700:4700::1111' };
  if (!isHostname(text)) {
    if (/[^\x21-\x7e]/.test(text)) return { host: null, error: 'Use só letras sem acento, números, pontos e hífens. Exemplo: exemplo.com.br' };
    return { host: null, error: 'Isto não parece um endereço. Use um site (exemplo.com.br) ou um IP (192.168.0.1).' };
  }
  return { host: text.toLowerCase(), error: null };
}

// ---------------------------------------------------------------------------
// Latência
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PingStats  mesmo formato (e mesmas contas) do PingSummary do celular
 * @property {number} sent
 * @property {number} received
 * @property {number} lossPct
 * @property {number} [min]
 * @property {number} [avg]
 * @property {number} [max]
 * @property {number} [jitter]  média das diferenças entre respostas seguidas (ms)
 */

/**
 * Estatísticas das respostas recebidas até agora (para mostrar durante a medição; no fim vale
 * o resumo que o celular devolve).
 * @param {{seq:number, ok:boolean, ms?:number}[]} replies  em qualquer ordem; um `seq` repetido vale o último
 * @param {number} [sent]  quantos pacotes já saíram (padrão: o maior `seq` visto)
 * @returns {PingStats}
 */
export function pingStats(replies, sent) {
  const bySeq = new Map();
  let maxSeq = 0;
  for (const r of Array.isArray(replies) ? replies : []) {
    if (!r || !Number.isInteger(r.seq) || r.seq < 1) continue;
    maxSeq = Math.max(maxSeq, r.seq);
    if (r.ok && isNum(r.ms) && r.ms >= 0) bySeq.set(r.seq, r.ms);
    else if (!bySeq.has(r.seq)) bySeq.set(r.seq, null);
  }
  const times = [...bySeq.entries()]
    .filter(([, v]) => v !== null)
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const total = Math.max(isNum(sent) ? Math.round(sent) : maxSeq, times.length);
  const out = { sent: total, received: times.length, lossPct: total === 0 ? 0 : round((100 * (total - times.length)) / total, 1) };
  if (times.length > 0) {
    out.min = round(Math.min(...times), 3);
    out.avg = round(times.reduce((s, v) => s + v, 0) / times.length, 3);
    out.max = round(Math.max(...times), 3);
  }
  if (times.length > 1) {
    let diff = 0;
    for (let i = 1; i < times.length; i++) diff += Math.abs(times[i] - times[i - 1]);
    out.jitter = round(diff / (times.length - 1), 3);
  }
  return out;
}

/**
 * @typedef {Object} Verdict
 * @property {string} level   chave estável (para testes e estilos)
 * @property {'good'|'info'|'warning'|'critical'|'neutral'} tone
 * @property {string} title   a frase principal
 * @property {string} text    o porquê, com os números
 */

// Limites (média, variação) de cada degrau, por tipo de destino. O roteador está a um salto
// de distância: o que é ótimo para a internet é ruim para ele.
const PING_LIMITS = {
  gateway: { great: [10, 8], good: [30, 20], fair: [80, 40] },
  internet: { great: [35, 10], good: [70, 20], fair: [150, 40] },
};

/**
 * O que os números da latência querem dizer, em palavras simples.
 * @param {Partial<PingStats>|null} stats
 * @param {{target?:'gateway'|'internet'|'lan'|'other'}} [options]  gateway/lan = dentro de casa
 * @returns {Verdict}
 */
export function pingVerdict(stats, { target = 'internet' } = {}) {
  const local = target === 'gateway' || target === 'lan';
  const s = stats || {};
  const sent = isNum(s.sent) ? s.sent : 0;
  const received = isNum(s.received) ? s.received : 0;
  if (sent === 0) {
    return { level: 'empty', tone: 'neutral', title: 'Ainda sem medidas', text: 'Nenhum pacote chegou a ser enviado.' };
  }
  if (received === 0 || !isNum(s.avg)) {
    return {
      level: 'none',
      tone: 'critical',
      title: 'Sem resposta',
      text:
        target === 'gateway'
          ? 'O roteador não respondeu a nenhuma das tentativas. Alguns roteadores ignoram este tipo de teste: experimente o destino Internet.'
          : target === 'lan'
            ? 'Este aparelho não respondeu. Ele pode estar dormindo para poupar bateria, ou ignora este tipo de teste.'
            : 'Nenhuma tentativa teve resposta. Pode ser falta de internet, ou este destino não responde a ping.',
    };
  }
  const lost = Math.max(0, sent - received);
  const lossPct = isNum(s.lossPct) ? s.lossPct : (100 * lost) / sent;
  const jitter = isNum(s.jitter) ? s.jitter : 0;
  const lim = local ? PING_LIMITS.gateway : PING_LIMITS.internet;
  const within = ([avgMax, jitterMax]) => s.avg < avgMax && jitter < jitterMax;

  let level = within(lim.great) ? 'great' : within(lim.good) ? 'good' : within(lim.fair) ? 'fair' : 'poor';
  // perda pesa mais que o tempo: uma chamada aguenta atraso, não aguenta buraco
  if (lost >= 2 && lossPct >= 10) level = 'poor';
  else if (lost >= 1 && lossPct >= 3 && (level === 'great' || level === 'good')) level = 'fair';
  else if (lost >= 1 && level === 'great') level = 'good';

  const numbers = [`Média de ${ms(s.avg)}`];
  if (received > 1) numbers.push(`variação de ${ms(jitter)}`);
  numbers.push(lost === 0 ? 'nenhuma perda' : `${lost === 1 ? '1 resposta perdida' : `${lost} respostas perdidas`} em ${sent} (${num(lossPct, lossPct < 10 && lossPct % 1 ? 1 : 0)}%)`);
  const facts = `${numbers.join(', ')}.`;
  const lossIsWorst = lost >= 2 && lossPct >= 10;

  if (local) {
    const who = target === 'gateway' ? 'O roteador' : 'O aparelho';
    switch (level) {
      case 'great':
        return { level, tone: 'good', title: target === 'gateway' ? 'Wi-Fi respondendo rápido' : 'Aparelho respondendo rápido', text: `${facts} ${who} responde na hora: o caminho pelo Wi-Fi está ótimo.` };
      case 'good':
        return { level, tone: 'good', title: 'Wi-Fi em boa forma', text: `${facts} ${who} responde bem; dá para usar sem preocupação.` };
      case 'fair':
        return {
          level,
          tone: 'warning',
          title: 'Wi-Fi oscilando um pouco',
          text: `${facts} Dentro de casa o normal é ficar abaixo de ${ms(lim.great[0])}. Sinal fraco ou canal congestionado costumam causar isso.`,
        };
      default:
        return {
          level,
          tone: 'critical',
          title: lossIsWorst ? 'Wi-Fi perdendo pacotes' : 'Wi-Fi lento para responder',
          text: `${facts} O atraso já acontece entre o celular e o roteador: chegue mais perto dele ou veja a aba Canais para fugir de interferência.`,
        };
    }
  }
  switch (level) {
    case 'great':
      return { level, tone: 'good', title: 'Ótimo para chamadas e jogos', text: `${facts} Resposta rápida e estável.` };
    case 'good':
      return { level, tone: 'good', title: 'Bom para chamadas e vídeos', text: `${facts} Jogos de reação rápida podem sentir um pouco o atraso.` };
    case 'fair':
      return { level, tone: 'warning', title: 'Dá para navegar, mas chamadas podem falhar', text: `${facts} Sites e vídeos funcionam; chamadas de vídeo e jogos podem engasgar de vez em quando.` };
    default:
      return {
        level,
        tone: 'critical',
        title: lossIsWorst ? 'Conexão instável: pode travar em chamadas de vídeo' : 'Pode travar em chamadas de vídeo',
        text: `${facts} ${lossIsWorst ? 'Respostas perdidas viram voz picotando e imagem congelada.' : 'A resposta está demorando ou variando demais.'} Meça também o destino Roteador para saber se o problema é o Wi-Fi.`,
      };
  }
}

/**
 * Compara a latência até o roteador com a latência até a internet: onde está o atraso?
 * @param {Partial<PingStats>|null} gateway
 * @param {Partial<PingStats>|null} internet
 * @returns {{where:'wifi'|'internet'|'none'|'unknown', tone:string, title:string, text:string}|null}
 *          null quando falta uma das duas medidas
 */
export function whereIsTheDelay(gateway, internet) {
  if (!gateway || !internet || !isNum(gateway.sent) || !isNum(internet.sent) || gateway.sent === 0 || internet.sent === 0) return null;
  if (!isNum(internet.avg)) {
    if (isNum(gateway.avg)) {
      return {
        where: 'internet',
        tone: 'critical',
        title: 'O roteador responde, a internet não',
        text: `O roteador respondeu em ${ms(gateway.avg)}, mas o destino na internet ficou em silêncio. O problema está depois do roteador: na internet do provedor.`,
      };
    }
    return { where: 'unknown', tone: 'warning', title: 'Nenhum dos dois respondeu', text: 'Nem o roteador nem a internet responderam. Confira se o Wi-Fi está conectado.' };
  }
  if (!isNum(gateway.avg)) {
    return {
      where: 'unknown',
      tone: 'info',
      title: 'O roteador não respondeu ao teste',
      text: `A internet respondeu em ${ms(internet.avg)}, então a conexão funciona. Alguns roteadores simplesmente ignoram o ping.`,
    };
  }
  const g = gateway.avg;
  const i = internet.avg;
  const gLoss = isNum(gateway.lossPct) ? gateway.lossPct : 0;
  const both = `Roteador: ${ms(g)}. Internet: ${ms(i)}.`;
  if (i < 60 && g < 15 && gLoss < 5) {
    return { where: 'none', tone: 'good', title: 'Sem atraso relevante', text: `${both} O Wi-Fi e a internet estão respondendo bem.` };
  }
  // o tempo até a internet inclui o trecho do Wi-Fi
  const share = Math.min(1, g / Math.max(i, 0.001));
  if (share >= 0.5 || g >= 30 || gLoss >= 5) {
    return {
      where: 'wifi',
      tone: 'warning',
      title: 'O atraso está no Wi-Fi',
      text: `${both} Boa parte da demora acontece antes de sair de casa, entre o celular e o roteador. Aproximar-se do roteador ou trocar de canal deve ajudar.`,
    };
  }
  return {
    where: 'internet',
    tone: 'info',
    title: 'O atraso está na internet, não no Wi-Fi',
    text: `${both} O Wi-Fi responde rápido; a demora acontece depois do roteador, no caminho do provedor.`,
  };
}

/**
 * Escala "redonda" para um eixo que começa em zero: niceAxis(37) -> {max: 40, step: 10, ticks: [0, 10, 20, 30, 40]}.
 * @param {number} maxValue  o maior valor a mostrar
 * @param {number} [targetTicks=4]  quantas divisões, mais ou menos
 */
export function niceAxis(maxValue, targetTicks = 4) {
  const top = isNum(maxValue) && maxValue > 0 ? maxValue : 1;
  const rough = top / Math.max(1, targetTicks);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / pow;
  const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * pow;
  const max = Math.max(step, Math.ceil(top / step - 1e-9) * step);
  const ticks = [];
  for (let v = 0; v <= max + step / 1000; v += step) ticks.push(round(v, 6));
  return { max: round(max, 6), step: round(step, 6), ticks };
}

// ---------------------------------------------------------------------------
// Dispositivos na rede
// ---------------------------------------------------------------------------

/** Tipos de aparelho que a tela sabe desenhar, com o nome em português. */
export const DEVICE_TYPES = Object.freeze({
  router: 'Roteador',
  network: 'Equipamento de rede',
  phone: 'Celular',
  tablet: 'Tablet',
  computer: 'Computador',
  tv: 'TV ou streaming',
  printer: 'Impressora',
  speaker: 'Caixa de som inteligente',
  console: 'Videogame',
  camera: 'Câmera',
  iot: 'Aparelho inteligente',
  server: 'Servidor ou armazenamento',
  unknown: 'Aparelho',
});

// Sem acentos e em minúsculas, para as regras não dependerem de como o nome foi escrito.
const fold = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

// Do mais específico para o mais genérico: "Galaxy Tab" é tablet antes de "Galaxy" ser celular.
const NAME_RULES = [
  ['printer', /(impressora|printer|epson|laserjet|deskjet|officejet|ecotank|pixma|brother|lexmark|xerox|\bl\d{4} series|\bhp[- ]?(ink|smart|laser|envy|color))/],
  ['console', /(playstation|\bps[345]\b|xbox|nintendo|steam ?deck)/],
  ['camera', /(camera|\bcam\b|\bipcam|\bdvr\b|\bnvr\b|hikvision|dahua|ezviz|reolink|tapo[- ]?c\d|baba eletronica|campainha)/],
  ['speaker', /(\becho\b|alexa|google ?home|nest ?(mini|audio|hub)|homepod|sonos|soundbar|caixa de som|\bjbl\b|\bbose\b)/],
  ['tv', /(\btv\b|smart ?tv|bravia|roku|chromecast|fire ?stick|firestick|apple ?tv|mi ?box|webos|tizen|\btcl\b|hisense|projetor)/],
  ['tablet', /(ipad|tablet|galaxy[- ]?tab|\btab[- ]?[as]?\d|kindle|fire ?hd)/],
  ['server', /(\bsrv\b|\bsrv[-_]|server|servidor|\bnas\b|synology|qnap|truenas|proxmox|raspberry|\brpi\b)/],
  ['network', /(roteador|router|\bdeco\b|\bmesh\b|repetidor|extensor|extender|access ?point|\bap[-_ ]|unifi|mikrotik|gateway|\bonu\b|\bont\b|modem)/],
  ['iot', /(lampada|tomada|\bplug\b|\bbulb\b|sonoff|tuya|smart ?life|shelly|esp[-_]?(32|8266|[0-9a-f]{6})|relogio de ponto|sensor|termostato|geladeira|aspirador|roomba|interruptor|fechadura|ar[- ]condicionado)/],
  ['phone', /(iphone|galaxy|redmi|xiaomi|\bmoto\b|moto[- ]?[a-z]\d|motorola|pixel|android|celular|phone|\bpoco\b|realme|oneplus|\bsm-[a-z]\d)/],
  ['computer', /(notebook|laptop|desktop|macbook|imac|\bmac\b|\bpc\b|\bpc[-_]|\bnb[-_]|thinkpad|ideapad|inspiron|latitude|vostro|\bdell\b|lenovo|windows|ubuntu|linux|workstation|computador)/],
];

// Fabricante (pelo MAC, só em Android antigo) -> palpite. Só marcas que quase sempre são um tipo só.
const VENDOR_RULES = [
  ['printer', /(epson|brother|canon|lexmark|xerox|kyocera|ricoh)/],
  ['console', /(sony interactive|nintendo|valve)/],
  ['camera', /(hikvision|dahua|ezviz|reolink|axis communications)/],
  ['speaker', /(sonos|bose|amazon)/],
  ['tv', /(roku|tcl|hisense|vizio|lg electronics)/],
  ['iot', /(espressif|tuya|itead|sonoff|shelly|allterco|shenzhen bilian)/],
  ['network', /(tp-?link|ubiquiti|mikrotik|routerboard|d-?link|tenda|mercusys|netgear|cisco|aruba|ruckus|intelbras|multilaser|arris|sagemcom|technicolor|fiberhome)/],
  ['phone', /(motorola mobility|oneplus|oppo|vivo mobile|realme|hmd global)/],
  ['server', /(raspberry|synology|qnap)/],
  ['computer', /(intel corp|dell|lenovo|asustek|micro-star|acer|hewlett|hp inc|giga-byte|liteon|azurewave)/],
];

/**
 * Que tipo de aparelho é este? Um palpite pelo nome que ele informa e, quando o Android deixa
 * ver o MAC, pelo fabricante. `source` diz de onde saiu o palpite (null = não deu para saber).
 * @param {{host?:string|null, vendor?:string|null, self?:boolean, gateway?:boolean}} device
 * @returns {{type:keyof typeof DEVICE_TYPES, label:string, source:'flag'|'name'|'vendor'|null}}
 */
export function guessDeviceType(device) {
  const d = device || {};
  const make = (type, source) => ({ type, label: DEVICE_TYPES[type], source });
  if (d.gateway) return make('router', 'flag');
  if (d.self) return make('phone', 'flag');
  if (typeof d.host === 'string' && d.host.trim()) {
    const name = fold(d.host);
    for (const [type, rule] of NAME_RULES) if (rule.test(name)) return make(type, 'name');
  }
  if (typeof d.vendor === 'string' && d.vendor.trim()) {
    const vendor = fold(d.vendor);
    for (const [type, rule] of VENDOR_RULES) if (rule.test(vendor)) return make(type, 'vendor');
  }
  return make('unknown', null);
}

/**
 * Nome para mostrar: sem caracteres de controle, sem o sufixo da rede local (".local", ".lan").
 * Devolve null quando não há nome de verdade (vazio, ou o próprio endereço IP).
 * @param {unknown} host
 * @returns {string|null}
 */
export function deviceName(host) {
  if (typeof host !== 'string') return null;
  let text = host.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.endsWith('.')) text = text.slice(0, -1);
  const short = text.replace(/\.(local|lan|home|localdomain|internal|home\.arpa|fritz\.box)$/i, '');
  if (short) text = short;
  if (!text || isIpv4(text) || isIpv6(text)) return null;
  return text;
}

/** "192.168.0.10" -> número para ordenar; endereço inválido vai para o fim. */
export function ipToNumber(ip) {
  const n = parseDotted(ip);
  return n === 0 && ip !== '0.0.0.0' ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * Ordem da lista: o roteador, este celular e depois os demais por endereço (ordem estável: um
 * aparelho novo entra no lugar dele sem embaralhar os outros).
 * @template {{ip:string, self?:boolean, gateway?:boolean}} T
 * @param {T[]} devices
 * @returns {T[]} lista nova
 */
export function sortDevices(devices) {
  const rank = (d) => (d.gateway ? 0 : d.self ? 1 : 2);
  return [...(Array.isArray(devices) ? devices : [])].sort((a, b) => rank(a) - rank(b) || ipToNumber(a.ip) - ipToNumber(b.ip) || (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0));
}

/**
 * Junta um aparelho recém-anunciado à lista (por IP). Um aviso repetido completa o que faltava
 * (nome, MAC) sem apagar o que já se sabia.
 * @param {object[]} devices
 * @param {object} device  LanDevice
 * @returns {object[]} lista nova (ou a mesma, se o aparelho for inválido)
 */
export function mergeDevice(devices, device) {
  if (!device || typeof device.ip !== 'string' || !device.ip) return devices;
  const clean = { ip: device.ip };
  if (typeof device.host === 'string' && device.host.trim()) clean.host = device.host;
  if (typeof device.mac === 'string' && device.mac.trim()) clean.mac = device.mac.trim().toLowerCase();
  if (isNum(device.ms) && device.ms >= 0) clean.ms = device.ms;
  if (device.self === true) clean.self = true;
  if (device.gateway === true) clean.gateway = true;
  const at = devices.findIndex((d) => d.ip === clean.ip);
  if (at < 0) return [...devices, clean];
  const next = devices.slice();
  next[at] = { ...devices[at], ...clean };
  return next;
}

/**
 * Contagem para o resumo da tela.
 * @param {{host?:string, mac?:string, self?:boolean, gateway?:boolean}[]} devices
 * @returns {{total:number, named:number, unnamed:number, withMac:number, others:number}}
 *          others = fora o roteador e este celular
 */
export function summarizeDevices(devices) {
  const list = Array.isArray(devices) ? devices : [];
  let named = 0;
  let withMac = 0;
  let others = 0;
  for (const d of list) {
    if (deviceName(d.host)) named += 1;
    if (d.mac) withMac += 1;
    if (!d.self && !d.gateway) others += 1;
  }
  return { total: list.length, named, unnamed: list.length - named, withMac, others };
}

// ---------------------------------------------------------------------------
// Teste de velocidade
// ---------------------------------------------------------------------------

/**
 * O que a velocidade medida permite fazer, em palavras simples.
 * @param {{downMbps?:number, upMbps?:number, latencyMs?:number}} result
 * @returns {Verdict}
 */
export function speedVerdict(result) {
  const r = result || {};
  const down = r.downMbps;
  if (!isNum(down) || down < 0) return { level: 'empty', tone: 'neutral', title: 'Sem resultado', text: 'O teste não chegou a medir o download.' };
  let out;
  if (down >= 200) out = { level: 'excellent', tone: 'good', title: 'Internet muito rápida', text: 'Sobra para várias telas em 4K, jogos e downloads grandes ao mesmo tempo.' };
  else if (down >= 50) out = { level: 'fast', tone: 'good', title: 'Internet rápida', text: 'Dá para vídeo em 4K, chamadas e várias pessoas usando ao mesmo tempo.' };
  else if (down >= 15) out = { level: 'ok', tone: 'good', title: 'Boa para o dia a dia', text: 'Vídeo em Full HD e chamadas funcionam bem; com muita gente usando ao mesmo tempo pode apertar.' };
  else if (down >= 5) out = { level: 'tight', tone: 'warning', title: 'Internet apertada', text: 'Dá para um vídeo em HD por vez. Chamadas de vídeo podem perder qualidade.' };
  else out = { level: 'slow', tone: 'critical', title: 'Internet lenta', text: 'Vídeos podem travar e chamadas de vídeo ficam difíceis.' };
  const extra = [];
  if (isNum(r.upMbps) && r.upMbps < 3 && down >= 5) extra.push('O envio (upload) está baixo: mandar arquivos e aparecer bem em chamadas de vídeo fica mais difícil.');
  if (isNum(r.latencyMs) && r.latencyMs >= 100) extra.push('A resposta está demorada, o que atrapalha jogos e chamadas.');
  if (extra.length && out.tone === 'good') out.tone = 'warning';
  return { ...out, text: [out.text, ...extra].join(' ') };
}

/** Quanto da velocidade do enlace vira dado útil num download (o mesmo 60% de core/phy.js). */
export const WIFI_EFFICIENCY = 0.6;

/**
 * O gargalo é o Wi-Fi ou o plano de internet? Compara o que o teste mediu com o que o enlace
 * Wi-Fi consegue carregar agora (a "velocidade do link" que o Android informa, descontada do
 * que o próprio Wi-Fi consome). É uma estimativa.
 * @param {{downMbps?:number, linkMbps?:number|null}} input  linkMbps = velocidade do link de recepção
 * @returns {{bottleneck:'wifi'|'close'|'plan'|'unknown', tone:string, wifiMbps:number|null, title:string, text:string}}
 */
export function wifiVsInternet({ downMbps, linkMbps } = {}) {
  if (!isNum(downMbps) || downMbps <= 0 || !isNum(linkMbps) || linkMbps <= 0) {
    return {
      bottleneck: 'unknown',
      tone: 'neutral',
      wifiMbps: null,
      title: 'Wi-Fi ou plano?',
      text: 'O celular não informou a velocidade do Wi-Fi durante o teste, então não dá para dizer onde está o limite.',
    };
  }
  const wifiMbps = round(linkMbps * WIFI_EFFICIENCY, 1);
  const ratio = downMbps / wifiMbps;
  const numbers = `Aqui o seu Wi-Fi aguenta ≈${THIN}${mbps(wifiMbps)}; a internet entregou ${mbps(downMbps)}.`;
  if (ratio >= 0.8) {
    return {
      bottleneck: 'wifi',
      tone: 'warning',
      wifiMbps,
      title: 'O limite aqui é o Wi-Fi',
      text: `${numbers} O teste usou praticamente tudo o que o Wi-Fi consegue levar neste ponto. Mais perto do roteador (ou na faixa de 5${THIN}GHz) a internet deve render mais.`,
    };
  }
  if (ratio >= 0.55) {
    return {
      bottleneck: 'close',
      tone: 'info',
      wifiMbps,
      title: 'Wi-Fi e internet estão próximos do limite',
      text: `${numbers} O Wi-Fi tem pouca folga: com sinal um pouco pior, é ele que passa a segurar a velocidade.`,
    };
  }
  return {
    bottleneck: 'plan',
    tone: 'good',
    wifiMbps,
    title: 'O Wi-Fi dá conta: o limite é a internet',
    text: `${numbers} O Wi-Fi tem folga, então a velocidade está sendo limitada pelo plano contratado ou pelo provedor, não pelo sinal.`,
  };
}

const GAUGE_STEPS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** Fundo de escala "redondo" para o mostrador: gaugeMax(86) -> 100; gaugeMax(95) -> 250. */
export function gaugeMax(value) {
  const v = isNum(value) && value > 0 ? value * 1.08 : 0;
  for (const step of GAUGE_STEPS) if (v <= step) return step;
  return GAUGE_STEPS[GAUGE_STEPS.length - 1];
}

/** Duração e tetos de cada modo do teste (os mesmos de SpeedTester.Plan no celular). */
export const SPEED_MODES = Object.freeze({
  full: Object.freeze({ phaseS: 8, downCap: Infinity, upCap: Infinity }),
  light: Object.freeze({ phaseS: 3, downCap: 25e6, upCap: 10e6 }),
});

/** O máximo que o teste leve trafega, em bytes (25 MB de download + 10 MB de upload). */
export const LIGHT_MAX_BYTES = SPEED_MODES.light.downCap + SPEED_MODES.light.upCap;

/**
 * Quanto de dados um teste deve gastar, a partir das velocidades da última medição.
 * @param {'full'|'light'} mode
 * @param {number} [downMbps]
 * @param {number} [upMbps]
 * @returns {number|null} bytes; null quando não há medição anterior para estimar
 */
export function estimateTestBytes(mode, downMbps, upMbps) {
  const plan = SPEED_MODES[mode === 'light' ? 'light' : 'full'];
  if (!isNum(downMbps) || downMbps <= 0) return null;
  const up = isNum(upMbps) && upMbps > 0 ? upMbps : downMbps / 2;
  const during = (rate, cap) => Math.min(cap, rate * 125000 * plan.phaseS);
  return Math.round(during(downMbps, plan.downCap) + during(up, plan.upCap));
}

/**
 * Tamanho em bytes para gente: formatBytes(312_400_000) -> "312 MB"; 1_520_000_000 -> "1,5 GB".
 * (1 MB = 1 milhão de bytes, como as operadoras contam a franquia.)
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!isNum(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)}${THIN}B`;
  if (bytes < 999_500) return `${num(bytes / 1000, bytes < 9950 ? 1 : 0)}${THIN}kB`;
  if (bytes < 999_500_000) return `${num(bytes / 1e6, bytes < 9_950_000 ? 1 : 0)}${THIN}MB`;
  return `${num(bytes / 1e9, bytes < 9_950_000_000 ? 2 : 1)}${THIN}GB`;
}

// Datacenters da Cloudflare mais prováveis para quem está no Brasil (sigla de aeroporto -> cidade).
const SERVER_CITIES = {
  GRU: 'São Paulo',
  VCP: 'Campinas',
  GIG: 'Rio de Janeiro',
  CNF: 'Belo Horizonte',
  BSB: 'Brasília',
  CWB: 'Curitiba',
  POA: 'Porto Alegre',
  FLN: 'Florianópolis',
  SSA: 'Salvador',
  REC: 'Recife',
  FOR: 'Fortaleza',
  BEL: 'Belém',
  MAO: 'Manaus',
  GYN: 'Goiânia',
  VIX: 'Vitória',
  NAT: 'Natal',
  CGB: 'Cuiabá',
  UDI: 'Uberlândia',
  RAO: 'Ribeirão Preto',
  SJP: 'São José do Rio Preto',
  SJK: 'São José dos Campos',
  JOI: 'Joinville',
  ITJ: 'Itajaí',
  XAP: 'Chapecó',
  CFB: 'Cabo Frio',
  NVT: 'Navegantes',
  BNU: 'Blumenau',
  SOD: 'Sorocaba',
  JDO: 'Juazeiro do Norte',
  ARU: 'Araçatuba',
  CAW: 'Campos dos Goytacazes',
  PMW: 'Palmas',
  EZE: 'Buenos Aires',
  SCL: 'Santiago',
  MVD: 'Montevidéu',
  ASU: 'Assunção',
  LIM: 'Lima',
  BOG: 'Bogotá',
  MIA: 'Miami',
  LIS: 'Lisboa',
};

/** Cidade do servidor pela sigla que a Cloudflare informa ("GRU" -> "São Paulo"); null se desconhecida. */
export function serverCity(code) {
  if (typeof code !== 'string') return null;
  return SERVER_CITIES[code.trim().toUpperCase()] || null;
}

/** Quantos resultados do teste de velocidade ficam guardados. */
export const SPEED_HISTORY_MAX = 10;

/**
 * @typedef {Object} SpeedRecord  um teste concluído, como fica guardado em wrx.speed.history
 * @property {number} ts          quando terminou (ms desde 1970)
 * @property {'full'|'light'} mode
 * @property {number} downMbps
 * @property {number} upMbps
 * @property {number} [latencyMs]
 * @property {number} [jitterMs]
 * @property {number} bytesDown
 * @property {number} bytesUp
 * @property {string} [server]    sigla do datacenter
 * @property {string} [ssid]      rede em que o teste rodou (texto hostil: só textContent)
 * @property {number} [linkMbps]  velocidade do link Wi-Fi (recepção) durante o teste
 */

const nonNegative = (v) => (isNum(v) && v >= 0 ? v : undefined);

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNum(raw.ts) || raw.ts <= 0) return null;
  const down = nonNegative(raw.downMbps);
  const up = nonNegative(raw.upMbps);
  if (down === undefined || up === undefined) return null;
  const out = {
    ts: Math.round(raw.ts),
    mode: raw.mode === 'light' ? 'light' : 'full',
    downMbps: round(down, 2),
    upMbps: round(up, 2),
    bytesDown: Math.round(nonNegative(raw.bytesDown) ?? 0),
    bytesUp: Math.round(nonNegative(raw.bytesUp) ?? 0),
  };
  const latency = nonNegative(raw.latencyMs);
  if (latency !== undefined) out.latencyMs = round(latency, 1);
  const jitter = nonNegative(raw.jitterMs);
  if (jitter !== undefined) out.jitterMs = round(jitter, 1);
  if (typeof raw.server === 'string' && /^[A-Za-z0-9]{2,8}$/.test(raw.server)) out.server = raw.server.toUpperCase();
  if (typeof raw.ssid === 'string' && raw.ssid !== '' && raw.ssid.length <= 64) out.ssid = raw.ssid;
  const link = nonNegative(raw.linkMbps);
  if (link !== undefined && link > 0) out.linkMbps = round(link, 1);
  return out;
}

/**
 * Qualquer coisa lida do armazenamento -> lista válida, do mais recente para o mais antigo.
 * @param {unknown} raw
 * @returns {SpeedRecord[]}
 */
export function sanitizeSpeedHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const record = sanitizeRecord(item);
    if (record) out.push(record);
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, SPEED_HISTORY_MAX);
}

/**
 * Acrescenta um resultado ao histórico (o mais recente primeiro, no máximo SPEED_HISTORY_MAX).
 * @param {unknown} history
 * @param {unknown} record
 * @returns {SpeedRecord[]} lista nova
 */
export function addSpeedResult(history, record) {
  return sanitizeSpeedHistory([record, ...(Array.isArray(history) ? history : [])]);
}
