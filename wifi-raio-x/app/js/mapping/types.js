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

// ---------------------------------------------------------------------------
// MapModel — o que o visualizador 3D desenha. Sai de buildMap(survey, solution).
//
// Honestidade primeiro: só com o Wi-Fi a posição de cada ponto tem erro de 1 a 2 metros
// numa casa. O modelo descreve, portanto, a ÁREA aproximada por onde a pessoa andou,
// os AMBIENTES (grupos de pontos com "impressão digital" de Wi-Fi parecida, com os
// nomes que o usuário deu), o SINAL medido em cada lugar e a posição estimada dos
// roteadores. Não é uma planta com paredes exatas, e a interface não finge que é.
//
// Grade: plano x-y dividido em células quadradas. Índice da célula (ix, iy) = iy * nx + ix;
// o centro dela fica em (bounds.minX + (ix + 0.5) * cell, bounds.minY + (iy + 0.5) * cell).
// O modelo é recalculável (survey + solution -> sempre o mesmo modelo), por isso o que
// se salva é o levantamento e a solução, nunca o modelo.

/**
 * @typedef {Object} MapModel
 * @property {number} version                1
 * @property {{minX:number, minY:number, maxX:number, maxY:number}} bounds   metros, com margem
 * @property {number} cell                   lado da célula (m), entre 0.2 e 0.5
 * @property {number} nx
 * @property {number} ny
 * @property {MapFloor[]} floors             em ordem de andar (do mais baixo para o mais alto)
 * @property {MapAp[]} aps                   um por aparelho físico (roteador), os da casa primeiro
 * @property {MapNetwork[]} networks         redes que podem colorir o mapa de calor, as do usuário primeiro
 * @property {MapPathPoint[]} path           o caminho andado, um ponto por varredura, em ordem de tempo
 * @property {MapSpot[]} spots               pontos marcados pelo usuário
 * @property {MapQuality} quality
 */

/**
 * Um andar.
 * @typedef {Object} MapFloor
 * @property {number} floor                  número do andar (0 = onde começou)
 * @property {number} z                      altura do piso (m) = floor * FLOOR_HEIGHT
 * @property {Uint8Array} inside             por célula: 1 = dentro da área estimada da casa
 * @property {Float32Array} conf             por célula, 0..1: quão perto de onde se andou (1 = em cima do caminho)
 * @property {Int16Array} room               por célula: índice em `rooms`, ou -1 fora da área
 * @property {number[][][]} outline          contorno(s) da área: lista de anéis [[x, y], ...] fechados, em metros
 * @property {MapRoom[]} rooms
 * @property {MapWall[]} walls               divisões estimadas: contorno externo e fronteiras entre ambientes
 */

/**
 * Um ambiente estimado (grupo de células com sinal parecido).
 * @typedef {Object} MapRoom
 * @property {number} id
 * @property {string} label                  nome dado pelo usuário, ou "Ambiente 1", "Ambiente 2"...
 * @property {boolean} auto                  true quando o nome foi gerado
 * @property {number} cx                     centro (m)
 * @property {number} cy
 * @property {number} areaM2
 * @property {number} scans                  quantas varreduras caíram neste ambiente
 */

/**
 * @typedef {Object} MapWall
 * @property {number} x1
 * @property {number} y1
 * @property {number} x2
 * @property {number} y2
 * @property {'outer'|'inner'} kind          contorno da área ou divisão entre dois ambientes
 * @property {number} conf                   0..1
 */

/**
 * @typedef {Object} MapAp
 * @property {string} id                     id estável do aparelho (o BSSID mais forte dele)
 * @property {string[]} bssids
 * @property {string} ssid                   nome principal ("" se oculto)
 * @property {boolean} own                   é da casa (rede conectada / marcada como "minha")
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number|null} floor             andar estimado, quando dá para dizer
 * @property {number} conf                   0..1
 * @property {boolean} inside                caiu dentro da área mapeada
 * @property {number} distanceM              distância do centro da área
 * @property {number} bearing                direção a partir do centro da área (rad, 0 = +x)
 * @property {number} bestRssi               sinal mais forte medido dele durante a caminhada
 */

/**
 * @typedef {Object} MapNetwork
 * @property {string} key                    chave para heatField / coverage
 * @property {string} ssid
 * @property {boolean} own
 * @property {string[]} bssids
 * @property {number} bestRssi
 */

/**
 * @typedef {Object} MapPathPoint
 * @property {number} i                      índice da varredura no levantamento
 * @property {number} t
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} floor
 * @property {number} conf
 * @property {boolean} still
 */

/**
 * @typedef {Object} MapSpot
 * @property {number} id
 * @property {string} label
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} floor
 * @property {number} scans
 */

/**
 * @typedef {Object} MapQuality
 * @property {number} scans
 * @property {number} spots
 * @property {number} aps                    roteadores ouvidos
 * @property {number} areaM2                 área estimada (todos os andares)
 * @property {number} scaleConf              0..1
 * @property {number} expectedErrorM         erro típico de posição esperado para este levantamento (m)
 * @property {'boa'|'razoavel'|'fraca'} level
 * @property {string[]} notes                frases curtas em pt-BR: o que limita a qualidade e o que melhoraria
 */

/**
 * Campo de sinal de uma rede sobre a grade de um andar (função heatField(model, floorIndex, networkKey)).
 * @typedef {Object} HeatField
 * @property {Float32Array} dbm              por célula; NaN fora da área
 * @property {Float32Array} conf             por célula, 0..1: há medições por perto?
 * @property {number} min
 * @property {number} max
 */

/**
 * Resumo da cobertura de uma rede (função coverage(model, networkKey)).
 * @typedef {Object} Coverage
 * @property {number} good                   fração da área com sinal bom (>= -67 dBm)
 * @property {number} fair                   entre -67 e -75 dBm
 * @property {number} weak                   entre -75 e -82 dBm
 * @property {number} dead                   abaixo de -82 dBm ou sem sinal
 * @property {{floor:number, x:number, y:number, areaM2:number, room:string|null, dbm:number}[]} deadZones
 * @property {{floor:number, x:number, y:number, room:string|null, dbm:number}} best
 * @property {{floor:number, x:number, y:number, room:string|null, dbm:number}} worst
 */

export {};
