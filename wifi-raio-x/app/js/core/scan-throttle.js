// Limite de buscas do Android: o nome da chave e quem pode desligá-la, num lugar só.
//
// O Android só deixa cada app procurar redes 4 vezes a cada 2 minutos; do Android 10 em diante há
// uma chave nas Opções do desenvolvedor que desliga esse limite. Todas as telas que falam disso
// (diagnóstico, dica de Redes, painel "como liberar", mapa, Sobre) usam o que está aqui: assim não
// aparecem dois nomes para a mesma chave nem a promessa "dá para liberar" num Android sem a opção.
//
// Módulo pequeno e sem dependências de propósito: as peças comuns da interface (ui/components.js)
// o importam, e elas não podem depender de carregar o diagnóstico inteiro (core/insights.js).

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * O nome da chave nas Opções do desenvolvedor, como o Android em pt-BR a escreve (texto
 * wifi_scan_throttling do AOSP, igual do Android 10 ao 15; algumas marcas mudam um pouco).
 */
export const THROTTLE_OPTION_NAME = 'Limitar busca por Wi-Fi';
/** Build.VERSION.SDK_INT do Android 10, o primeiro com a opção "Limitar busca por Wi-Fi". */
export const THROTTLE_SWITCH_SDK = 29;
/**
 * Esta versão do Android deixa desligar o limite de buscas? Só não deixa quando se sabe que é
 * anterior ao Android 10; versão desconhecida e simulador (sdk 0) contam como "deixa".
 * @param {number|null|undefined} sdk  DeviceInfo.sdk
 */
export function canLiftScanThrottle(sdk) {
  return !(isNum(sdk) && sdk > 0 && sdk < THROTTLE_SWITCH_SDK);
}
/** Como fazer as Opções do desenvolvedor aparecerem (o passo que vale para qualquer marca). */
const DEVELOPER_UNLOCK_STEP = 'em Configurações > "Sobre o dispositivo" (ou "Sobre o telefone"), toque 7 vezes em "Número da versão"';
/**
 * Os textos sobre o limite de buscas que se repetem pelas telas, já de acordo com a versão do
 * Android: o nome da chave, se dá para desligar, a frase curta que fecha qualquer aviso e o
 * rótulo do botão que abre o passo a passo (null quando não há o que liberar).
 * @param {number|null|undefined} sdk  DeviceInfo.sdk
 * @returns {{canLift:boolean, optionName:string, lift:string, action:string|null, unlockStep:string}}
 */
export function scanThrottleCopy(sdk) {
  const canLift = canLiftScanThrottle(sdk);
  return {
    canLift,
    optionName: THROTTLE_OPTION_NAME,
    lift: canLift ? 'Dá para liberar buscas mais rápidas nas opções do desenvolvedor.' : 'Nesta versão do Android não dá para desligar esse limite.',
    action: canLift ? 'Como liberar' : null,
    unlockStep: DEVELOPER_UNLOCK_STEP,
  };
}
