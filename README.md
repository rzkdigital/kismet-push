# kismet-push

Serviço Node + Fastify (TypeScript) que roda no terminal, ao lado do Kismet. A cada 1 minuto ele:

1. consulta o Kismet pelos devices vistos desde a última coleta;
2. mantém **apenas** os de tipo `Wi-Fi Client`;
3. mantém **apenas** os com sinal mais forte que `-85 dBm` (configurável);
4. remove os MACs das interfaces que o próprio Kismet usa para capturar;
5. monta o lote `{ id_ponto, servidor, registros: [...] }` com os registros **brutos**, sem cortar nenhum campo;
6. grava o lote em disco **antes** de tentar entregar e só apaga depois do `2xx` da API central —
   ou, enquanto a API não existe, depois de salvar o JSON na pasta local de análise.

Se o terminal estiver sem internet, os lotes ficam empilhados em disco e são reenviados em ordem
cronológica assim que a conexão volta.

## Instalação

```bash
npm install
cp .env.example .env
```

Edite o `.env` com `ID_PONTO`, `SERVIDOR`, credencial do Kismet e a `UPSTREAM_URL` (deixe a
`UPSTREAM_URL` vazia enquanto a API não existir — os lotes vão para uma pasta local, veja abaixo).

A `KISMET_API_KEY` é enviada no cookie `KISMET` — é assim que o Kismet aceita API key. Header
próprio ou `Authorization: Bearer/ApiKey` devolvem `401`. `GET /kismet/ping` confirma a credencial.

```bash
npm run build && npm start
```

Em desenvolvimento, `npm run dev` roda direto do TypeScript (tsx, com watch).

Em produção use o systemd: [deploy/kismet-push.service](deploy/kismet-push.service) — aponta para
`dist/server.js`, então rode `npm run build` no deploy (ajuste `WorkingDirectory` e `User`).

## Scripts

| Script | O que faz |
| --- | --- |
| `npm run build` | compila `src/` para `dist/` (`tsconfig.build.json`) |
| `npm start` | roda o build (`node dist/server.js`) |
| `npm run dev` | roda o fonte com watch (`tsx watch src/server.ts`) |
| `npm run typecheck` | checa tipos de `src/` **e** `scripts/` sem emitir nada |
| `npm run mock:kismet` / `npm run mock:upstream` | sobe os mocks de teste |

## Payload enviado

```jsonc
{
  "id_ponto": 10,
  "servidor": 12321,
  "id_lote": "e1397477-9c84-41da-a844-e02f92d2f624", // uuid do lote, use para idempotência
  "coletado_em": "2026-08-07T12:26:08.274-03:00",    // fuso do TIMEZONE, com offset explícito
  "janela": { "inicio": "...", "fim": "..." },       // intervalo consultado no Kismet
  "total_registros": 2,
  "registros": [ /* devices do Kismet, exatamente como vieram */ ]
}
```

O tipo está em [src/types.ts](src/types.ts) (`Payload`), junto com `KismetDevice` — as chaves
conhecidas são tipadas e o index signature preserva todo o resto do device.

`id_lote` e `janela` são extras úteis para a API futura: como um lote reenviado depois de uma queda
pode repetir devices (a janela tem sobreposição), o `id_lote` permite descartar duplicata e a janela
diz a que período aquele lote se refere. Se a API não usar, basta ignorar.

Cabeçalho: `Authorization: Bearer ${UPSTREAM_TOKEN}` quando o token estiver configurado.

## Pasta local de lotes (enquanto não existe a API)

Sem `UPSTREAM_URL` preenchida, "entregar" o lote significa gravar o JSON numa pasta para análise —
o mesmo conteúdo que iria no corpo do POST, identado. O resto do pipeline (coleta, filtros, fila,
cron) é idêntico ao de produção: quando a API existir, basta preencher a `UPSTREAM_URL` que o envio
HTTP volta a valer, sem mexer em mais nada.

```env
SAIDA_LOCAL=auto            # auto | sempre | nunca
SAIDA_LOCAL_DIR=./data/lotes
SAIDA_LOCAL_IDENTADO=true   # false grava minificado
```

| Modo | Comportamento |
| --- | --- |
| `auto` (padrão) | grava na pasta **enquanto** `UPSTREAM_URL` estiver vazia; com a API configurada, só HTTP |
| `sempre` | grava uma cópia local **e** manda para a API |
| `nunca` | só a API |

Os lotes são organizados em subpasta por dia da coleta: `data/lotes/07-08-2026/`, um arquivo por
lote nomeado `<carimbo-local>_<id_lote>.json`. Como o nome usa o `id_lote`, reprocessar
o mesmo lote sobrescreve o arquivo em vez de duplicar. A pasta **não** é podada automaticamente — é
material de análise, some só quando você apagar. Com 1 lote por minuto e registros brutos, conte com
alguns MB por minuto em ponto movimentado; olhe o espaço em disco se for deixar rodando dias.

Exemplos de análise sobre a pasta:

```bash
jq '[.registros[] | .["kismet.device.base.macaddr"]] | unique | length' data/lotes/*.json
```

```bash
jq -r '.registros[] | [.["kismet.device.base.macaddr"], .["kismet.device.base.signal"]["kismet.common.signal.last_signal"], .["kismet.device.base.manuf"]] | @csv' data/lotes/*.json
```

## Compressão (gzip) — opcional

Como os registros vão brutos, o corpo é grande e muito repetitivo (os nomes de campo do Kismet se
repetem em cada device), então comprime bem. Medido sobre um registro real:

| Cenário | Sem gzip | Nível 1 | Nível 6 | Nível 9 |
| --- | --- | --- | --- | --- |
| 1 device | 12,2 KB | 3,0 KB (4,0x) | 2,7 KB (4,5x) | 2,7 KB (4,5x) |
| lote 50 devices | 0,59 MB | 53 KB (11,5x) | 29 KB (21x, 3ms) | 24 KB (25x, 10ms) |
| lote 300 devices | 3,55 MB | 312 KB (11,6x) | 158 KB (23x, 18ms) | 130 KB (28x, 58ms) |

Os lotes multi-device da tabela são sintéticos (o mesmo registro com valores variados), então
espere algo entre o piso de 4,5x e esses números. O nível 6 é o padrão por custo/benefício.

```env
UPSTREAM_GZIP=true          # padrao: false
UPSTREAM_GZIP_LEVEL=6
UPSTREAM_GZIP_MIN_BYTES=1024   # abaixo disso vai plano, nao compensa
```

Ligado, o envio sai com `Content-Encoding: gzip` (o `Content-Type` continua `application/json`).
A cada lote enviado o log mostra o ganho real:

```json
{ "arquivo": "...", "registros": 2, "bytes_originais": 1762, "bytes_enviados": 498, "comprimido": true, "msg": "lote enviado" }
```

**Vem desligado de propósito**: quem descomprime o corpo da requisição é a aplicação do outro lado,
não a infra — Nginx na frente não faz isso (o `ngx_http_gunzip_module` só atua em resposta). No
Express, o `express.json()` já infla sozinho; no Fastify, é preciso registrar `@fastify/compress`.
Confirme com quem construir a API antes de ligar.

Se mesmo assim a API recusar (`415` ou `400` com corpo comprimido), o serviço reenvia o mesmo lote
sem compressão na hora, loga o aviso e passa a mandar plano até reiniciar — a fila não trava. O
`/status` mostra o estado efetivo em `upstream.gzip`.

A fila offline continua gravando **JSON puro** em disco: a compressão acontece só na hora do envio,
então dá para inspecionar um lote pendente com `cat`/`jq` normalmente.

## Fuso horário

Todo horário que o serviço **gera** — `coletado_em`, `janela`, os campos `em` do `/status` e do log,
o nome do arquivo e da pasta de lotes — sai no fuso de `TIMEZONE` (padrão `America/Sao_Paulo`), em
ISO 8601 com offset explícito: `2026-08-07T12:26:08.274-03:00`.

O offset vai junto de propósito. Sem ele, "12:26" é ambíguo e qualquer parser assume o fuso dele;
com ele, o instante é exato para `Date.parse`, `timestamptz` e afins, e ainda assim a hora que
aparece é a de São Paulo. O offset é calculado pelo `Intl` a cada carimbo, não fixado em -03:00 —
se o Brasil voltar a ter horário de verão, ou o `TIMEZONE` for outro, continua correto sozinho.
Independe do fuso do sistema operacional do terminal.

Duas exceções, ambas propositais:

- os `first_time`/`last_time`/`mod_time` **dentro dos registros** continuam epoch em segundos, como
  o Kismet gera — são dado bruto, e epoch não tem ambiguidade de fuso;
- o nome dos arquivos da fila offline (`data/spool/pendentes/`) continua em UTC, porque a ordem de
  envio é a ordem alfabética dos nomes e UTC nunca anda para trás.

## Rotas locais

| Rota | Para quê |
| --- | --- |
| `GET /health` | liveness |
| `GET /status` | destino atual, última coleta, último envio, MACs ignorados, tamanho da fila |
| `GET /kismet/ping` | testa a conexão/credencial com o Kismet |
| `POST /coletar` | dispara uma coleta agora (`?forcado=true` gera lote mesmo vazio) |
| `POST /fila/drenar` | força o reenvio do que está acumulado |

## Como o filtro funciona

- **Tipo**: o filtro `kismet.device.base.type == "Wi-Fi Client"` vai junto na requisição ao Kismet
  (regex no `POST /devices/views/all/last-time/{ts}/devices.json`), o que economiza banda no terminal.
  Se o build do Kismet recusar o regex, o serviço detecta (`KismetHttpError`), avisa no log e passa a
  filtrar localmente. O filtro local roda sempre, como segunda barreira.
- **Sinal**: usa `kismet.common.signal.last_signal` (a leitura mais recente, dentro do bloco
  `kismet.device.base.signal`). O corte é **exclusivo**: com `SINAL_MINIMO_DBM=-85`, um device a
  -84 dBm entra e um a -85 dBm fica de fora. Não uso `max_signal` de propósito — ele é o máximo de
  toda a vida do device, então alguém que passou perto horas atrás continuaria entrando.
  Device sem leitura utilizável (sem bloco de sinal, escala diferente de dBm, ou `last_signal = 0`,
  que no Kismet significa "não mediu") é descartado; `MANTER_SEM_LEITURA_DE_SINAL=true` inverte isso.
  Isso pega bastante gente: numa medição real, 114 de 188 `Wi-Fi Client` vieram **sem** o bloco
  `kismet.device.base.signal` — são devices que o Kismet só inferiu (viu o MAC como destino em
  quadros de outro device, nunca capturou um quadro transmitido por eles), então não há RSSI e não
  dá para saber a que distância estavam.
  Esse filtro roda local — o endpoint do Kismet só aceita filtro por regex, que não serve para
  comparação numérica.
- **Interface do Kismet**: os MACs vêm de `/datasource/all_sources.json` — do final do
  `kismet.datasource.uuid` e do nome da interface (ex.: `wlx00873f200899`). A lista é recarregada a
  cada 5 minutos, então trocar a placa não exige reiniciar. `EXCLUDE_MACS` no `.env` adiciona MACs
  fixos à lista (separados por vírgula).
- **Blocos RRD**: os históricos circulares (`kismet.common.rrd.*` — `minute_vec`, `hour_vec`,
  `day_vec`) são removidos do registro. Nos lotes eles chegam só dentro de
  `seenby[].kismet.common.seenby.source` (`packets_rrd`, `packets_datasize_rrd`): são os contadores
  da **placa de captura**, idênticos em todos os devices do lote e sem nenhuma informação sobre o
  aparelho visto. Custavam ~20% do payload. `REMOVER_RRD=false` mantém o registro 100% cru.
  A poda é por conteúdo (qualquer objeto com `kismet.common.rrd.last_time`), não por nome de campo,
  então também pega os RRDs de device caso uma versão do Kismet passe a mandá-los.
- **Fora isso, nada é removido.** Todos os demais campos do device (`dot11.device`, `seenby`,
  sinal, pacotes…) seguem para a API como vieram.

## Fila offline

```
data/spool/
  pendentes/     aguardando entrega (nome começa com o timestamp => ordem de envio)
  descartados/   rejeitados pela API (4xx), corrompidos ou vencidos
data/lotes/      lotes entregues na pasta local (quando não há API configurada)
```

- Escrita atômica (`.tmp` + `rename`): uma queda de energia no meio da gravação não deixa lote pela metade.
- Falha de rede, timeout, `5xx`, `408` e `429` → retentável, o lote fica na fila e o ciclo para
  (sem internet não adianta insistir nos demais).
- Demais `4xx` → o lote vai para `descartados/` em vez de travar a fila para sempre.
- `SPOOL_MAX_LOTES` e `SPOOL_MAX_DIAS` limitam o crescimento em disco.
- Além do envio logo após cada coleta, o cron `CRON_REENVIO` (padrão: 2 em 2 minutos) drena o
  acumulado, mandando `SPOOL_FLUSH_BATCH` lotes por rodada.

Uma coleta nunca atropela a anterior: se o ciclo passado ainda está rodando, o novo tick é pulado
com aviso no log.

## Teste sem hardware

Três terminais:

```bash
npm run mock:kismet
```

```bash
npm run mock:upstream
```

```bash
UPSTREAM_URL=http://127.0.0.1:4000/kismet/registros ID_PONTO=10 SERVIDOR=12321 npm run dev
```

Depois:

```bash
curl -X POST http://127.0.0.1:3000/coletar
```

O mock do Kismet devolve 8 devices cobrindo cada regra de descarte (tipo diferente, própria placa
de captura, -85 no limite, -92 fraco, sem leitura de sinal) — com o padrão `SINAL_MINIMO_DBM=-85`
devem chegar 2 registros na API: os de -71 e -84 dBm. O resumo da coleta mostra a contagem por
motivo:

```json
"descartados": { "tipo": 0, "interface_kismet": 1, "sinal_fraco": 2, "sem_leitura_de_sinal": 1 }
```

Para simular queda de internet, derrube o `mock:upstream` (ou suba com `FALHAR=true`), rode algumas
coletas, veja os arquivos em `data/spool/pendentes/` e suba o mock de novo: na próxima drenagem tudo
sobe em ordem.

O mock também exercita a compressão: com `UPSTREAM_GZIP=true` ele loga `bytes_na_rede`,
`bytes_json` e o ratio. Subindo o mock com `RECUSAR_GZIP=true` ele responde `415` para corpo
comprimido, o que testa o fallback para envio plano.
