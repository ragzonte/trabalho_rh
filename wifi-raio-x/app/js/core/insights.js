// Diagnóstico automático: olha a varredura, a conexão e o celular e diz, em português claro, o
// que está errado (ou que está tudo certo).
//
// Regra de ouro: cada aviso só aparece quando o dado que o sustenta veio do celular. Sem os
// elementos do beacon (Android antigo), sem a conexão ou sem a lista de redes, o aviso
// correspondente simplesmente não existe: nada é presumido.
//
// "Seu roteador" = o aparelho físico (groupByDevice) do BSSID em que o celular está conectado.
// "Sua rede" = os BSSIDs com o mesmo nome e a mesma família de segurança (groupBySsid).
//
// Nenhuma função lança exceção: uma regra que tropeça num dado torto só deixa de avisar.

import { bandOf, isDfs } from './channels.js';
import { signalLevel } from './signal.js';
import { estimateLink, maxRate, standardInfo } from './phy.js';
import { parseCapabilities } from './security.js';
import { parseIes } from './ies.js';
import { asAp, groupByDevice, groupBySsid, normalizeBssid, ssidStem } from './model.js';
import { recommendChannel, recommendWidth } from './channel-rating.js';
import { scoreAp, scoringContext, clientProfile, isInsecure, formatSpeed, formatDbm, timesMore } from './best-network.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';

/**
 * @typedef {Object} Insight
 * @property {string} id         identificador estável (serve de chave na tela e para "não mostrar de novo")
 * @property {'critical'|'warning'|'info'|'good'} severity
 * @property {string} title      uma linha
 * @property {string} text       o que está acontecendo, com os números, e o que fazer
 * @property {{label: string, kind: 'open-channels'|'open-best'|'open-settings-wifi'|'open-map'|'none'}} [action]
 *           atalho para a tela que resolve; ausente quando não há o que abrir
 */

// ---------------------------------------------------------------------------
// Limites (cada um é uma escolha de projeto)
// ---------------------------------------------------------------------------

// Os dois cortes de signalLevel() em signal.js, repetidos aqui só para entrarem nas frases.
const WEAK_BELOW_DBM = -75;
const VERY_WEAK_BELOW_DBM = -82;
/** "Bom" em signal.js: dá para chamada de vídeo. A faixa de 5/6 GHz só é sugerida daqui para cima. */
const GOOD_SIGNAL_DBM = -67;
/** A outra faixa precisa render pelo menos isto a mais para a frase citar o ganho. */
const GAIN_WORTH_SAYING = 1.2;
/** Canal com nota acima disto não é "congestionado", mesmo que exista um melhor. */
const CROWDED_MAX_SCORE = 80;
/** Outro ponto de acesso da mesma rede precisa ser tudo isto mais forte para valer o aviso... */
const ROAM_GAIN_DB = 10;
/** ...e só quando o sinal atual já não é bom (com sinal bom o celular está bem onde está). */
const ROAM_BELOW_DBM = -65;
/** Aparelhos no mesmo rádio a partir dos quais um roteador doméstico começa a engasgar. */
const MANY_STATIONS = 25;
/** Ocupação do canal (BSS Load) a partir da qual a rede já responde devagar. */
const HIGH_UTILIZATION = 0.5;
/** Taxa do enlace abaixo desta fração do esperado = "muito abaixo do que o sinal permite". */
const SLOW_LINK_RATIO = 0.4;
/** Com sinal pior que isto, taxa baixa é culpa do sinal (e o aviso de sinal fraco já cobre). */
const SLOW_LINK_MIN_DBM = -70;
// O celular mais simples à venda: é contra ele que a taxa é comparada quando o Android não
// informa o que foi negociado.
const MODEST_GEN = 4;
const MODEST_WIDTH_MHZ = 40;
/** Sinal mínimo do 2,4 GHz para concluir que o roteador não tem 5 GHz (senão o 5 GHz pode só não chegar). */
const WIFI4_MIN_DBM = -60;
/** WifiInfo.getRssi() quando não há medida. */
const INVALID_RSSI = -127;
// WifiInfo.SECURITY_TYPE_OPEN e SECURITY_TYPE_WEP (Android 12+)
const SECURITY_TYPE_OPEN = 0;
const SECURITY_TYPE_WEP = 1;

const STANDARD_24 = new Set([1, 6, 11]);
const BAND_NAME = { '2.4': '2,4 GHz', 5: '5 GHz', 6: '6 GHz' };
const BAND_SLUG = { '2.4': '24', 5: '5', 6: '6' };
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, good: 3 };

const ACTION = {
  channels: { label: 'Ver canais', kind: 'open-channels' },
  best: { label: 'Ver a melhor rede', kind: 'open-best' },
  wifi: { label: 'Abrir o Wi-Fi do celular', kind: 'open-settings-wifi' },
  map: { label: 'Ver o mapa do sinal', kind: 'open-map' },
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const quoted = (ssid) => (typeof ssid === 'string' && ssid !== '' ? `“${ssid}”` : 'a rede oculta');
const rssiOf = (ap) => (isNum(ap.rssiSmooth) ? ap.rssiSmooth : isNum(ap.rssi) ? ap.rssi : null);

/** O Android entrega o nome entre aspas em algumas versões; "<unknown ssid>" = não informou. */
function cleanSsid(ssid) {
  if (typeof ssid !== 'string') return '';
  const s = ssid.length >= 2 && ssid.startsWith('"') && ssid.endsWith('"') ? ssid.slice(1, -1) : ssid;
  return s === '<unknown ssid>' ? '' : s;
}

// Os textos de security.js para rede aberta e WEP, para quando só a conexão informa a segurança
// (assim as frases não são escritas em dois lugares).
function securityIssue(code) {
  const sample = code === 'wep' ? '[WEP][ESS]' : '[ESS]';
  return parseCapabilities(sample).issues.find((i) => i.code === code) || null;
}

// ---------------------------------------------------------------------------
// Os fatos: tudo o que as regras consultam, calculado uma vez
// ---------------------------------------------------------------------------

function gather(input) {
  const list = [];
  for (const item of Array.isArray(input.aps) ? input.aps : []) if (isObj(item)) list.push(asAp(item));

  const connection = isObj(input.connection) ? input.connection : null;
  const conn = connection !== null && connection.connected === true ? connection : null;
  const curId = conn ? normalizeBssid(conn.bssid) : '';
  const cur = curId ? list.find((ap) => ap.id === curId) || null : null;

  const devices = groupByDevice(list);
  const deviceOf = new Map();
  for (const device of devices) for (const ap of device.aps) deviceOf.set(ap, device.id);
  const ownDevice = cur ? devices.find((d) => d.aps.includes(cur)) || null : null;
  const ownAps = ownDevice ? ownDevice.aps.slice() : cur ? [cur] : [];
  const net = cur && !cur.hidden ? groupBySsid(list, { devices }).find((n) => n.aps.includes(cur)) || null : null;
  const mates = net ? net.aps.filter((ap) => ap !== cur) : [];

  const device = isObj(input.device) ? input.device : null;
  const liveRssi = conn && isNum(conn.rssi) && conn.rssi < 0 && conn.rssi > INVALID_RSSI ? conn.rssi : null;
  const name = cur && !cur.hidden ? cur.ssid : conn ? cleanSsid(conn.ssid) : '';

  let scoring = null;
  return {
    list,
    connection,
    conn,
    curId,
    cur,
    devices,
    deviceOf,
    ownAps,
    mates,
    device,
    client: clientProfile(device),
    status: isObj(input.status) ? input.status : null,
    name,
    // O sinal da conexão é lido a cada segundo; o da varredura pode ter meio minuto
    rssi: liveRssi ?? (cur ? rssiOf(cur) : null),
    band: cur ? cur.band : conn ? bandOf(conn.frequency) : null,
    /** Contexto de scoreAp, montado só se alguma regra precisar. */
    scoring() {
      if (scoring === null) scoring = scoringContext(list, { device, connectionBssid: curId });
      return scoring;
    },
  };
}

/** Um AP por faixa entre os rádios do roteador do usuário: o conectado, senão o da mesma rede, senão o mais forte. */
function ownRadios(f) {
  const out = [];
  for (const band of ['2.4', '5', '6']) {
    const here = f.ownAps.filter((ap) => ap.band === band && isNum(ap.channel));
    if (!here.length) continue;
    const rank = (ap) => (ap === f.cur ? 3 : !ap.hidden && ap.ssid === f.name ? 2 : ap.hidden ? 0 : 1);
    here.sort((a, b) => rank(b) - rank(a) || (rssiOf(b) ?? -Infinity) - (rssiOf(a) ?? -Infinity) || (a.id < b.id ? -1 : 1));
    out.push(here[0]);
  }
  return out;
}

const hasIssue = (ap, code) => isObj(ap.security) && Array.isArray(ap.security.issues) && ap.security.issues.find((i) => isObj(i) && i.code === code);

// ---------------------------------------------------------------------------
// As regras, na ordem em que aparecem dentro de cada gravidade
// ---------------------------------------------------------------------------

/** Segurança fraca da rede em uso: aberta, WEP, WPA/TKIP. */
function weakSecurity(f) {
  if (!f.conn) return null;
  const table = {
    open: ['critical', 'Rede aberta: sem senha e sem criptografia', ' Se o roteador for seu, crie uma senha com WPA2 ou WPA3. Se for uma rede pública, evite bancos e compras enquanto estiver nela.'],
    wep: ['critical', 'Segurança quebrada (WEP)', ''],
    'tkip-only': ['critical', 'Segurança fraca (WPA/TKIP)', ''],
    'tkip-mixed': ['warning', 'Modo antigo WPA/TKIP ainda ligado', ''],
    'owe-transition': ['warning', 'Rede aberta em modo de transição', ''],
  };
  let issue = null;
  if (f.cur && isObj(f.cur.security) && f.cur.security.known === true) {
    issue = (Array.isArray(f.cur.security.issues) ? f.cur.security.issues : []).find((i) => isObj(i) && table[i.code]) || null;
  } else if (f.conn.securityType === SECURITY_TYPE_OPEN) {
    issue = securityIssue('open');
  } else if (f.conn.securityType === SECURITY_TYPE_WEP) {
    issue = securityIssue('wep');
  }
  if (!issue) return null;
  const [severity, title, extra] = table[issue.code];
  return { id: 'weak-security', severity, title, text: `${issue.text}${extra}` };
}

/** Sinal fraco na conexão atual. */
function weakSignal(f) {
  if (!f.conn || !isNum(f.rssi)) return null;
  const level = signalLevel(f.rssi);
  if (level.key !== 'weak' && level.key !== 'very-weak') return null;
  const critical = level.key === 'very-weak';
  const effect = critical
    ? `Abaixo de ${formatDbm(VERY_WEAK_BELOW_DBM)} a conexão fica instável e pode cair a qualquer momento.`
    : `Abaixo de ${formatDbm(WEAK_BELOW_DBM)} a internet fica lenta e sujeita a travadas, por mais rápido que seja o plano.`;
  return {
    id: 'weak-signal',
    severity: critical ? 'critical' : 'warning',
    title: `Sinal ${level.label.toLowerCase()} aqui (${formatDbm(f.rssi)})`,
    text: `A sua rede chega neste ponto com ${formatDbm(f.rssi)}. ${effect} Chegue mais perto do roteador ou veja no mapa onde o sinal cai.`,
    action: ACTION.map,
  };
}

/** Outro ponto de acesso da mesma rede bem mais forte (o celular "grudou" no distante). */
function strongerAp(f) {
  if (!f.cur) return null;
  const base = rssiOf(f.cur); // compara varredura com varredura: mesma medida, mesmo instante
  if (base === null || base > ROAM_BELOW_DBM) return null;
  const home = f.deviceOf.get(f.cur);
  let best = null;
  for (const ap of f.mates) {
    const rssi = rssiOf(ap);
    if (rssi === null || f.deviceOf.get(ap) === home || !f.client.supports(ap.band)) continue;
    if (best === null || rssi > rssiOf(best)) best = ap;
  }
  if (best === null || rssiOf(best) - base < ROAM_GAIN_DB) return null;
  const where = BAND_NAME[best.band] && best.band !== f.cur.band ? `, em ${BAND_NAME[best.band]}` : '';
  return {
    id: 'stronger-ap',
    severity: 'warning',
    title: 'Há um ponto de acesso mais forte da sua rede',
    text:
      `Outro ponto de acesso da rede ${quoted(f.name)} chega aqui com ${formatDbm(rssiOf(best))}${where}: ` +
      `${Math.round(rssiOf(best) - base)} dB mais forte que o atual (${formatDbm(base)}). ` +
      'O celular costuma ficar preso ao primeiro em que entrou; desligue e ligue o Wi-Fi para ele escolher o mais forte.',
    action: ACTION.wifi,
  };
}

/** Conectado em 2,4 GHz com a mesma rede (ou o mesmo roteador) chegando bem em 5/6 GHz. */
function bandUpgrade(f) {
  if (!f.conn || f.band !== '2.4') return null;
  let pool;
  if (f.cur) pool = [...f.ownAps, ...f.mates];
  else if (f.name) pool = f.list.filter((ap) => !ap.hidden && ap.ssid === f.name);
  else return null;

  const stem = ssidStem(f.name);
  const mine = (ap) => !ap.hidden && f.name !== '' && (ap.ssid === f.name || (stem !== null && ssidStem(ap.ssid) === stem));
  const candidates = [...new Set(pool)].filter(
    (ap) =>
      (ap.band === '5' || ap.band === '6') &&
      mine(ap) &&
      rssiOf(ap) !== null &&
      rssiOf(ap) >= GOOD_SIGNAL_DBM &&
      f.client.supports(ap.band) &&
      !(isInsecure(ap.security) && !(f.cur && isInsecure(f.cur.security))),
  );
  if (!candidates.length) return null;

  const context = f.scoring();
  const scored = candidates.map((ap) => ({ ap, result: scoreAp(ap, { context }) })).filter((x) => x.result.detail.usable);
  scored.sort((a, b) => b.result.score - a.result.score || rssiOf(b.ap) - rssiOf(a.ap));
  const pick = scored[0];
  if (!pick) return null;

  let gain = null;
  if (f.cur) {
    const now = scoreAp(f.cur, { context });
    // A outra faixa só é sugerida se render mais (ela pode estar mais disputada que a atual)
    if (!(pick.result.score > now.score)) return null;
    if (isNum(now.estMbps) && now.estMbps > 0) gain = pick.result.estMbps / now.estMbps;
  }

  const band = BAND_NAME[pick.ap.band];
  const sameBox = f.cur !== null && f.deviceOf.get(pick.ap) === f.deviceOf.get(f.cur);
  const sameName = pick.ap.ssid === f.name;
  const who = sameBox ? 'o mesmo roteador' : 'a sua rede';
  const level = signalLevel(rssiOf(pick.ap)).label.toLowerCase();
  const speed =
    gain !== null && gain >= GAIN_WORTH_SAYING
      ? ` Ela deve render ${timesMore(gain)} (perto de ${formatSpeed(pick.result.estMbps)}).`
      : '';
  const how = sameName
    ? ' O nome é o mesmo, então quem escolhe a faixa é o celular: desligue e ligue o Wi-Fi para ele escolher de novo.'
    : ` Conecte-se à rede ${quoted(pick.ap.ssid)} nas configurações de Wi-Fi.`;
  return {
    id: 'band-upgrade',
    severity: 'warning',
    title: `Você está em 2,4 GHz com ${band} à disposição`,
    text: `O celular está na faixa de 2,4 GHz, mas ${who} também tem ${band} chegando aqui com ${formatDbm(rssiOf(pick.ap))} (sinal ${level}).${speed}${how}`,
    action: ACTION.wifi,
  };
}

/** Canal do roteador: fora do padrão em 2,4 GHz, ou congestionado com um bem melhor disponível. */
function channelProblems(f) {
  const out = [];
  for (const ap of ownRadios(f)) {
    const rec = recommendChannel(f.list, { band: ap.band, own: ap });
    if (!rec.current || !rec.best) continue;
    const now = Math.round(rec.current.score);
    const then = Math.round(rec.best.score);
    const inUse = f.cur !== null && f.cur.band === ap.band;

    if (ap.band === '2.4' && ap.channel <= 13 && !STANDARD_24.has(ap.channel)) {
      const why =
        `Em 2,4 GHz só os canais 1, 6 e 11 não se sobrepõem. No canal ${ap.channel}, seu roteador atrapalha quem usa os canais dos dois lados ` +
        `e é atrapalhado por eles${rec.current.overlapping > 0 ? ` (${plural(rec.current.overlapping, 'rede', 'redes')} agora)` : ''}.`;
      if (rec.verdict === 'change') {
        out.push({
          id: 'nonstandard-channel',
          severity: 'warning',
          title: `Roteador no canal ${ap.channel}, fora do padrão`,
          text: `${why} Mude para o canal ${rec.best.channel} nas configurações do roteador (nota do canal: ${now} hoje, ${then} no canal ${rec.best.channel}, de 100).`,
          action: ACTION.channels,
        });
      } else {
        out.push({
          id: 'nonstandard-channel',
          severity: 'info',
          title: `Roteador no canal ${ap.channel}, fora do padrão`,
          text: `${why} Hoje os canais padrão estão piores que o seu (nota ${then} contra ${now}, de 100), então não há pressa em trocar.`,
          action: ACTION.channels,
        });
      }
      continue;
    }
    if (rec.verdict !== 'change' || rec.current.score > CROWDED_MAX_SCORE) continue;
    out.push({
      id: `crowded-channel-${BAND_SLUG[ap.band]}`,
      // a faixa em que o celular está pesa mais; a outra é só um lembrete
      severity: inUse ? 'warning' : 'info',
      title: `Canal ${ap.channel} disputado em ${BAND_NAME[ap.band]}`,
      text: `${rec.text} Nota do canal atual: ${now} de 100; do canal ${rec.best.channel}: ${then}. A troca é feita nas configurações do roteador.`,
      action: ACTION.channels,
    });
  }
  return out;
}

/** 40 MHz em 2,4 GHz com vizinhos por perto. */
function wideChannel24(f) {
  const ap = ownRadios(f).find((x) => x.band === '2.4');
  if (!ap || ap.widthMHz !== 40) return null;
  if (recommendWidth(f.list, '2.4', { own: ap }).widthMHz !== 20) return null;
  const neighbours = f.list.filter((x) => x.band === '2.4' && !f.ownAps.includes(x) && isNum(x.rssi)).length;
  const channels = Array.isArray(ap.occ.channels) && ap.occ.channels.length > 1 ? `canais ${ap.occ.channels.join(' + ')}` : `canal ${ap.channel}`;
  return {
    id: 'wide-channel-24',
    severity: 'warning',
    title: 'Canal de 40 MHz em 2,4 GHz',
    text:
      `Seu roteador usa 40 MHz em 2,4 GHz (${channels}), mais da metade da faixa. Com ${plural(neighbours, 'rede vizinha', 'redes vizinhas')} por perto, ` +
      'isso aumenta a interferência para todo mundo e costuma deixar a conexão mais lenta, não mais rápida. Mude a largura do canal para 20 MHz nas configurações do roteador.',
    action: ACTION.channels,
  };
}

/** Muitos aparelhos ou canal muito ocupado, segundo o próprio roteador (BSS Load). */
function busyAp(f) {
  if (!f.cur) return null;
  let stations = null;
  let utilization = null;
  // As redes do mesmo rádio (principal, convidados) dividem o transmissor: a carga é a soma
  for (const ap of f.ownAps) {
    if (ap !== f.cur && ap.freq !== f.cur.freq) continue;
    if (isNum(ap.stations)) stations = (stations ?? 0) + ap.stations;
    if (isNum(ap.utilization)) utilization = Math.max(utilization ?? 0, ap.utilization);
  }
  const crowded = stations !== null && stations >= MANY_STATIONS;
  const busy = utilization !== null && utilization >= HIGH_UTILIZATION;
  if (!crowded && !busy) return null;
  const facts = [];
  if (stations !== null) facts.push(`${plural(stations, 'aparelho conectado', 'aparelhos conectados')} neste rádio`);
  if (utilization !== null) facts.push(`o canal ocupado ${pct(utilization)} do tempo`);
  const advice = busy
    ? `Acima de ${pct(HIGH_UTILIZATION)} a rede já responde devagar; a medida inclui o seu próprio uso, então confira de novo com o celular parado.`
    : `A partir de uns ${MANY_STATIONS} aparelhos por rádio um roteador doméstico começa a engasgar; passar alguns para a outra faixa alivia.`;
  return {
    id: 'busy-ap',
    severity: 'warning',
    title: busy ? `Canal ocupado ${pct(utilization)} do tempo` : `${stations} aparelhos no mesmo ponto de acesso`,
    text: `O roteador informa ${facts.join(' e ')}. ${advice}`,
    action: ACTION.channels,
  };
}

/** Geração (4..7) de um WIFI_STANDARD_* da conexão, ou null. */
function genOfStandard(code) {
  const gen = standardInfo(code).gen;
  return isNum(gen) && gen >= 4 ? gen : null;
}

/** Taxa do enlace muito abaixo do que o sinal permite. */
function slowLink(f) {
  const c = f.conn;
  const cur = f.cur;
  if (!c || !cur || !isNum(f.rssi) || f.rssi < SLOW_LINK_MIN_DBM) return null;
  // WEP e TKIP travam o enlace em 54 Mb/s: o aviso de segurança já conta essa história
  if (hasIssue(cur, 'wep') || hasIssue(cur, 'tkip-only')) return null;
  const positive = (x) => (isNum(x) && x > 0 ? x : null);
  const tx = positive(c.txSpeed) ?? positive(c.linkSpeed);
  const rx = positive(c.rxSpeed);
  const maxTx = positive(c.maxTxSpeed);
  const maxRx = positive(c.maxRxSpeed);
  if (tx === null && rx === null) return null;

  // Com o teto negociado (Android 11+) a comparação é com a conexão de verdade. Sem ele, o
  // esperado é o do celular mais modesto que existe (Wi-Fi 4, 1 fluxo, 20 MHz em 2,4 GHz e
  // 40 MHz no resto), para não acusar um aparelho simples de estar lento.
  const negotiated = (tx !== null && maxTx !== null) || (rx !== null && maxRx !== null);
  const standard = genOfStandard(c.wifiStandard);
  const link = estimateLink({
    rssi: f.rssi,
    band: cur.band,
    widthMHz: cur.widthMHz,
    apGen: isNum(cur.gen) ? cur.gen : undefined,
    apNss: isNum(cur.nss) ? cur.nss : undefined,
    clientGen: negotiated ? (standard ?? f.client.gen ?? undefined) : (standard ?? MODEST_GEN),
    clientNss: negotiated ? f.client.nss : 1,
    clientMaxWidthMHz: negotiated ? f.client.maxWidthMHz[cur.band] : cur.band === '2.4' ? 20 : MODEST_WIDTH_MHZ,
  });
  if (!isNum(link.phyMbps) || !isNum(link.maxPhyMbps) || link.maxPhyMbps <= 0 || link.unstable) return null;
  const fraction = link.phyMbps / link.maxPhyMbps; // quanto do teto este sinal sustenta

  const pairs = []; // [medido, esperado] por direção
  if (negotiated) {
    if (tx !== null && maxTx !== null) pairs.push([tx, maxTx * fraction]);
    if (rx !== null && maxRx !== null) pairs.push([rx, maxRx * fraction]);
  } else {
    if (tx !== null) pairs.push([tx, link.phyMbps]);
    if (rx !== null) pairs.push([rx, link.phyMbps]);
  }
  // Uma direção baixa sozinha é normal (o celular parado transmite pouco): só vale se todas estiverem
  if (!pairs.length || !pairs.every(([actual, expected]) => actual < expected * SLOW_LINK_RATIO)) return null;
  const [actual, expected] = pairs.reduce((best, p) => (p[0] > best[0] ? p : best));
  return {
    id: 'slow-link',
    severity: 'warning',
    title: 'Conexão mais lenta do que o sinal permite',
    text:
      `O celular e o roteador estão conversando a ${Math.round(actual)} Mb/s, mas com este sinal (${formatDbm(f.rssi)}) o normal seria perto de ${formatSpeed(expected)}. ` +
      'Quando a taxa fica tão abaixo do que o sinal permite, quase sempre é interferência de outras redes no canal. Veja se há um canal mais livre.',
    action: ACTION.channels,
  };
}

/** WPS ligado no roteador do usuário. */
function wpsOn(f) {
  for (const ap of f.cur ? [f.cur, ...f.ownAps] : []) {
    const issue = hasIssue(ap, 'wps');
    if (!issue) continue;
    const locked = issue.severity === 'low';
    return {
      id: 'wps-on',
      severity: locked ? 'info' : 'warning',
      title: locked ? 'WPS ligado (PIN travado)' : 'WPS ligado no roteador',
      text: `${issue.text} A opção costuma se chamar "WPS" ou "QSS" nas configurações do roteador.`,
    };
  }
  return null;
}

/** Sem PMF (802.11w): só uma nota. */
function noPmf(f) {
  const issue = f.cur ? hasIssue(f.cur, 'no-pmf') : null;
  if (!issue) return null;
  return {
    id: 'no-pmf',
    severity: 'info',
    title: 'Sem proteção contra desconexão forçada (PMF)',
    text: `${issue.text} Se o roteador tiver a opção "PMF" ou "802.11w", deixe em "opcional"; o WPA3 já vem com ela.`,
  };
}

/** Taxas do 802.11b ligadas: os avisos da rede saem a 1 Mb/s e tomam tempo de todos. */
function legacy11b(f) {
  const ap = [f.cur, ...f.ownAps].find((x) => x && x.band === '2.4' && isObj(x.ie) && x.ie.legacy11b === true);
  if (!ap) return null;
  let rate = null;
  const info = parseIes(ap.raw && ap.raw.ies);
  if (isObj(info.rates) && isNum(info.rates.minBasicRate)) rate = info.rates.minBasicRate;
  const at = rate !== null ? ` a ${String(rate).replace('.', ',')} Mb/s` : ' na taxa mais lenta';
  return {
    id: 'legacy-11b',
    severity: 'info',
    title: 'Modo 802.11b ligado no roteador',
    text:
      `O roteador ainda aceita aparelhos 802.11b (padrão de 1999) e por isso transmite os avisos da rede${at}. ` +
      'Isso toma tempo do canal de todos os aparelhos, inclusive dos novos. Se não há nada tão antigo em casa, escolha o modo "802.11g/n" (ou mais novo) nas configurações do roteador.',
  };
}

/** Canal DFS: bom porque é vazio, mas o roteador pode sair do ar ao ver um radar. */
function dfsChannel(f) {
  const ap = ownRadios(f).find((x) => x.band === '5');
  if (!ap || !isObj(ap.occ) || ap.occ.dfs !== true) return null;
  const channels = Array.isArray(ap.occ.channels) ? ap.occ.channels : [];
  const primaryIsDfs = isDfs(ap.freq, 20);
  const what =
    channels.length > 1
      ? `os canais ${channels[0]} a ${channels[channels.length - 1]} (${ap.widthMHz} MHz, com o principal no ${ap.channel})`
      : `o canal ${ap.channel}`;
  return {
    id: 'dfs-channel',
    severity: 'info',
    title: primaryIsDfs ? `Canal ${ap.channel} divide a faixa com radares (DFS)` : `Canal de ${ap.widthMHz} MHz pega um trecho de radares (DFS)`,
    text:
      `Seu roteador usa ${what} em 5 GHz, num trecho dividido com radares (DFS). Esses canais costumam ser vazios, o que é bom; ` +
      'em troca, se o roteador perceber um radar ele muda de canal sozinho e a rede pode sumir por cerca de um minuto. ' +
      'Se a conexão cair sem motivo de vez em quando, experimente um canal sem DFS (36 a 48 ou 149 a 161).',
    action: ACTION.channels,
  };
}

/** Nome da rede oculto: não protege nada. */
function hiddenSsid(f) {
  if (!f.conn) return null;
  if (f.conn.hidden !== true && !(f.cur && f.cur.hidden === true)) return null;
  return {
    id: 'hidden-ssid',
    severity: 'info',
    title: 'Esconder o nome da rede não protege',
    text:
      'A sua rede está com o nome oculto. Qualquer analisador (este app, por exemplo) enxerga a rede do mesmo jeito, e os seus aparelhos passam a ' +
      'chamá-la pelo nome em todo lugar, o que gasta bateria e revela o nome a quem estiver ouvindo. O que protege é a senha com WPA2 ou WPA3.',
  };
}

/** Roteador só Wi-Fi 4 (ou mais antigo). */
function oldRouter(f) {
  const cur = f.cur;
  if (!cur || !isNum(cur.gen) || cur.gen > 4) return null;
  // geração "inferida" é palpite pelo canal e pela largura: não serve de prova
  if (cur.genSource !== 'android' && cur.genSource !== 'ies') return null;
  const stem = ssidStem(cur.ssid);
  const family = (ap) => ap !== cur && (f.ownAps.includes(ap) || f.mates.includes(ap) || (stem !== null && ssidStem(ap.ssid) === stem));
  const kin = f.list.filter(family);
  if (kin.some((ap) => isNum(ap.gen) && ap.gen >= 5)) return null;

  let hedge = '';
  if (cur.band === '2.4' && !kin.some((ap) => ap.band === '5' || ap.band === '6')) {
    // Em 2,4 GHz até um roteador Wi-Fi 5 aparece como Wi-Fi 4 (o 802.11ac só existe em 5 GHz).
    // Só dá para concluir se o celular enxergaria o rádio de 5 GHz e mesmo assim não há nenhum.
    if (f.client.bands.b5 !== true) return null;
    if (!(isNum(cur.rssi) && cur.rssi >= WIFI4_MIN_DBM)) return null;
    hedge = ' e, pelo que o celular enxerga daqui, só funciona em 2,4 GHz';
  }
  const legacy = cur.gen < 4;
  const top = maxRate({ gen: cur.gen, widthMHz: cur.widthMHz, nss: isNum(cur.nss) ? cur.nss : 2, band: cur.band });
  const ceiling = isNum(top) ? ` Nesta configuração a taxa máxima é de ${Math.round(top)} Mb/s, e isso com sinal perfeito.` : '';
  return {
    id: 'old-router',
    severity: 'info',
    title: legacy ? 'Roteador muito antigo (anterior ao Wi-Fi 4)' : 'Roteador de geração antiga (Wi-Fi 4)',
    text:
      `Seu roteador é ${legacy ? `de um padrão anterior ao Wi-Fi 4 (${cur.ieee || '802.11a/b/g'})` : 'Wi-Fi 4 (802.11n, de 2009)'}${hedge}.${ceiling} ` +
      'Um roteador Wi-Fi 6 rende várias vezes mais no mesmo lugar e lida melhor com muitos aparelhos ao mesmo tempo.',
  };
}

/** O celular não alcança 5 GHz / 6 GHz. */
function phoneBands(f) {
  const out = [];
  if (f.client.bands.b5 === false) {
    out.push({
      id: 'phone-no-5ghz',
      severity: 'info',
      title: 'Este celular só usa 2,4 GHz',
      text:
        'O Wi-Fi deste celular não alcança a faixa de 5 GHz. Por isso as redes de 5 GHz, mais rápidas e menos disputadas, não aparecem nas listas, ' +
        'nos canais nem no mapa, mesmo que o seu roteador tenha uma.',
    });
  }
  if (f.client.bands.b6 === false) {
    // Sem 6 GHz o celular não ouve essas redes; quem conta que elas existem são os roteadores,
    // que anunciam o próprio rádio de 6 GHz nos beacons das outras faixas (Reduced Neighbor Report).
    const announced = new Map(); // BSSID de 6 GHz -> {channel, own}
    for (const ap of f.list) {
      const colocated = isObj(ap.ie) && Array.isArray(ap.ie.colocated) ? ap.ie.colocated : [];
      for (const c of colocated) {
        if (!isObj(c) || c.band !== '6' || typeof c.bssid !== 'string') continue;
        const known = announced.get(c.bssid);
        const own = f.ownAps.includes(ap);
        if (!known || (own && !known.own)) announced.set(c.bssid, { channel: c.channel, own });
      }
    }
    if (announced.size > 0) {
      const mine = [...announced.values()].find((x) => x.own);
      out.push({
        id: 'phone-no-6ghz',
        severity: 'info',
        title: 'Este celular não alcança os 6 GHz',
        text: mine
          ? `Seu roteador também tem uma rede em 6 GHz${isNum(mine.channel) ? ` (canal ${mine.channel})` : ''}, a faixa mais rápida e mais vazia, mas este celular não funciona nela: ele fica em 2,4 e 5 GHz, e a rede de 6 GHz não aparece no app.`
          : `Há ${plural(announced.size, 'rede', 'redes')} de 6 GHz por perto (os roteadores vizinhos anunciam), mas este celular não funciona nessa faixa: elas não aparecem nas listas nem nos canais.`,
      });
    }
  }
  return out;
}

/** O Android está limitando as varreduras. */
function scanThrottled(f) {
  if (!f.status || f.status.throttled !== true) return null;
  return {
    id: 'scan-throttled',
    severity: 'info',
    title: 'O Android está limitando as buscas',
    text:
      'O Android só deixa cada app procurar redes 4 vezes a cada 2 minutos; por isso a lista e o mapa demoram a atualizar. Para liberar: ' +
      'Configurações > Sistema > Opções do desenvolvedor > Redes > desligue "Limitar busca por Wi-Fi". ' +
      'Se as Opções do desenvolvedor não aparecem, vá em Configurações > "Sobre o dispositivo" (ou "Sobre o telefone") e toque 7 vezes em "Número da versão".',
  };
}

/** Sem conexão não há o que diagnosticar: aponta para a tela que escolhe a rede. */
function notConnected(f) {
  if (!f.connection || f.connection.connected !== false) return null;
  return {
    id: 'not-connected',
    severity: 'info',
    title: 'Você não está conectado ao Wi-Fi',
    text: 'O diagnóstico da conexão aparece quando o celular entra em uma rede. Enquanto isso, veja qual rede deve render mais neste ponto.',
    action: ACTION.best,
  };
}

/** Nenhum problema: uma frase boa, com os números que provam. */
function allGood(f) {
  if (!f.conn || !isNum(f.rssi)) return null;
  const facts = [`sinal ${signalLevel(f.rssi).label.toLowerCase()} (${formatDbm(f.rssi)})`];
  if (BAND_NAME[f.band]) facts.push(`faixa de ${BAND_NAME[f.band]}`);
  if (f.cur && isObj(f.cur.security) && f.cur.security.known === true && typeof f.cur.security.label === 'string') {
    facts.push(`segurança ${f.cur.security.label}`);
  }
  const net = f.name !== '' ? `A rede ${quoted(f.name)}` : 'A sua rede';
  return {
    id: 'all-good',
    severity: 'good',
    title: 'Tudo certo com a sua conexão',
    text: `${net} está bem neste ponto: ${facts.join(', ')}. Não encontrei nada que precise de ajuste.`,
  };
}

// A ordem aqui é a ordem dentro de cada gravidade: primeiro o que mais afeta a pessoa agora.
const RULES = [
  weakSecurity,
  weakSignal,
  strongerAp,
  bandUpgrade,
  channelProblems,
  wideChannel24,
  busyAp,
  slowLink,
  wpsOn,
  notConnected,
  oldRouter,
  legacy11b,
  dfsChannel,
  noPmf,
  hiddenSsid,
  phoneBands,
  scanThrottled,
];

const KINDS = new Set(['open-channels', 'open-best', 'open-settings-wifi', 'open-map', 'none']);

function tidy(insight) {
  if (!isObj(insight) || typeof insight.id !== 'string' || !(insight.severity in SEVERITY_ORDER)) return null;
  const out = { id: insight.id, severity: insight.severity, title: String(insight.title), text: String(insight.text) };
  if (isObj(insight.action) && KINDS.has(insight.action.kind)) out.action = { label: String(insight.action.label), kind: insight.action.kind };
  return out;
}

/**
 * Diagnóstico da situação atual.
 *
 * @param {{aps?: import('./model.js').Ap[], connection?: import('../bridge.js').Connection,
 *          device?: import('../bridge.js').DeviceInfo, status?: import('../bridge.js').Status}} input
 *        aps = lista do ApTracker/store (ou ScanAp crus); o resto vem direto da ponte
 * @returns {Insight[]}  do mais grave para o mais leve ('critical', 'warning', 'info', 'good').
 *          O aviso 'good' (id 'all-good') só aparece, sozinho ou junto de notas 'info', quando
 *          há conexão com sinal medido e nenhum 'critical' ou 'warning'.
 *
 * Ids possíveis: weak-security, weak-signal, stronger-ap, band-upgrade, nonstandard-channel,
 * crowded-channel-24 | -5 | -6, wide-channel-24, busy-ap, slow-link, wps-on, not-connected,
 * old-router, legacy-11b, dfs-channel, no-pmf, hidden-ssid, phone-no-5ghz, phone-no-6ghz,
 * scan-throttled, all-good.
 */
export function buildInsights(input) {
  let facts;
  try {
    facts = gather(isObj(input) ? input : {});
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const add = (item) => {
    const insight = tidy(item);
    if (insight === null || seen.has(insight.id)) return;
    seen.add(insight.id);
    out.push(insight);
  };
  for (const rule of RULES) {
    try {
      const result = rule(facts);
      for (const item of Array.isArray(result) ? result : [result]) add(item);
    } catch {
      // dado fora do formato: esta regra fica sem dizer nada
    }
  }
  if (!out.some((i) => i.severity === 'critical' || i.severity === 'warning')) {
    try {
      add(allGood(facts));
    } catch {
      // sem a frase boa
    }
  }
  // sort é estável: dentro da mesma gravidade vale a ordem das regras
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
