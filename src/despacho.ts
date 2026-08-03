import { config } from './config.js';
import { salvarLocalmente, saidaLocalAtiva } from './saidaLocal.js';
import { enviarLote } from './uploader.js';
import type { Destino, EnviarLote } from './types.js';

export function destinoAtual(): Destino {
  const local = saidaLocalAtiva();
  if (local && config.upstream.url) return 'local+api';
  return local ? 'local' : 'api';
}

/**
 * Para onde o lote vai quando sai da fila. Enquanto nao existe API central,
 * "entregar" significa gravar o JSON na pasta de analise; com a API no ar, o
 * fluxo volta a ser HTTP sem mudar mais nada no resto do servico.
 */
export const despachar: EnviarLote = async (payload, logger) => {
  if (saidaLocalAtiva()) {
    const salvo = await salvarLocalmente(payload, logger);
    // Nao conseguiu gravar (disco cheio, permissao): mantem o lote na fila.
    if (!salvo.ok) return salvo;
    // Sem API configurada, a pasta era o destino final.
    if (!config.upstream.url) return salvo;
  }

  return enviarLote(payload, logger);
};
