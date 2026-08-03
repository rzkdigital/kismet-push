// API central de mentira. Mostra o resumo do que chegou.
// npm run mock:upstream  ->  http://127.0.0.1:4000/kismet/registros
// FALHAR=true       derruba todas as respostas (para testar a fila offline).
// RECUSAR_GZIP=true responde 415 para corpo comprimido (para testar o fallback).
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { Payload } from '../src/types.js';

const ligado = (v: string | undefined): boolean => ['1', 'true', 'sim'].includes(String(v).toLowerCase());

const FALHAR = ligado(process.env.FALHAR);
const RECUSAR_GZIP = ligado(process.env.RECUSAR_GZIP);

const servidor = http.createServer((req, res) => {
  const pedacos: Buffer[] = [];
  req.on('data', (c: Buffer) => pedacos.push(c));
  req.on('end', () => {
    const bruto = Buffer.concat(pedacos);
    const comprimido = String(req.headers['content-encoding'] ?? '').includes('gzip');

    if (FALHAR) {
      console.log('[mock-upstream] respondendo 503 de proposito');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erro: 'indisponivel' }));
    }

    if (comprimido && RECUSAR_GZIP) {
      console.log('[mock-upstream] respondendo 415 para corpo comprimido');
      res.writeHead(415, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erro: 'content-encoding nao suportado' }));
    }

    let corpo: string;
    try {
      corpo = comprimido ? gunzipSync(bruto).toString('utf8') : bruto.toString('utf8');
    } catch (err) {
      console.log('[mock-upstream] falha ao descomprimir:', (err as Error).message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erro: 'corpo ilegivel' }));
    }

    try {
      const payload = JSON.parse(corpo) as Payload;
      console.log('[mock-upstream] lote recebido:', {
        id_ponto: payload.id_ponto,
        servidor: payload.servidor,
        id_lote: payload.id_lote,
        registros: payload.registros?.length,
        macs: payload.registros?.map((r) => r['kismet.device.base.macaddr']),
        gzip: comprimido,
        bytes_na_rede: bruto.length,
        bytes_json: corpo.length,
        ratio: comprimido ? `${(corpo.length / bruto.length).toFixed(1)}x` : '-',
      });
    } catch {
      console.log('[mock-upstream] corpo invalido:', corpo.slice(0, 200));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

servidor.listen(4000, '127.0.0.1', () => console.log('[mock-upstream] http://127.0.0.1:4000/kismet/registros'));
