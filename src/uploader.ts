import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import type { Payload, ResultadoEnvio } from './types.js';

const comprimir = promisify(gzip);

// Desligado em runtime se a API recusar o corpo comprimido (volta a valer no
// proximo restart, caso a API passe a suportar).
let gzipAtivo = true;

/** Gzip realmente em uso: o que esta no .env menos o que a API ja recusou. */
export function gzipEfetivo(): boolean {
  return config.upstream.gzip && gzipAtivo;
}

async function postar(corpo: Buffer, comprimido: boolean, bytesOriginais: number): Promise<ResultadoEnvio> {
  const medida = { bytes_originais: bytesOriginais, bytes_enviados: corpo.length, comprimido };

  try {
    const resp = await fetch(config.upstream.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(comprimido ? { 'Content-Encoding': 'gzip' } : {}),
        ...(config.upstream.token ? { Authorization: `Bearer ${config.upstream.token}` } : {}),
      },
      body: corpo,
      signal: AbortSignal.timeout(config.upstream.timeoutMs),
    });

    if (resp.ok) {
      return { ok: true, status: resp.status, retentavel: false, erro: null, ...medida };
    }

    const texto = await resp.text().catch(() => '');
    const retentavel = resp.status >= 500 || resp.status === 408 || resp.status === 429;

    return {
      ok: false,
      status: resp.status,
      retentavel,
      erro: `HTTP ${resp.status}: ${texto.slice(0, 300)}`,
      ...medida,
    };
  } catch (err) {
    // rede fora, DNS, timeout, TLS...
    return { ok: false, status: 0, retentavel: true, erro: (err as Error).message, ...medida };
  }
}

/**
 * Envia um lote para a API central.
 * Nunca lanca: devolve { ok, status, retentavel, erro } para o spool decidir.
 * Regra: falha de rede/timeout e 5xx/408/429 sao retentaveis; os demais 4xx nao
 * (payload invalido nao melhora sozinho, entao vai para `descartados`).
 */
export async function enviarLote(payload: Payload, logger?: FastifyBaseLogger): Promise<ResultadoEnvio> {
  if (!config.upstream.url) {
    return { ok: false, status: 0, retentavel: true, erro: 'UPSTREAM_URL nao configurada' };
  }

  const json = Buffer.from(JSON.stringify(payload));
  let corpo = json;
  let comprimido = false;

  if (gzipEfetivo() && json.length >= config.upstream.gzipMinBytes) {
    try {
      corpo = await comprimir(json, { level: config.upstream.gzipNivel });
      comprimido = true;
    } catch (err) {
      logger?.warn({ err: (err as Error).message }, 'falha ao comprimir o lote, enviando sem gzip');
    }
  }

  const envio = await postar(corpo, comprimido, json.length);
  if (envio.ok || !comprimido) return envio;

  // 415/400 com corpo comprimido costuma ser API que nao entende gzip: reenvia
  // plano na hora para nao entupir a fila, e desiste do gzip ate o restart.
  if (envio.status === 415 || envio.status === 400) {
    const plano = await postar(json, false, json.length);
    if (plano.ok) {
      gzipAtivo = false;
      logger?.warn(
        { status: envio.status, erro: envio.erro },
        'API recusou o corpo comprimido, gzip desativado ate reiniciar',
      );
      return plano;
    }
    return envio; // falhou dos dois jeitos: o problema nao era a compressao
  }

  return envio;
}
