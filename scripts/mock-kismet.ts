// Kismet de mentira para testar o coletor sem hardware.
// npm run mock:kismet  ->  http://127.0.0.1:2501
import http from 'node:http';
import type { KismetDatasource, KismetDevice } from '../src/types.js';

const MAC_DA_PLACA = '00:87:3F:20:08:99'; // a interface que o Kismet usa para capturar

const datasources: KismetDatasource[] = [
  {
    'kismet.datasource.uuid': '5FE308BD-0000-0000-0000-00873F200899',
    'kismet.datasource.name': 'wlx00873f200899',
    'kismet.datasource.interface': 'wlx00873f200899',
    'kismet.datasource.capture_interface': 'kismon0',
    'kismet.datasource.hardware': 'rt2800usb',
  },
];

/** `sinal` em dBm; null = device sem leitura de sinal utilizavel. */
const device = (mac: string, tipo: string, sinal: number | null): KismetDevice => ({
  'kismet.device.base.key': `4202770D00000000_${mac.replace(/:/g, '')}`,
  'kismet.device.base.macaddr': mac,
  'kismet.device.base.commonname': mac,
  'kismet.device.base.type': tipo,
  'kismet.device.base.phyname': 'IEEE802.11',
  'kismet.device.base.manuf': 'Fabricante Teste',
  'kismet.device.base.first_time': 1778367913,
  'kismet.device.base.last_time': Math.floor(Date.now() / 1000),
  'kismet.device.base.channel': '8',
  'kismet.device.base.frequency': 2447000,
  'kismet.device.base.packets.total': 114,
  'kismet.device.base.signal': {
    'kismet.common.signal.type': 'dbm',
    'kismet.common.signal.last_signal': sinal ?? 0, // 0 = sem leitura, como o Kismet faz
    'kismet.common.signal.max_signal': sinal ?? 0,
    'kismet.common.signal.min_signal': sinal ?? 0,
  },
  'kismet.device.base.seenby': [{ 'kismet.common.seenby.uuid': datasources[0]?.['kismet.datasource.uuid'] }],
});

const devices: KismetDevice[] = [
  device('BC:35:1E:BE:48:61', 'Wi-Fi Client', -71), // passa
  device('A4:C1:38:00:11:22', 'Wi-Fi Client', -84), // passa (mais forte que -85)
  device('DE:AD:BE:EF:00:01', 'Wi-Fi Client', -85), // sai: o limite e exclusivo
  device('DE:AD:BE:EF:00:02', 'Wi-Fi Client', -92), // sai: sinal fraco
  device('DE:AD:BE:EF:00:03', 'Wi-Fi Client', null), // sai: sem leitura de sinal
  device(MAC_DA_PLACA, 'Wi-Fi Client', -40), // sai: a propria placa do Kismet
  device('3E:64:CF:2C:E6:BA', 'Wi-Fi AP', -55), // sai: tipo diferente
  device('12:34:56:78:9A:BC', 'Wi-Fi Bridged', -60), // sai: tipo diferente
];

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const responder = (codigo: number, corpo: unknown): void => {
    res.writeHead(codigo, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(corpo));
  };

  if (url.pathname === '/system/status.json') {
    return responder(200, {
      'kismet.system.version': '2025.09.0-mock',
      'kismet.system.server_uuid': '4A4DC180-4A57-11F1-9044-4B49534D4554',
      'kismet.system.devices.count': devices.length,
    });
  }

  if (url.pathname === '/datasource/all_sources.json') {
    return responder(200, datasources);
  }

  if (/^\/devices\/views\/all\/last-time\/-?\d+\/devices\.json$/.test(url.pathname)) {
    let corpo = '';
    req.on('data', (c: Buffer) => (corpo += c));
    req.on('end', () => {
      const bruto = new URLSearchParams(corpo).get('json');
      const comando = bruto ? (JSON.parse(bruto) as { regex?: [string, string][] }) : {};
      let saida = devices;

      if (comando.regex) {
        for (const [campo, expressao] of comando.regex) {
          const re = new RegExp(expressao);
          saida = saida.filter((d) => re.test(String(d[campo] ?? '')));
        }
      }

      console.log(
        `[mock-kismet] ${url.pathname} regex=${JSON.stringify(comando.regex ?? null)} -> ${saida.length} devices`,
      );
      responder(200, saida);
    });
    return;
  }

  responder(404, { erro: 'nao encontrado' });
});

servidor.listen(2501, '127.0.0.1', () => console.log('[mock-kismet] http://127.0.0.1:2501'));
