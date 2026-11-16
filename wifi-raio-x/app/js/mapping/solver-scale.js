// Tamanho do mapa x distâncias medidas pelo usuário ("Ajustar a escala").
//
//   mapSpan(x, y)             -> { cx, cy, radius, diameter, span }   quanto cabe no mapa, de ponta a ponta
//   fuseScale(span, metros[]) -> { factor, weight, sd, used, ignored } quanto o mapa deve crescer
//
// Módulo pequeno e sem dependências de propósito: o solucionador usa (applyKnownDistances em
// solver.js) e a tela de resultado também (para dizer, antes de refazer o mapa, se a medida vai
// mudar alguma coisa), sem carregar os motores na página.
//
// O QUE FOI MEDIDO (232 levantamentos simulados: os de tests/mapping/map-eval.mjs — dev, val e conf
// — e mais 48 com sementes próprias; em 140 deles a pessoa para em lugares marcados):
//
// 1. A distância entre dois lugares NO MAPA não serve de régua. Cada posição erra cerca de meio
//    raio do mapa; entre dois lugares distantes de verdade, a distância do mapa erra ±30 a 37%
//    (em ln) em torno da escala do próprio mapa — pior que a escala que o solucionador já tem
//    (±24%). E ela é enviesada pela escolha do par: os dois lugares mais distantes NO MAPA saem
//    25 a 33% compridos demais (escolher o máximo de uma medida ruidosa); os dois mais distantes
//    DE VERDADE saem 30% curtos. Numa regressão direta do tamanho real contra as duas grandezas,
//    a distância do par no mapa ganha peso ~0. Por isso ela NÃO entra na conta do tamanho.
// 2. O que serve de régua é o tamanho do mapa INTEIRO, que é a média de muitos pontos. A casa, de
//    ponta a ponta (a maior distância entre dois lugares visitados), mede de 3,0 a 3,4 vezes o raio
//    quadrático médio das varreduras (3,02 ± 0,14 parando em pontos; 3,35 ± 0,20 andando; 9 em 10
//    abaixo de 3,6), e o diâmetro do mapa acompanha o da casa na mesma escala da nuvem (± 9%).
// 3. Então uma distância medida entre dois lugares quaisquer dá um TETO para o tamanho do mapa: ela
//    não pode ser maior que a casa de ponta a ponta. Se não cabe no mapa, o mapa está pequeno e
//    cresce até ela caber. Se cabe, ela não diz se o mapa está certo ou pequeno (os dois lugares
//    podem simplesmente não ser os mais distantes) e o mapa fica como está. O ajuste nunca encolhe
//    o mapa: para isso seria preciso saber que o par vai mesmo de uma ponta à outra da casa, e nem
//    o mapa nem a medida dizem isso.
//
// A CONTA. s = ln(tamanho do mapa / tamanho real). Sem medida, s ~ N(0, SCALE_PRIOR_SD²): o que o
// solucionador acha, com o erro que a bancada mostra. Cada medida d multiplica essa crença pela
// chance de d caber na casa: Φ((ln(span / d) − s) / SPAN_EDGE), onde span é o comprimento do mapa
// de ponta a ponta e SPAN_EDGE a incerteza desse comprimento mais o erro de quem mede. A resposta é
// o s mais provável (a moda): 0 enquanto a medida cabe, logo abaixo do teto quando não cabe. Com
// várias medidas manda a mais comprida: a incerteza do teto é a do comprimento do mapa, a mesma
// para todas, e multiplicar uma chance por medida contaria essa incerteza várias vezes (medido: com
// as duas maiores distâncias da casa o mapa passava 3% do ponto). `weight` é a parte da incerteza
// de antes que a medida tirou (0 = nenhuma, perto de 1 = o tamanho passou a vir da medida).
//
// Resultado na bancada (erro médio do tamanho, |mapa/real − 1|; antes -> depois, uma distância
// exata): par proposto pela tela 0,17 -> 0,12 a 0,13; os dois lugares mais distantes de verdade
// 0,17 -> 0,06; um par qualquer 0,17 -> 0,16; um par curto (2 a 4 m) não muda nada. Nos mapas que
// saíram mais de 20% pequenos (escritório, casa grande): 0,29 -> 0,17 a 0,22 com o par proposto e
// 0,06 com o par certo. Em nenhuma família de casas o erro médio piorou.

/** Desvio-padrão (em ln) do tamanho do mapa em torno do real quando não há medida nenhuma. */
export const SCALE_PRIOR_SD = 0.24;
/**
 * A casa de ponta a ponta, em raios quadráticos médios das varreduras: o maior valor típico da
 * bancada. Maior que o real na maioria das casas, de propósito: errar para cima só deixa o ajuste
 * mais tímido; errar para baixo esticaria um mapa que estava certo.
 */
export const SPAN_RADII = 3.4;
/** Folga do teto, em ln: incerteza do comprimento do mapa (0,09) somada ao erro de quem mede (trena ou passos: ~0,05). */
export const SPAN_EDGE = 0.1;
/** Medida que pede um mapa mais do que isto maior contradiz o mapa: erro de digitação ou lugares trocados. Não entra. */
export const SCALE_MAX_FACTOR = 2;
/** Mudança de tamanho menor que isto (0,5%) não é aplicada: o mapa fica exatamente como estava. */
export const SCALE_MIN_CHANGE = 0.005;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Quanto cabe no mapa de ponta a ponta. `diameter` é a maior distância entre dois pontos (só os
 * vértices do fecho convexo precisam ser comparados); `span` é o que vale como comprimento da casa
 * na escala do mapa: o maior entre o diâmetro e SPAN_RADII raios — das duas estimativas, a que
 * menos mexe no mapa. Pontos que não são números ficam de fora.
 *
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @returns {{cx:number, cy:number, radius:number, diameter:number, span:number}}  tudo 0 sem pontos
 */
export function mapSpan(x, y) {
  const pts = [];
  const n = Math.min(x ? x.length : 0, y ? y.length : 0);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    if (!isNum(x[i]) || !isNum(y[i])) continue;
    pts.push([x[i], y[i]]);
    cx += x[i];
    cy += y[i];
  }
  if (!pts.length) return { cx: 0, cy: 0, radius: 0, diameter: 0, span: 0 };
  cx /= pts.length;
  cy /= pts.length;
  let r2 = 0;
  for (const p of pts) r2 += (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy);
  const radius = Math.sqrt(r2 / pts.length);
  // Fecho convexo (cadeia monótona de Andrew) e a maior distância entre dois vértices dele.
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull = [];
  for (let pass = 0; pass < 2; pass++) {
    const start = hull.length;
    for (let k = 0; k < pts.length; k++) {
      const p = pass === 0 ? pts[k] : pts[pts.length - 1 - k];
      while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
  }
  if (!hull.length) hull.push(pts[0]); // um ponto só (ou todos iguais)
  let d2 = 0;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const v = (hull[i][0] - hull[j][0]) * (hull[i][0] - hull[j][0]) + (hull[i][1] - hull[j][1]) * (hull[i][1] - hull[j][1]);
      if (v > d2) d2 = v;
    }
  }
  const diameter = Math.sqrt(d2);
  return { cx, cy, radius, diameter, span: Math.max(diameter, SPAN_RADII * radius) };
}

/** Normal padrão acumulada (Abramowitz & Stegun 26.2.17; erro absoluto < 1e-7). */
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = 0.3989422804014327 * Math.exp(-0.5 * z * z) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/** φ(z) / Φ(z): quanto o teto empurra o tamanho para baixo. Na cauda (z muito negativo) vale a fração contínua. */
function pushOf(z) {
  if (z < -4) {
    const t = -z;
    return t + 1 / (t + 2 / (t + 3 / (t + 4 / (t + 5 / t))));
  }
  return (0.3989422804014327 * Math.exp(-0.5 * z * z)) / phi(z);
}

/** ln Φ(z), estável na cauda. */
function logPhi(z) {
  if (z < -4) return -0.5 * z * z - Math.log(pushOf(z)) - 0.9189385332046727;
  return Math.log(phi(z));
}

/**
 * Funde o tamanho que o solucionador estimou com as distâncias medidas (ver o topo do arquivo).
 *
 * @param {number} span       comprimento do mapa de ponta a ponta (m), de mapSpan()
 * @param {number[]} meters   distâncias medidas (m), já no plano do piso
 * @param {{priorSd?: number, edge?: number, maxFactor?: number}} [options]
 * @returns {{factor:number, weight:number, sd:number, used:number, ignored:number}}
 *          factor: por quanto multiplicar o mapa (>= 1; exatamente 1 quando as medidas cabem nele);
 *          weight: 0..1, parte da incerteza do tamanho que as medidas tiraram;
 *          sd: incerteza (ln) do tamanho depois das medidas;
 *          used / ignored: medidas que entraram na conta / que contradizem o mapa ou não são números
 */
export function fuseScale(span, meters, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const tau = opts.priorSd > 0 ? opts.priorSd : SCALE_PRIOR_SD;
  const eps = opts.edge > 0 ? opts.edge : SPAN_EDGE;
  const maxFactor = opts.maxFactor > 1 ? opts.maxFactor : SCALE_MAX_FACTOR;
  const list = Array.isArray(meters) ? meters : [];
  let longest = 0; // a maior medida aceita: é ela que dá o teto
  let used = 0;
  let ignored = 0;
  if (isNum(span) && span > 0) {
    for (const d of list) {
      if (!isNum(d) || !(d > 0) || d > maxFactor * span) ignored++;
      else {
        used++;
        if (d > longest) longest = d;
      }
    }
  } else ignored = list.length;
  if (!used) return { factor: 1, weight: 0, sd: tau, used: 0, ignored };
  const top = Math.log(span / longest); // teto de s: a medida não pode ser maior que a casa

  // O s mais provável: a derivada do ln da crença só desce (a crença é log-côncava), então é uma
  // bisseção. Em s = 0 ela já é negativa (o teto sempre empurra para baixo, nem que seja um nada).
  const slope = (s) => -s / (tau * tau) - pushOf((top - s) / eps) / eps;
  let lo = -Math.log(maxFactor) - 6 * eps;
  let hi = 0;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (slope(mid) > 0) lo = mid;
    else hi = mid;
  }
  let factor = Math.exp(-0.5 * (lo + hi));
  if (!(factor > 1 + SCALE_MIN_CHANGE)) factor = 1;
  else if (factor > maxFactor) factor = maxFactor;

  // Incerteza que sobra: variância da crença, numa grade.
  const step = 0.01;
  let peak = -Infinity;
  const logs = [];
  for (let i = 0; i <= 240; i++) {
    const s = -1.6 + i * step;
    const v = (-s * s) / (2 * tau * tau) + logPhi((top - s) / eps);
    logs.push(v);
    if (v > peak) peak = v;
  }
  let z = 0;
  let m1 = 0;
  let m2 = 0;
  for (let i = 0; i < logs.length; i++) {
    const s = -1.6 + i * step;
    const q = Math.exp(logs[i] - peak);
    z += q;
    m1 += q * s;
    m2 += q * s * s;
  }
  const mean = m1 / z;
  const sd = Math.sqrt(Math.max(0, m2 / z - mean * mean));
  const weight = Math.min(1, Math.max(0, 1 - (sd * sd) / (tau * tau)));
  return { factor, weight, sd, used, ignored };
}
