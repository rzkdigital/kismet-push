import { config } from './config.js';
import type { KismetDatasource, KismetDevice, KismetSignal, KismetStatus } from './types.js';

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

/** Erro HTTP vindo do Kismet — carrega o status para quem precisa decidir fallback. */
export class KismetHttpError extends Error {
  readonly status: number;
  readonly corpo: string;

  constructor(mensagem: string, status: number, corpo: string) {
    super(mensagem);
    this.name = 'KismetHttpError';
    this.status = status;
    this.corpo = corpo;
  }
}

/** Normaliza qualquer representacao de MAC para AA:BB:CC:DD:EE:FF. */
export function normalizarMac(valor: unknown): string | null {
  const hex = String(valor ?? '')
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return null;
  const partes = hex.match(/.{2}/g);
  if (!partes) return null;
  const mac = partes.join(':');
  return MAC_RE.test(mac) ? mac : null;
}

/**
 * Sinal do device em dBm (kismet.common.signal.last_signal), ou null quando nao
 * da para comparar: sem bloco de sinal, escala diferente de dBm (rssi cru) ou
 * `0`, que no Kismet significa "nao houve leitura".
 */
export function extrairSinalDbm(device: KismetDevice): number | null {
  const bloco = device['kismet.device.base.signal'];
  if (!bloco || typeof bloco !== 'object') return null;

  const sinal = bloco as KismetSignal;
  const tipo = sinal['kismet.common.signal.type'];
  if (tipo !== undefined && tipo !== 'dbm') return null;

  const valor = sinal['kismet.common.signal.last_signal'];
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor === 0) return null;

  return valor;
}

function headersAuth(): Record<string, string> {
  if (config.kismet.apiKey) {
    // O Kismet le a API key pelo cookie KISMET ou pela query ?KISMET=; header
    // proprio ou Authorization: Bearer/ApiKey devolvem 401. Cookie mantem a
    // chave fora da URL (e portanto fora de log de proxy/acesso).
    return { Cookie: `KISMET=${config.kismet.apiKey}` };
  }
  if (config.kismet.user) {
    const cred = Buffer.from(`${config.kismet.user}:${config.kismet.password}`).toString('base64');
    return { Authorization: `Basic ${cred}` };
  }
  return {};
}

interface ComandoKismet {
  regex?: [string, string][];
}

async function requisitar<T>(
  caminho: string,
  opcoes: { metodo?: 'GET' | 'POST'; corpo?: ComandoKismet | null } = {},
): Promise<T> {
  const { metodo = 'GET', corpo = null } = opcoes;
  const url = `${config.kismet.url}${caminho}`;

  const init: RequestInit = {
    method: metodo,
    headers: { Accept: 'application/json', ...headersAuth() },
    signal: AbortSignal.timeout(config.kismet.timeoutMs),
  };

  if (corpo) {
    // O Kismet aceita o comando como campo de formulario `json=` em todas as
    // versoes com REST API — mais compativel que mandar JSON puro no corpo.
    init.headers = { ...(init.headers as Record<string, string>), 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams({ json: JSON.stringify(corpo) }).toString();
  }

  const resp = await fetch(url, init);
  const texto = await resp.text();

  if (!resp.ok) {
    throw new KismetHttpError(
      `Kismet ${metodo} ${caminho} -> HTTP ${resp.status}: ${texto.slice(0, 300)}`,
      resp.status,
      texto,
    );
  }

  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new Error(`Kismet ${caminho} devolveu resposta nao-JSON: ${texto.slice(0, 200)}`);
  }
}

/**
 * MACs das interfaces que o proprio Kismet usa para capturar.
 * Vem de /datasource/all_sources.json: o UUID da datasource termina no MAC da
 * placa e o nome da interface (ex.: wlx00873f200899) tambem o carrega.
 */
export async function listarMacsDoKismet(): Promise<Set<string>> {
  const fontes = await requisitar<KismetDatasource[]>('/datasource/all_sources.json');
  const macs = new Set<string>();

  for (const fonte of Array.isArray(fontes) ? fontes : []) {
    const uuid = String(fonte['kismet.datasource.uuid'] ?? '');
    const macUuid = normalizarMac(uuid.split('-').pop());
    if (macUuid) macs.add(macUuid);

    const camposComNome = [
      'kismet.datasource.interface',
      'kismet.datasource.capture_interface',
      'kismet.datasource.name',
    ] as const;

    for (const campo of camposComNome) {
      const achado = String(fonte[campo] ?? '').match(/([0-9a-fA-F]{12})/);
      const mac = achado ? normalizarMac(achado[1]) : null;
      if (mac) macs.add(mac);
    }
  }

  return macs;
}

/**
 * Devices vistos/alterados desde `desdeTimestamp` (epoch em segundos).
 * Retorna os registros brutos do Kismet, sem remover nenhum campo.
 */
export async function listarDevices(
  desdeTimestamp: number,
  opcoes: { usarRegex?: boolean } = {},
): Promise<KismetDevice[]> {
  const { usarRegex = true } = opcoes;
  const caminho = `/devices/views/all/last-time/${desdeTimestamp}/devices.json`;
  const corpo: ComandoKismet = {};

  if (usarRegex) {
    const tipo = config.kismet.deviceType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    corpo.regex = [['kismet.device.base.type', `^${tipo}$`]];
  }

  const devices = await requisitar<KismetDevice[]>(caminho, { metodo: 'POST', corpo });
  return Array.isArray(devices) ? devices : [];
}

export async function pingKismet(): Promise<KismetStatus> {
  const info = await requisitar<Record<string, unknown>>('/system/status.json');
  return {
    ok: true,
    versao: (info['kismet.system.version'] as string | undefined) ?? null,
    servidorUuid: (info['kismet.system.server_uuid'] as string | undefined) ?? null,
    devicesTotal: (info['kismet.system.devices.count'] as number | undefined) ?? null,
  };
}
