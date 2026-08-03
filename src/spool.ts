import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import type { EnviarLote, Envelope, EstatisticasFila, Payload, ResultadoDrenagem } from './types.js';

const dirPendentes = (): string => path.join(config.spool.dir, 'pendentes');
const dirDescartados = (): string => path.join(config.spool.dir, 'descartados');

let seq = 0;

export async function iniciarSpool(): Promise<void> {
  await fs.mkdir(dirPendentes(), { recursive: true });
  await fs.mkdir(dirDescartados(), { recursive: true });
}

async function listarArquivos(dir: string): Promise<string[]> {
  try {
    const nomes = await fs.readdir(dir);
    return nomes.filter((n) => n.endsWith('.json')).sort(); // nome comeca com timestamp => ordem cronologica
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function gravarAtomico(destino: string, envelope: Envelope): Promise<void> {
  const temporario = `${destino}.tmp`;
  await fs.writeFile(temporario, JSON.stringify(envelope), 'utf8');
  await fs.rename(temporario, destino);
}

/** Grava o lote em disco antes de qualquer tentativa de envio. */
export async function enfileirar(payload: Payload): Promise<{ arquivo: string; registros: number }> {
  const agora = new Date();
  const nome = [
    agora.toISOString().replace(/[:.]/g, '-'),
    String(seq++).padStart(4, '0'),
    randomUUID().slice(0, 8),
  ].join('_') + '.json';

  const envelope: Envelope = {
    id_lote: payload.id_lote,
    criado_em: agora.toISOString(),
    tentativas: 0,
    ultimo_erro: null,
    payload,
  };

  await gravarAtomico(path.join(dirPendentes(), nome), envelope);
  await aplicarLimites();

  return { arquivo: nome, registros: payload.registros.length };
}

async function ler(nome: string): Promise<Envelope> {
  const conteudo = await fs.readFile(path.join(dirPendentes(), nome), 'utf8');
  return JSON.parse(conteudo) as Envelope;
}

async function remover(nome: string): Promise<void> {
  await fs.rm(path.join(dirPendentes(), nome), { force: true });
}

async function descartar(nome: string, envelope: Envelope): Promise<void> {
  await fs.writeFile(path.join(dirDescartados(), nome), JSON.stringify(envelope), 'utf8');
  await remover(nome);
}

/**
 * Tenta reenviar os lotes pendentes, do mais antigo para o mais novo.
 * Para na primeira falha retentavel — sem internet nao adianta insistir no resto.
 */
export async function drenar(enviar: EnviarLote, logger?: FastifyBaseLogger): Promise<ResultadoDrenagem> {
  const pendentes = (await listarArquivos(dirPendentes())).slice(0, config.spool.flushBatch);
  const resultado: ResultadoDrenagem = { enviados: 0, falhas: 0, descartados: 0, restantes: 0 };

  for (const nome of pendentes) {
    let envelope: Envelope;
    try {
      envelope = await ler(nome);
    } catch (err) {
      logger?.warn({ arquivo: nome, err: (err as Error).message }, 'lote corrompido, movendo para descartados');
      await fs.rename(path.join(dirPendentes(), nome), path.join(dirDescartados(), nome)).catch(() => {});
      resultado.descartados++;
      continue;
    }

    const envio = await enviar(envelope.payload, logger);

    if (envio.ok) {
      await remover(nome);
      resultado.enviados++;
      logger?.info(
        {
          arquivo: nome,
          registros: envelope.payload.total_registros,
          bytes_originais: envio.bytes_originais,
          bytes_enviados: envio.bytes_enviados,
          comprimido: envio.comprimido,
        },
        'lote entregue',
      );
      continue;
    }

    envelope.tentativas++;
    envelope.ultimo_erro = envio.erro;

    if (!envio.retentavel) {
      logger?.error({ arquivo: nome, erro: envio.erro }, 'lote rejeitado pela API, movendo para descartados');
      await descartar(nome, envelope);
      resultado.descartados++;
      continue;
    }

    await gravarAtomico(path.join(dirPendentes(), nome), envelope);
    resultado.falhas++;
    logger?.warn(
      { arquivo: nome, tentativas: envelope.tentativas, erro: envio.erro },
      'envio falhou, lote mantido na fila',
    );
    break;
  }

  resultado.restantes = (await listarArquivos(dirPendentes())).length;
  return resultado;
}

/** Aplica os limites de idade e de quantidade da fila. */
async function aplicarLimites(): Promise<void> {
  if (config.spool.maxDias > 0) {
    const limite = Date.now() - config.spool.maxDias * 86_400_000;
    for (const nome of await listarArquivos(dirPendentes())) {
      const arquivo = path.join(dirPendentes(), nome);
      const info = await fs.stat(arquivo).catch(() => null);
      if (info && info.mtimeMs < limite) {
        await fs.rename(arquivo, path.join(dirDescartados(), nome)).catch(() => {});
      }
    }
  }

  if (config.spool.maxLotes > 0) {
    const atuais = await listarArquivos(dirPendentes());
    const excedente = atuais.length - config.spool.maxLotes;
    for (let i = 0; i < excedente; i++) {
      const nome = atuais[i];
      if (nome) await fs.rm(path.join(dirPendentes(), nome), { force: true }); // descarta os mais antigos primeiro
    }
  }
}

export async function estatisticas(): Promise<EstatisticasFila> {
  const [pendentes, descartados] = await Promise.all([
    listarArquivos(dirPendentes()),
    listarArquivos(dirDescartados()),
  ]);
  return {
    diretorio: config.spool.dir,
    pendentes: pendentes.length,
    descartados: descartados.length,
    mais_antigo: pendentes[0] ?? null,
  };
}
