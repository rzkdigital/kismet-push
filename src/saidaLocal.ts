import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import type { Payload, ResultadoEnvio } from './types.js';

/** A pasta local esta valendo como destino de lote? */
export function saidaLocalAtiva(): boolean {
  if (config.saidaLocal.modo === 'nunca') return false;
  if (config.saidaLocal.modo === 'sempre') return true;
  return !config.upstream.url; // auto: so enquanto nao existe API
}

export async function iniciarSaidaLocal(): Promise<void> {
  if (config.saidaLocal.modo !== 'nunca') {
    await fs.mkdir(config.saidaLocal.dir, { recursive: true });
  }
}

/**
 * Grava o lote como JSON na pasta de analise, no mesmo formato que iria para a
 * API. O nome usa o id_lote, entao reenviar o mesmo lote sobrescreve o arquivo
 * em vez de duplicar.
 */
export async function salvarLocalmente(
  payload: Payload,
  logger?: FastifyBaseLogger,
): Promise<ResultadoEnvio> {
  const conteudo = config.saidaLocal.identado
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);

  const nome = `${payload.coletado_em.replace(/[:.]/g, '-')}_${payload.id_lote.slice(0, 8)}.json`;
  const destino = path.join(config.saidaLocal.dir, nome);
  const temporario = `${destino}.tmp`;

  try {
    await fs.mkdir(config.saidaLocal.dir, { recursive: true });
    await fs.writeFile(temporario, conteudo, 'utf8');
    await fs.rename(temporario, destino);

    logger?.info({ arquivo: nome, registros: payload.total_registros }, 'lote salvo na pasta local');

    return {
      ok: true,
      status: 0,
      retentavel: false,
      erro: null,
      bytes_originais: Buffer.byteLength(conteudo),
      bytes_enviados: Buffer.byteLength(conteudo),
      comprimido: false,
    };
  } catch (err) {
    // disco cheio, permissao... vale retentar; o lote continua na fila offline
    return { ok: false, status: 0, retentavel: true, erro: (err as Error).message };
  }
}

export async function contarLotesSalvos(): Promise<number> {
  try {
    const nomes = await fs.readdir(config.saidaLocal.dir);
    return nomes.filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
