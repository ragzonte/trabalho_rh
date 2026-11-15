// Tipos do mapeamento por Wi-Fi (só documentação: este arquivo não tem código).
//
// Fluxo:  caminhada com varreduras  ->  Survey  ->  solve()  ->  MapSolution  ->  buildMap()  ->  MapModel  ->  visualizador 3D
//
// Unidades: metros, segundos, dBm, MHz. Eixos: x e y no plano do piso, z para cima.
// O mapa não tem norte nem origem "de verdade": só o Wi-Fi não permite saber a
// rotação nem o espelhamento, então a solução vale a menos de rotação/reflexão.
// Convenção de saída: origem no centro dos pontos e eixo x na direção de maior espalhamento.

/** Altura assumida entre um andar e outro (m). */
export const FLOOR_HEIGHT = 2.8;

/**
 * Leitura de um BSSID dentro de uma varredura.
 * @typedef {Object} SurveyReading
 * @property {string} id       BSSID
 * @property {number} rssi     dBm
 * @property {number} freq     MHz
 * @property {number} [ageMs]  idade da leitura dentro da varredura (o Android às vezes repete leituras antigas)
 */

/**
 * Uma varredura feita durante a caminhada.
 * @typedef {Object} SurveyScan
 * @property {number} t             segundos desde o começo do levantamento
 * @property {number} floor         andar marcado pelo usuário (0 = onde começou, +1 = subiu um andar, -1 = desceu)
 * @property {boolean} still        o usuário estava parado ("marcar ponto")
 * @property {number|null} spot     id do ponto marcado; varreduras com o mesmo `spot` foram feitas no mesmo lugar. null = andando
 * @property {string} [label]       nome dado ao ponto ("Sala", "Quarto")
 * @property {SurveyReading[]} readings
 */

/**
 * Sinal da rede conectada entre uma varredura e outra (chega bem mais rápido que as varreduras).
 * @typedef {Object} TrackSample
 * @property {number} t
 * @property {string} id
 * @property {number} rssi
 */

/**
 * Distância medida por Wi-Fi RTT (802.11mc), quando o celular e o roteador suportam.
 * @typedef {Object} RttSample
 * @property {number} t
 * @property {string} id
 * @property {number} distM
 * @property {number} stdM
 */

/**
 * Tudo o que foi coletado numa caminhada. É o que fica salvo e o que entra no solucionador.
 * @typedef {Object} Survey
 * @property {number} version       1
 * @property {SurveyScan[]} scans   em ordem de tempo
 * @property {TrackSample[]} [track]
 * @property {RttSample[]} [rtt]
 * @property {Object<string,{ssid:string, freq:number, device?:string}>} aps
 *           dados de cada BSSID visto; `device` identifica o aparelho físico (BSSIDs do mesmo roteador têm o mesmo `device`)
 * @property {{a:number, b:number, meters:number}[]} [knownDistances]
 *           calibração opcional do usuário: distância real (m) entre as varreduras de índice `a` e `b`
 */

/**
 * Resultado do solucionador: onde cada varredura foi feita e onde está cada roteador.
 * @typedef {Object} MapSolution
 * @property {{x:number, y:number, z:number, conf:number}[]} points
 *           um por varredura (mesmo índice de survey.scans). z = floor * FLOOR_HEIGHT. conf: 0..1
 * @property {Object<string,{x:number, y:number, z:number, p0:number, n:number, conf:number}>} aps
 *           por BSSID: posição estimada e o modelo ajustado  rssi(d) = p0 - 10 * n * log10(d)  (p0 = dBm a 1 m)
 * @property {number} scaleConf     0..1: confiança na escala absoluta (metros)
 * @property {object} [debug]
 */

export {};
