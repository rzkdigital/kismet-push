import { config } from './config.js';

interface PartesData {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

function partesEm(data: Date, tz: string): PartesData {
  const formatador = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const partes: PartesData = { ano: 1970, mes: 1, dia: 1, hora: 0, minuto: 0, segundo: 0 };

  for (const parte of formatador.formatToParts(data)) {
    const valor = Number(parte.value);
    switch (parte.type) {
      case 'year':
        partes.ano = valor;
        break;
      case 'month':
        partes.mes = valor;
        break;
      case 'day':
        partes.dia = valor;
        break;
      case 'hour':
        partes.hora = valor;
        break;
      case 'minute':
        partes.minuto = valor;
        break;
      case 'second':
        partes.segundo = valor;
        break;
      default:
        break;
    }
  }

  return partes;
}

/**
 * Offset do fuso configurado, em minutos, no instante dado. Calculado pelo
 * proprio Intl em vez de fixar -180: se o Brasil voltar a ter horario de verao,
 * ou o TIMEZONE for outro, continua correto sozinho.
 */
function offsetMinutos(data: Date, tz: string): number {
  const p = partesEm(data, tz);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return Math.round((comoUtc - Math.floor(data.getTime() / 1000) * 1000) / 60_000);
}

/**
 * ISO 8601 no fuso configurado, com offset explicito:
 * 2026-08-03T17:39:20.463-03:00
 *
 * Mantem o offset em vez de cortar para "hora local seca" — assim o horario
 * continua sem ambiguidade para banco, Date.parse e qualquer linguagem, mas ja
 * aparece na hora de Sao Paulo para quem le o arquivo.
 */
export function isoLocal(data: Date = new Date()): string {
  const off = offsetMinutos(data, config.timezone);
  const deslocado = new Date(data.getTime() + off * 60_000);
  const base = deslocado.toISOString().slice(0, 23); // YYYY-MM-DDTHH:mm:ss.mmm
  const sinal = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${base}${sinal}${hh}:${mm}`;
}

/** Mesmo formato, a partir de epoch em segundos (como o Kismet manda). */
export function isoLocalDeEpoch(segundos: number): string {
  return isoLocal(new Date(segundos * 1000));
}

/** Carimbo para nome de arquivo: 2026-08-03T17-39-20-463 (ordena cronologicamente). */
export function carimboArquivo(data: Date = new Date()): string {
  return isoLocal(data).slice(0, 23).replace(/[:.]/g, '-');
}

/** Data no formato dd-mm-aaaa, no fuso configurado (para nome de pasta). */
export function dataPasta(data: Date = new Date()): string {
  const p = partesEm(data, config.timezone);
  const dd = String(p.dia).padStart(2, '0');
  const mm = String(p.mes).padStart(2, '0');
  return `${dd}-${mm}-${p.ano}`;
}
