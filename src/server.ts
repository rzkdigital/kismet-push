import Fastify from 'fastify';
import fastifyCronModule from 'fastify-cron';
import { config, validarConfig } from './config.js';

// fastify-cron e CommonJS: sob module NodeNext o plugin fica em `.default`.
const fastifyCron = fastifyCronModule.default;

import { coletar, drenarFila, status } from './collector.js';
import { iniciarSpool } from './spool.js';
import { iniciarSaidaLocal } from './saidaLocal.js';
import { pingKismet } from './kismet.js';

const app = Fastify({
  logger: {
    level: config.http.logLevel,
    transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
  },
});

await iniciarSpool();
await iniciarSaidaLocal();

for (const aviso of validarConfig()) {
  app.log.warn(`config: ${aviso}`);
}

app.register(fastifyCron, {
  jobs: [
    {
      name: 'coleta-kismet',
      cronTime: config.cron.coleta,
      startWhenReady: true,
      onTick: async (server) => {
        try {
          await coletar(server.log);
        } catch {
          // ja logado dentro de coletar(); o lote continua na fila se foi gravado
        }
      },
    },
    {
      name: 'reenvio-fila',
      cronTime: config.cron.reenvio,
      startWhenReady: true,
      onTick: async (server) => {
        try {
          await drenarFila(server.log);
        } catch (err) {
          server.log.error({ err: (err as Error).message }, 'falha ao drenar a fila');
        }
      },
    },
  ],
});

// Nenhuma rota daqui consome corpo de requisicao; ignora o que vier para nao
// devolver 415 quando o operador chama com curl/Invoke-RestMethod sem body.
app.addContentTypeParser('*', (_req, payload, done) => {
  payload.resume();
  done(null, undefined);
});

app.get('/health', async () => ({ ok: true, em: new Date().toISOString() }));

app.get('/status', async () => status());

app.get('/kismet/ping', async (_req, reply) => {
  try {
    return await pingKismet();
  } catch (err) {
    return reply.code(502).send({ ok: false, erro: (err as Error).message });
  }
});

// Dispara uma coleta fora do agendamento (util para testar em campo).
app.post<{ Querystring: { forcado?: string } }>('/coletar', async (req, reply) => {
  try {
    return await coletar(app.log, { forcado: req.query.forcado === 'true' });
  } catch (err) {
    return reply.code(502).send({ ok: false, erro: (err as Error).message });
  }
});

// Forca o reenvio do que estiver acumulado na fila offline.
app.post('/fila/drenar', async () => drenarFila(app.log));

const encerrar = async (sinal: NodeJS.Signals): Promise<void> => {
  app.log.info(`recebido ${sinal}, encerrando`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void encerrar('SIGINT'));
process.on('SIGTERM', () => void encerrar('SIGTERM'));

await app.listen({ host: config.http.host, port: config.http.port });
app.log.info(
  { ponto: config.idPonto, servidor: config.servidor, cron: config.cron.coleta },
  'kismet-push no ar',
);
