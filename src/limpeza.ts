import type { KismetDevice } from './types.js';

/**
 * Um bloco RRD (round robin database) do Kismet — histórico circular de
 * segundo/minuto/hora embutido em contadores. Reconhecido pelo conteudo, nao
 * pelo nome da chave, para pegar tanto `*.rrd` do device quanto os
 * `kismet.datasource.packets_rrd` que vem dentro do seenby.
 */
function ehBlocoRrd(valor: unknown): boolean {
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return false;
  const obj = valor as Record<string, unknown>;
  return 'kismet.common.rrd.last_time' in obj || 'kismet.common.rrd.minute_vec' in obj;
}

/**
 * Remove todo bloco RRD do registro, em profundidade. Poda no proprio objeto
 * (ele vem do JSON.parse da resposta e nao e usado em outro lugar) e devolve
 * quantos blocos saiu.
 */
export function podarRrd(valor: unknown): number {
  if (!valor || typeof valor !== 'object') return 0;

  if (Array.isArray(valor)) {
    let removidos = 0;
    for (const item of valor) removidos += podarRrd(item);
    return removidos;
  }

  const obj = valor as Record<string, unknown>;
  let removidos = 0;

  for (const chave of Object.keys(obj)) {
    if (ehBlocoRrd(obj[chave])) {
      delete obj[chave];
      removidos++;
    } else {
      removidos += podarRrd(obj[chave]);
    }
  }

  return removidos;
}

export function podarRegistros(registros: KismetDevice[]): number {
  let removidos = 0;
  for (const registro of registros) removidos += podarRrd(registro);
  return removidos;
}
