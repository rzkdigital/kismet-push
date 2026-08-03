import type { FastifyBaseLogger } from 'fastify';

/**
 * Tipos do dominio. Os registros do Kismet nao sao remodelados: as chaves
 * conhecidas ficam tipadas e o index signature preserva todo o resto do device
 * exatamente como veio da captura.
 */

export interface KismetDevice {
  'kismet.device.base.key'?: string;
  'kismet.device.base.macaddr'?: string;
  'kismet.device.base.commonname'?: string;
  'kismet.device.base.type'?: string;
  'kismet.device.base.phyname'?: string;
  'kismet.device.base.first_time'?: number;
  'kismet.device.base.last_time'?: number;
  [campo: string]: unknown;
}

export interface KismetSignal {
  'kismet.common.signal.type'?: string;
  'kismet.common.signal.last_signal'?: number;
  'kismet.common.signal.max_signal'?: number;
  'kismet.common.signal.min_signal'?: number;
  [campo: string]: unknown;
}

export interface KismetDatasource {
  'kismet.datasource.uuid'?: string;
  'kismet.datasource.name'?: string;
  'kismet.datasource.interface'?: string;
  'kismet.datasource.capture_interface'?: string;
  [campo: string]: unknown;
}

export interface KismetStatus {
  ok: true;
  versao: string | null;
  servidorUuid: string | null;
  devicesTotal: number | null;
}

/** Corpo enviado para a API central. */
export interface Payload {
  id_ponto: number;
  servidor: number;
  id_lote: string;
  coletado_em: string;
  janela: { inicio: string; fim: string };
  total_registros: number;
  registros: KismetDevice[];
}

/** Como o lote fica guardado em disco enquanto nao sobe. */
export interface Envelope {
  id_lote: string;
  criado_em: string;
  tentativas: number;
  ultimo_erro: string | null;
  payload: Payload;
}

export interface ResultadoEnvio {
  ok: boolean;
  status: number;
  retentavel: boolean;
  erro: string | null;
  bytes_originais?: number;
  bytes_enviados?: number;
  comprimido?: boolean;
}

export type EnviarLote = (payload: Payload, logger?: FastifyBaseLogger) => Promise<ResultadoEnvio>;

export interface ResultadoDrenagem {
  enviados: number;
  falhas: number;
  descartados: number;
  restantes: number;
}

export interface Pulado {
  pulado: true;
  motivo: string;
}

export type SaidaDrenagem = ResultadoDrenagem | Pulado;

/** Quantos devices cairam em cada regra de descarte na rodada. */
export interface DescartesColeta {
  tipo: number;
  interface_kismet: number;
  sinal_fraco: number;
  sem_leitura_de_sinal: number;
}

export interface ResumoColeta {
  em: string;
  desde: number;
  recebidos: number;
  registros: number;
  descartados?: DescartesColeta;
  rrd_removidos?: number;
  id_lote?: string;
  arquivo?: string;
  enfileirado: boolean;
  duracao_ms: number;
  erro?: string;
}

export type ResultadoColeta =
  | (ResumoColeta & { envio: SaidaDrenagem })
  | (Pulado & Partial<ResumoColeta>);

/**
 * Modo da pasta local de lotes:
 * auto   = grava na pasta so enquanto nao houver UPSTREAM_URL
 * sempre = grava uma copia local mesmo mandando para a API
 * nunca  = so a API
 */
export type ModoSaidaLocal = 'auto' | 'sempre' | 'nunca';

export type Destino = 'local' | 'api' | 'local+api';

export interface EstatisticasFila {
  diretorio: string;
  pendentes: number;
  descartados: number;
  mais_antigo: string | null;
}

export interface StatusServico {
  id_ponto: number;
  servidor: number;
  kismet: {
    url: string;
    tipo: string;
    filtro_no_servidor: boolean;
    sinal_minimo_dbm: number;
    manter_sem_leitura_de_sinal: boolean;
  };
  destino: Destino;
  upstream: { url: string | null; gzip: boolean };
  saida_local: { modo: ModoSaidaLocal; dir: string; lotes: number };
  coletando: boolean;
  drenando: boolean;
  macs_ignorados: string[];
  ultima_coleta: ResumoColeta | Pulado | null;
  ultimo_envio: (ResultadoDrenagem & { em: string }) | null;
  fila: EstatisticasFila;
}
