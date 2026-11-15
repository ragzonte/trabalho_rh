// Um "celular" de mentira para os testes de ponta a ponta: instala window.WrxNative antes de o
// app abrir, do jeito que o Android faz (veja o contrato em app/js/bridge.js). Com ele a página
// parte no modo normal (Wi-Fi "de verdade") dentro do Chromium, e dá para exercitar a costura
// entre o celular e o modo demonstração: ligar e desligar a demonstração, rascunhos e históricos
// de um lado que não podem aparecer do outro.
//
//   const app = await openApp(env, { before: (page) => page.addInitScript(installFakeNative) });
//
// O que o celular de mentira tem:
//   - duas redes "de verdade" (REAL_BSSID / REAL_SSID e um vizinho), entregues a cada pedido de busca;
//   - conexão na rede REAL_SSID; permissão concedida; sem limite de buscas;
//   - teste de velocidade que termina bem (93,5 / 47,25 Mb/s) e ping que responde.
// O que o teste pode fazer com ele (dentro da página):
//   window.__fake.calls                  nomes dos métodos chamados, na ordem
//   window.__fake.speedCalls             quantos testes de velocidade o "celular" rodou
//   window.__fake.systemScan(extra?)     o Android entrega uma busca por conta própria (evento 'scan')
//   window.__fake.rssi(dbm)              o Android manda uma leitura do sinal conectado (evento 'rssi')

export const REAL_BSSID = 'd8:c6:78:11:22:30';
export const REAL_SSID = 'MinhaCasaReal';
export const REAL_NEIGHBOUR_BSSID = '50:c7:bf:aa:bb:cc';

/** Roda DENTRO da página, antes de qualquer script do app (page.addInitScript). Não usa nada de fora. */
export function installFakeNative() {
  const state = { calls: [], speedCalls: 0, pingCalls: [] };
  window.__fake = state;
  const ap = (bssid, ssid, level, frequency) => ({ bssid, ssid, level, frequency, channelWidth: 0, centerFreq0: 0, centerFreq1: 0, capabilities: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', ageMs: 40, wifiStandard: 4 });
  const scanEvent = (source, extra) => ({
    ts: Date.now(),
    fresh: true,
    source,
    aps: [ap('d8:c6:78:11:22:30', 'MinhaCasaReal', -55, 2437), ap('50:c7:bf:aa:bb:cc', 'VizinhoReal', -70, 2412), ...(extra || [])],
  });
  const status = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true };
  const sync = {
    info: () => ({ platform: 'android', sdk: 33, release: '13', manufacturer: 'Fabricante', model: 'Modelo', appVersion: '1.0.0', bands: { b24: true, b5: true, b6: false, b60: false }, standards: [4, 5, 6], rtt: false }),
    status: () => status,
    lastScan: () => ({ ...scanEvent('cache'), fresh: false }),
    connection: () => ({ connected: true, ssid: 'MinhaCasaReal', bssid: 'd8:c6:78:11:22:30', rssi: -55, frequency: 2437, linkSpeed: 72, ip: '192.168.0.10', prefix: 24, gateway: '192.168.0.1', dns: ['192.168.0.1'], validated: true, metered: false }),
  };
  const emit = (name, data) => window.__wrx && window.__wrx.emit && window.__wrx.emit(name, JSON.stringify(data));
  state.systemScan = (extra) => emit('scan', scanEvent('system', extra));
  state.rssi = (dbm) => emit('rssi', { ts: Date.now(), rssi: dbm, bssid: 'd8:c6:78:11:22:30', frequency: 2437, linkSpeed: 72 });
  window.WrxNative = {
    call(method) {
      state.calls.push(method);
      if (sync[method]) return JSON.stringify(sync[method]());
      return JSON.stringify({ ok: true });
    },
    callAsync(id, method, argsJson) {
      state.calls.push(method);
      const done = (result, ms = 20) => setTimeout(() => window.__wrx.resolve(id, JSON.stringify(result)), ms);
      if (method === 'scan') {
        done({ accepted: true });
        setTimeout(() => emit('scan', scanEvent('request')), 60);
      } else if (method === 'requestPermission') done(status);
      else if (method === 'speedTest') {
        state.speedCalls += 1;
        emit('speed', { phase: 'latency', progress: 1, ms: 12, bytes: 2000 });
        emit('speed', { phase: 'download', progress: 1, mbps: 93.5, bytes: 9_000_000 });
        emit('speed', { phase: 'upload', progress: 1, mbps: 47.25, bytes: 4_000_000 });
        done({ ok: true, latencyMs: 12, jitterMs: 1.5, downMbps: 93.5, upMbps: 47.25, bytesDown: 9_000_000, bytesUp: 4_000_000, server: 'GIG' }, 150);
      } else if (method === 'ping') {
        state.pingCalls.push(argsJson);
        done({ host: JSON.parse(argsJson).host, method: 'icmp', sent: 0, received: 0, lossPct: 100 });
      } else done({ error: 'unsupported' });
    },
  };
}
