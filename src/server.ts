import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeProduto } from './scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3777);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Só uma busca por vez. Duas em paralelo dobrariam o ritmo de requisições e
 * derrubariam o limite do Cloudflare — que é por IP, não por conexão.
 */
let fila: Promise<unknown> = Promise.resolve();
function enfileirar<T>(tarefa: () => Promise<T>): Promise<T> {
  const proxima = fila.then(tarefa, tarefa);
  fila = proxima.catch(() => {});
  return proxima;
}

/**
 * Busca via SSE: o front recebe o progresso em tempo real (a coleta leva
 * ~2 min para ~90 lojas) e no fim o resultado completo.
 */
app.get('/api/scrape', async (req, res) => {
  const url = String(req.query.url ?? '');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);

  try {
    const resultado = await enfileirar(() =>
      scrapeProduto(url, (etapa, atual, total) => send('progress', { etapa, atual, total })),
    );
    send('done', resultado);
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  Liga Scraper rodando em  http://localhost:${PORT}\n`);
});
