import 'dotenv/config';
import path from 'node:path';
import type { ModoSaidaLocal } from './types.js';

const bool = (v: string | undefined, padrao: boolean): boolean => {
  if (v === undefined || v === '') return padrao;
  return ['1', 'true', 'yes', 'sim'].includes(v.toLowerCase());
};

const num = (v: string | undefined, padrao: number): number => {
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
};

const lista = (v: string | undefined): string[] =>
  String(v ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const modoSaida = (v: string | undefined): ModoSaidaLocal => {
  const escolhido = (v || 'auto').toLowerCase();
  return escolhido === 'sempre' || escolhido === 'nunca' ? escolhido : 'auto';
};

/** Cai para UTC se o TIMEZONE do .env nao existir, em vez de derrubar o processo. */
const tzValida = (v: string | undefined): string => {
  const tz = v || 'America/Sao_Paulo';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
};

export interface Config {
  idPonto: number;
  servidor: number;
  timezone: string;
  kismet: {
    url: string;
    apiKey: string;
    user: string;
    password: string;
    deviceType: string;
    sinalMinimoDbm: number;
    manterSemLeituraDeSinal: boolean;
    removerRrd: boolean;
    serverSideFilter: boolean;
    overlapSeconds: number;
    firstWindowSeconds: number;
    timeoutMs: number;
  };
  upstream: {
    url: string;
    token: string;
    timeoutMs: number;
    gzip: boolean;
    gzipNivel: number;
    gzipMinBytes: number;
  };
  cron: { coleta: string; reenvio: string };
  saidaLocal: { modo: ModoSaidaLocal; dir: string; identado: boolean };
  enviarLoteVazio: boolean;
  spool: { dir: string; maxLotes: number; maxDias: number; flushBatch: number };
  excludeMacs: string[];
  http: { host: string; port: number; logLevel: string };
}

export const config: Config = {
  idPonto: num(process.env.ID_PONTO, 0),
  servidor: num(process.env.SERVIDOR, 0),
  // Fuso usado em todo horario que o servico gera (payload, logs, nomes de arquivo).
  timezone: tzValida(process.env.TIMEZONE),

  kismet: {
    url: (process.env.KISMET_URL || 'http://127.0.0.1:2501').replace(/\/+$/, ''),
    apiKey: process.env.KISMET_API_KEY || '',
    user: process.env.KISMET_USER || '',
    password: process.env.KISMET_PASSWORD || '',
    deviceType: process.env.KISMET_DEVICE_TYPE || 'Wi-Fi Client',
    // So entra device com sinal MAIS FORTE que esse valor (-84 entra, -85 nao).
    sinalMinimoDbm: num(process.env.SINAL_MINIMO_DBM, -85),
    manterSemLeituraDeSinal: bool(process.env.MANTER_SEM_LEITURA_DE_SINAL, false),
    // Tira os historicos circulares (kismet.common.rrd.*) do registro.
    removerRrd: bool(process.env.REMOVER_RRD, true),
    serverSideFilter: bool(process.env.KISMET_SERVER_SIDE_FILTER, true),
    overlapSeconds: num(process.env.KISMET_OVERLAP_SECONDS, 10),
    firstWindowSeconds: num(process.env.KISMET_FIRST_WINDOW_SECONDS, 300),
    timeoutMs: num(process.env.KISMET_TIMEOUT_MS, 30000),
  },

  upstream: {
    url: process.env.UPSTREAM_URL || '',
    token: process.env.UPSTREAM_TOKEN || '',
    timeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 30000),
    // So ligue depois de confirmar que a API aceita Content-Encoding: gzip.
    gzip: bool(process.env.UPSTREAM_GZIP, false),
    gzipNivel: num(process.env.UPSTREAM_GZIP_LEVEL, 6),
    gzipMinBytes: num(process.env.UPSTREAM_GZIP_MIN_BYTES, 1024),
  },

  cron: {
    coleta: process.env.CRON_COLETA || '*/1 * * * *',
    reenvio: process.env.CRON_REENVIO || '*/2 * * * *',
  },

  saidaLocal: {
    modo: modoSaida(process.env.SAIDA_LOCAL),
    dir: path.resolve(process.env.SAIDA_LOCAL_DIR || './data/lotes'),
    identado: bool(process.env.SAIDA_LOCAL_IDENTADO, true),
  },

  enviarLoteVazio: bool(process.env.ENVIAR_LOTE_VAZIO, false),

  spool: {
    dir: path.resolve(process.env.SPOOL_DIR || './data/spool'),
    maxLotes: num(process.env.SPOOL_MAX_LOTES, 5000),
    maxDias: num(process.env.SPOOL_MAX_DIAS, 7),
    flushBatch: num(process.env.SPOOL_FLUSH_BATCH, 20),
  },

  excludeMacs: lista(process.env.EXCLUDE_MACS).map((m) => m.toUpperCase()),

  http: {
    host: process.env.HOST || '0.0.0.0',
    port: num(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};

/** Avisos de configuracao — nao derrubam o processo, so alertam no log. */
export function validarConfig(): string[] {
  const avisos: string[] = [];
  if (!config.idPonto) avisos.push('ID_PONTO nao definido');
  if (!config.servidor) avisos.push('SERVIDOR nao definido');
  if (!config.upstream.url && config.saidaLocal.modo === 'nunca') {
    avisos.push('sem UPSTREAM_URL e com SAIDA_LOCAL=nunca — os lotes so acumulam na fila offline');
  }
  if (!config.upstream.url && config.saidaLocal.modo !== 'nunca') {
    avisos.push(`sem UPSTREAM_URL — os lotes vao para a pasta ${config.saidaLocal.dir}`);
  }
  if (process.env.TIMEZONE && config.timezone === 'UTC' && process.env.TIMEZONE !== 'UTC') {
    avisos.push(`TIMEZONE "${process.env.TIMEZONE}" nao reconhecido, usando UTC`);
  }
  if (!config.kismet.apiKey && !config.kismet.user) {
    avisos.push('Kismet sem credencial (KISMET_API_KEY ou KISMET_USER/KISMET_PASSWORD)');
  }
  return avisos;
}
