// Porta de entrada do core: a API pública de todos os módulos de análise num lugar só.
//
//   import { ApTracker, rankNetworks, recommendChannel, buildInsights } from './core/index.js';
//
// Só reexporta (nomes soltos, sem `default`). O que cada função recebe e devolve está
// documentado no módulo de origem; a ordem abaixo é a do caminho dos dados: o que chega do
// celular (ScanAp, Connection e DeviceInfo de bridge.js) é normalizado em model.js e analisado
// pelos três últimos módulos. Um teste (tests/robustness.test.mjs) confere que nada exportado
// por um módulo ficou de fora daqui.
//
// Convenções que valem para tudo:
//   - nenhuma função lança exceção com dado torto: o que não der para entender vira null,
//     "desconhecido" ou nota 0, e nenhum número sai NaN;
//   - nada altera os objetos recebidos e o resultado só depende dos argumentos: mesma entrada,
//     mesma saída, em qualquer ordem da lista (as duas exceções são o relógio do ApTracker,
//     usado só em varreduras que chegam sem `ts`, e loadOui, que busca um arquivo);
//   - todo texto é pt-BR pronto para a tela, com vírgula decimal. Nomes de rede e de aparelho
//     são entregues como vieram: a interface escreve com textContent, nunca com innerHTML;
//   - velocidade e distância são estimativas, e os textos dizem isso ("cerca de").

// Sinal: o que vale como leitura, qualidade, potência, distância e utilitários numéricos
export {
  sanitizeRssi,
  qualityPct,
  signalLevel,
  dbmToMw,
  mwToDbm,
  sumDbm,
  noiseFloorDbm,
  indoorDistance,
  expectedRssi,
  freeSpaceDistance,
  referenceRssiAt1m,
  clamp,
  lerp,
  mean,
  median,
  percentile,
  stddev,
  createEma,
  createKalman1D,
  INVALID_RSSI_DBM,
  NOISE_FIGURE_DB,
  DEFAULT_PATH_LOSS_EXPONENT,
  MIN_DISTANCE_M,
  MAX_DISTANCE_M,
} from './signal.js';

// Canais: numeração, blocos de 20 a 320 MHz, ocupação do espectro e vazamento entre canais
export {
  BANDS,
  WIDTH_60GHZ,
  bandOf,
  freqToChannel,
  channelToFreq,
  channelList,
  isDfs,
  uniiOf,
  blocksOf,
  blocksContaining,
  blockContaining,
  androidWidthToMHz,
  occupancy,
  segmentsOf,
  overlapMHz,
  maskDb,
  interferenceFactor,
} from './channels.js';

// Camada física: gerações do Wi-Fi, taxas de dados e estimativa do enlace
export {
  WIFI_STANDARD,
  standardInfo,
  phyOfGen,
  inferGen,
  mcsName,
  dataRate,
  maxRate,
  estimateLink,
  usableMbps,
  MIN_SNR_DB,
  MAC_EFFICIENCY,
} from './phy.js';

// Segurança: leitura de ScanAp.capabilities, refinada pelos elementos do beacon
export { parseCapabilities, refineWithIes, securityTypeLabel } from './security.js';

// Elementos de informação do beacon (e o caminho inverso, para o simulador e os testes)
export { parseIes, summarizeIes, shortSsid, encodeIes } from './ies.js';

// Fabricante pelo MAC (tabela da IEEE embutida no APK)
export {
  loadOui,
  createOuiLookup,
  isLocallyAdministered,
  isRandomized,
  normalizeMac,
  encodeVlq,
  OUI_FORMAT,
  NAME_SEPARATOR,
} from './oui.js';

// Modelo: ScanAp -> Ap, agrupamento por aparelho e por rede, memória entre varreduras
export {
  normalizeAp,
  normalizeScan,
  asAp,
  asApList,
  groupByDevice,
  groupBySsid,
  securityFamily,
  ApTracker,
  normalizeBssid,
  parseMac,
  ssidStem,
  HIDDEN_NAME,
  STALE_MS,
} from './model.js';

// Canais do ponto de vista do roteador: nota, recomendação de canal e de largura, gráfico
export { rateChannels, recommendChannel, recommendWidth, rateOwnChannel, channelGraph } from './channel-rating.js';

// Melhor rede: nota de cada rede para este celular, ranking, conselho e os formatadores pt-BR
export {
  rankNetworks,
  scoreAp,
  scoringContext,
  advise,
  clientProfile,
  speedScore,
  signalCap,
  isInsecure,
  formatSpeed,
  formatGain,
  formatDbm,
  formatDistance,
  timesMore,
  SPEED_GOOD_MBPS,
  SPEED_GOOD_SCORE,
  SPEED_TOP_MBPS,
  SIGNAL_FREE_DBM,
  WEAK_SIGNAL_DBM,
  WEAK_SIGNAL_CAP,
  INSECURE_FACTOR,
  WEAK_SECURITY_FACTOR,
  WPA3_BONUS,
  SWITCH_MIN_POINTS,
  ROAM_MIN_DB,
} from './best-network.js';

// Diagnóstico automático em português claro
export { buildInsights, THROTTLE_OPTION_NAME, THROTTLE_SWITCH_SDK, canLiftScanThrottle, scanThrottleCopy } from './insights.js';
