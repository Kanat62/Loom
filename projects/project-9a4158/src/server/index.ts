/**
 * Точка входа сервера.
 *
 * Обязанности ровно две:
 *   1) API сборки итогового вертикального файла (src/server/renderRoutes.ts);
 *   2) раздача собранного клиента, если сборка лежит рядом (в dev клиент
 *      обычно поднимается своим сервером и просто ходит сюда за /api).
 *
 * Внешних зависимостей нет: node:http достаточно, а меньше зависимостей —
 * меньше причин, по которым сборка не поднимется.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { handleRenderRoutes } from './renderRoutes';

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 5315;
const HOST = process.env.HOST ?? '0.0.0.0';

/** Где может лежать собранный клиент (первый подходящий каталог и берём). */
const STATIC_CANDIDATES = [
  process.env.STATIC_DIR ?? '',
  'dist/client',
  'dist/public',
  'client/dist',
  'dist',
  'public',
  'build',
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveStaticRoot(): string | null {
  for (const candidate of STATIC_CANDIDATES) {
    if (!candidate) continue;
    const dir = path.resolve(process.cwd(), candidate);
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      /* каталог недоступен — пробуем следующий */
    }
  }
  return null;
}

const staticRoot = resolveStaticRoot();

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function sendStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
): Promise<void> {
  const stat = await fsp.stat(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  root: string,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) return false;

  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    relative = url.pathname;
  }
  if (relative.endsWith('/')) relative += 'index.html';

  const filePath = path.resolve(root, '.' + relative);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return false;

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isFile()) {
      await sendStaticFile(req, res, filePath);
      return true;
    }
    if (stat.isDirectory()) {
      const indexInDir = path.join(filePath, 'index.html');
      if (fs.existsSync(indexInDir)) {
        await sendStaticFile(req, res, indexInDir);
        return true;
      }
    }
  } catch {
    /* файла нет — ниже пробуем SPA-фоллбэк */
  }

  // SPA-фоллбэк: маршруты клиента отдаём его index.html.
  if (path.extname(relative) === '') {
    const indexPath = path.join(root, 'index.html');
    if (fs.existsSync(indexPath)) {
      await sendStaticFile(req, res, indexPath);
      return true;
    }
  }

  return false;
}

export const server = http.createServer((req, res) => {
  void (async () => {
    try {
      if (await handleRenderRoutes(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/health' || url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (staticRoot && (await serveStatic(req, res, staticRoot))) return;

      if (!res.headersSent) sendJson(res, 404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      const err = error as Error;
      console.error('[server] request failed:', err.stack ?? String(err));
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: err.message });
      else res.destroy();
    }
  })();
});

// Загрузка ролика может идти долго — таймаут запроса не должен её обрывать.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.on('error', (error: Error) => {
  console.error('[server] listen failed:', error.stack ?? String(error));
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

server.listen(PORT, HOST, () => {
  console.log('Server listening on port ' + PORT);
  if (staticRoot) console.log('Serving static files from ' + staticRoot);
});

export default server;
