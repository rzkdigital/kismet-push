import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import {
  KismetHttpError,
  extrairSinalDbm,
  listarDevices,
  listarMacsDoKismet,
  normalizarMac,
} from './kismet.js';
import { drenar, enfileirar, estatisticas } from './spool.js';
import { despachar, destinoAtual } from './despacho.js';
import { podarRegistros } from './limpeza.js';
import { contarLotesSalvos } from './saidaLocal.js';
import { gzipEfetivo } from './uploader.js';
import type {
  DescartesColeta,
  KismetDevice,
  Payload,
  Pulado,
  ResultadoColeta,
  ResultadoDrenagem,
  ResumoColeta,
  SaidaDrenagem,
  StatusServico,
} from './types.js';

const CACHE_MACS_MS = 5 * 60 * 1000;

interface Estado {
  coletando: boolean;
  drenando: boolean;
  ultimoTimestamp: number | null; // epoch (s) da ultima coleta bem-sucedida
  ultimaColeta: ResumoColeta | Pulado | null;
  ultimoEnvio: (ResultadoDrenagem & { em: string }) | null;
  usarRegex: boolean;
  macsKismet: { valor: Set<string>; atualizadoEm: number };
}

const estado: Estado = {
  coletando: false,
  drenando: false,
  ultimoTimestamp: null,
  ultimaColeta: null,
  ultimoEnvio: null,
  usarRegex: config.kismet.serverSideFilter,
  macsKismet: { valor: new Set<string>(), atualizadoEm: 0 },
};

async function macsIgnorados(logger?: FastifyBaseLogger): Promise<Set<string>> {
  const agora = Date.now();
  if (agora - estado.macsKismet.atualizadoEm > CACHE_MACS_MS) {
    try {
      estado.macsKismet.valor = await listarMacsDoKismet();
      estado.macsKismet.atualizadoEm = agora;
    } catch (err) {
      logger?.warn(
        { err: (err as Error).message },
        'nao consegui listar as datasources do Kismet, usando o cache anterior',
      );
    }
  }

  const conjunto = new Set(estado.macsKismet.valor);
  for (const mac of config.excludeMacs) {
    const normalizado = normalizarMac(mac);
    if (normalizado) conjunto.add(normalizado);
  }
  return conjunto;
}

function janelaDeColeta(): number {
  const agora = Math.floor(Date.now() / 1000);
  if (!estado.ultimoTimestamp) {
    return agora - config.kismet.firstWindowSeconds;
  }
  return Math.max(0, estado.ultimoTimestamp - config.kismet.overlapSeconds);
}

async function buscarDevices(desde: number, logger?: FastifyBaseLogger): Promise<KismetDevice[]> {
  try {
    return await listarDevices(desde, { usarRegex: estado.usarRegex });
  } catch (err) {
    // Build do Kismet sem suporte a regex: cai para filtro local e nao tenta mais.
    if (estado.usarRegex && err instanceof KismetHttpError && err.status >= 400) {
      logger?.warn({ err: err.message }, 'filtro regex recusado pelo Kismet, passando a filtrar localmente');
      estado.usarRegex = false;
      return listarDevices(desde, { usarRegex: false });
    }
    throw err;
  }
}

/** Uma rodada completa: consulta o Kismet, monta o lote, grava na fila e tenta enviar. */
export async function coletar(
  logger?: FastifyBaseLogger,
  opcoes: { forcado?: boolean } = {},
): Promise<ResultadoColeta> {
  if (estado.coletando) {
    logger?.warn('coleta anterior ainda em andamento, pulando este ciclo');
    return { pulado: true, motivo: 'coleta em andamento' };
  }

  estado.coletando = true;
  const inicio = Date.now();
  const desde = janelaDeColeta();

  try {
    const [brutos, ignorados] = await Promise.all([buscarDevices(desde, logger), macsIgnorados(logger)]);

    // Cortes de registro: tipo pedido, interfaces do proprio Kismet e sinal
    // fraco. Os campos de cada device que passa sao mantidos exatamente como o
    // Kismet devolveu.
    const descartes: DescartesColeta = { tipo: 0, interface_kismet: 0, sinal_fraco: 0, sem_leitura_de_sinal: 0 };

    const registros = brutos.filter((d) => {
      if (d['kismet.device.base.type'] !== config.kismet.deviceType) {
        descartes.tipo++;
        return false;
      }

      const mac = normalizarMac(d['kismet.device.base.macaddr']);
      if (mac && ignorados.has(mac)) {
        descartes.interface_kismet++;
        return false;
      }

      const dbm = extrairSinalDbm(d);
      if (dbm === null) {
        descartes.sem_leitura_de_sinal++;
        return config.kismet.manterSemLeituraDeSinal;
      }
      if (dbm <= config.kismet.sinalMinimoDbm) {
        descartes.sinal_fraco++;
        return false;
      }

      return true;
    });

    // Os RRDs que sobram nos registros sao os da placa de captura, repetidos em
    // todo device e sem informacao sobre o aparelho visto.
    const rrdRemovidos = config.kismet.removerRrd ? podarRegistros(registros) : 0;

    estado.ultimoTimestamp = Math.floor(inicio / 1000);

    if (registros.length === 0 && !config.enviarLoteVazio && !opcoes.forcado) {
      const vazio: ResumoColeta = {
        em: new Date().toISOString(),
        desde,
        recebidos: brutos.length,
        registros: 0,
        descartados: descartes,
        enfileirado: false,
        duracao_ms: Date.now() - inicio,
      };
      estado.ultimaColeta = vazio;
      logger?.info({ desde, recebidos: brutos.length, descartes }, 'nenhum device elegivel no intervalo, lote nao gerado');
      return { pulado: true, motivo: 'lote vazio', ...vazio };
    }

    const payload = montarPayload(registros, desde);
    const fila = await enfileirar(payload);

    const resumo: ResumoColeta = {
      em: new Date().toISOString(),
      desde,
      recebidos: brutos.length,
      registros: registros.length,
      descartados: descartes,
      rrd_removidos: rrdRemovidos,
      id_lote: payload.id_lote,
      arquivo: fila.arquivo,
      enfileirado: true,
      duracao_ms: Date.now() - inicio,
    };
    estado.ultimaColeta = resumo;
    logger?.info(resumo, 'lote gravado na fila');

    const envio = await drenarFila(logger);
    return { ...resumo, envio };
  } catch (err) {
    const mensagem = (err as Error).message;
    logger?.error({ err: mensagem }, 'falha na coleta');
    estado.ultimaColeta = {
      em: new Date().toISOString(),
      desde,
      recebidos: 0,
      registros: 0,
      enfileirado: false,
      duracao_ms: Date.now() - inicio,
      erro: mensagem,
    };
    throw err;
  } finally {
    estado.coletando = false;
  }
}

export function montarPayload(registros: KismetDevice[], desde: number): Payload {
  return {
    id_ponto: config.idPonto,
    servidor: config.servidor,
    id_lote: randomUUID(),
    coletado_em: new Date().toISOString(),
    janela: {
      inicio: new Date(desde * 1000).toISOString(),
      fim: new Date().toISOString(),
    },
    total_registros: registros.length,
    registros,
  };
}

/** Reenvia o que estiver na fila. Serializado: uma drenagem por vez. */
export async function drenarFila(logger?: FastifyBaseLogger): Promise<SaidaDrenagem> {
  if (estado.drenando) return { pulado: true, motivo: 'drenagem em andamento' };

  estado.drenando = true;
  try {
    const resultado = await drenar(despachar, logger);
    estado.ultimoEnvio = { em: new Date().toISOString(), ...resultado };
    if (resultado.enviados > 0 || resultado.falhas > 0 || resultado.descartados > 0) {
      logger?.info(resultado, 'drenagem da fila concluida');
    }
    return resultado;
  } finally {
    estado.drenando = false;
  }
}

export async function status(): Promise<StatusServico> {
  return {
    id_ponto: config.idPonto,
    servidor: config.servidor,
    kismet: {
      url: config.kismet.url,
      tipo: config.kismet.deviceType,
      filtro_no_servidor: estado.usarRegex,
      sinal_minimo_dbm: config.kismet.sinalMinimoDbm,
      manter_sem_leitura_de_sinal: config.kismet.manterSemLeituraDeSinal,
    },
    destino: destinoAtual(),
    upstream: { url: config.upstream.url || null, gzip: gzipEfetivo() },
    saida_local: {
      modo: config.saidaLocal.modo,
      dir: config.saidaLocal.dir,
      lotes: await contarLotesSalvos(),
    },
    coletando: estado.coletando,
    drenando: estado.drenando,
    macs_ignorados: [...estado.macsKismet.valor, ...config.excludeMacs],
    ultima_coleta: estado.ultimaColeta,
    ultimo_envio: estado.ultimoEnvio,
    fila: await estatisticas(),
  };
}
