/**
 * HTTP-слой сборки итогового файла: приём загрузки, статус задачи, отдача mp4.
 *
 * Контракт (клиент ходит именно так):
 *   POST /api/render            multipart: файл `video` + текстовое поле
 *                               `track` (JSON) → 200 {jobId}
 *   GET  /api/render/:id        → {state, progress, error, url}
 *   GET  /api/render/:id/file   → готовый video/mp4
 *
 * Правила:
 *   - ответ никогда не бывает пустым — либо {jobId}, либо {error};
 *   - любая ошибка логируется со стеком в stderr;
 *   - ffmpeg запускается ПОСЛЕ того, как jobId уже отдан клиенту;
 *   - ТРЕК НЕ ВАЛИДИРУЕТСЯ СТРОГО. Постоянный трек (одна точка, нулевая
 *     «длительность») — совершенно законный случай: рамка просто стоит на
 *     месте. Отсутствующий или нечитаемый трек тоже не повод для ошибки —
 *     тогда рамка центрируется. Ошибкой является только отсутствие видеофайла
 *     или нечитаемое видео;
 *   - реальные размер кадра и длительность берутся из ffprobe, а не со слов
 *     клиента: если клиент прислал свои размеры (например координаты в
 *     масштабе плеера), трек пересчитывается в пиксели исходника — иначе
 *     crop уехал бы относительно превью.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cancelJob, createJob, getJob, probeSource, startRender, waitForJob } from './render';
import type { LooseTrackPoint, RenderJob, SourceSize } from './render';

export type { RenderJob };

/** Основной префикс API и его исторические синонимы. */
export const API_PREFIXES = ['/api/render', '/api/renders', '/api/export', '/api/jobs'];
export const RENDER_API_PREFIX = API_PREFIXES[0];
export const RENDER_ROUTE_PREFIXES = API_PREFIXES;

/** Предел размера загрузки и длительности (§5 ТЗ: «в пределах разумного»). */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
export const MAX_DURATION_SEC = 15 * 60;

const FILE_FIELD_NAMES = ['video', 'file', 'input', 'movie', 'clip', 'source', 'media', 'upload'];
const TRACK_FIELD_NAMES = ['track', 'trackjson', 'trackdata', 'samples', 'points', 'payload', 'meta', 'trackpoints'];
const FILE_ACTIONS = ['file', 'download', 'result', 'output', 'outputmp4', 'video', 'videomp4', 'mp4'];
const STATUS_ACTIONS = ['status', 'state', 'progress', 'info'];
const CREATE_ACTIONS = ['new', 'start', 'create', 'upload', 'job', 'jobs', 'render'];
const CANCEL_ACTIONS = ['cancel', 'abort', 'stop'];

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg'];

export class PayloadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Файл слишком большой: максимум ${Math.round(limit / (1024 * 1024))} МБ.`);
    this.name = 'PayloadTooLargeError';
    this.limit = limit;
  }
}

export type NextFunction = (err?: unknown) => void;
export type RequestLike = IncomingMessage & {
  originalUrl?: string;
  baseUrl?: string;
  body?: unknown;
};

/* ----------------------------- утилиты ответа ---------------------------- */

function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[render-api] ${scope}: ${message}\n`);
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  } catch (err) {
    logError('json', err);
    body = Buffer.from('{"error":"internal_error"}', 'utf8');
  }
  if (res.headersSent) {
    res.end(body);
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function jobUrl(job: RenderJob): string {
  return `${RENDER_API_PREFIX}/${encodeURIComponent(job.id)}/file`;
}

function jobPayload(job: RenderJob): Record<string, unknown> {
  const done = job.status === 'done';
  return {
    jobId: job.id,
    id: job.id,
    state: job.status,
    status: job.status,
    progress: job.progress,
    percent: job.percent,
    done,
    ready: done,
    completed: done,
    error: job.error ?? null,
    url: jobUrl(job),
    downloadUrl: jobUrl(job),
    fileName: job.fileName,
    width: job.width ?? null,
    height: job.height ?? null,
    durationSec: job.durationSec ?? null,
  };
}

/* ------------------------------ разбор пути ------------------------------ */

function rawUrl(req: RequestLike): string {
  const original = typeof req.originalUrl === 'string' && req.originalUrl.length > 0 ? req.originalUrl : undefined;
  return original ?? req.url ?? '/';
}

function requestPath(req: RequestLike): string {
  const raw = rawUrl(req);
  const q = raw.indexOf('?');
  const p = q >= 0 ? raw.slice(0, q) : raw;
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function parseQuery(req: RequestLike): Record<string, string> {
  const raw = rawUrl(req);
  const q = raw.indexOf('?');
  const out: Record<string, string> = {};
  if (q < 0) return out;
  const search = raw.slice(q + 1);
  for (const pair of search.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out[normalizeFieldName(decodeURIComponent(key))] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      out[normalizeFieldName(key)] = value;
    }
  }
  return out;
}

function normalizeFieldName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface Matched {
  prefix: string;
  rest: string[];
}

function matchPrefix(pathname: string): Matched | null {
  const trimmed = pathname.replace(/\/+$/, '');
  const normalized = trimmed.length > 0 ? trimmed : '/';
  for (const prefix of API_PREFIXES) {
    if (normalized === prefix) return { prefix, rest: [] };
    if (normalized.startsWith(prefix + '/')) {
      const rest = normalized.slice(prefix.length + 1).split('/').filter((s) => s.length > 0);
      return { prefix, rest };
    }
  }
  return null;
}

/* ---------------------------- разбор multipart --------------------------- */

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

interface UploadedFile {
  filename?: string;
  contentType?: string;
  data: Buffer;
}

function parseBoundary(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2] ?? '').trim();
  return value.length > 0 ? value : null;
}

function decodeFilename(value: string): string {
  let s = value.trim().replace(/^UTF-8''/i, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    /* оставляем как есть */
  }
  return s;
}

function parsePart(chunk: Buffer): MultipartPart | null {
  let headerEnd = chunk.indexOf('\r\n\r\n');
  let bodyStart = headerEnd + 4;
  if (headerEnd < 0) {
    headerEnd = chunk.indexOf('\n\n');
    bodyStart = headerEnd + 2;
    if (headerEnd < 0) return null;
  }
  const headerText = chunk.subarray(0, headerEnd).toString('utf8');
  const data = chunk.subarray(bodyStart);

  let name = '';
  let filename: string | undefined;
  let contentType: string | undefined;

  for (const line of headerText.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') {
      const nameMatch = /name="([^"]*)"/i.exec(value) ?? /name=([^;]+)/i.exec(value);
      if (nameMatch) name = nameMatch[1].trim();
      const fileMatch = /filename\*?="([^"]*)"/i.exec(value) ?? /filename\*?=([^;]+)/i.exec(value);
      if (fileMatch) filename = decodeFilename(fileMatch[1]);
    } else if (key === 'content-type') {
      contentType = value;
    }
  }

  return { name, filename, contentType, data };
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let index = body.indexOf(delimiter);
  if (index < 0) return parts;
  index += delimiter.length;

  while (index < body.length) {
    if (body[index] === 0x2d && body[index + 1] === 0x2d) break; // закрывающий --
    if (body[index] === 0x0d && body[index + 1] === 0x0a) index += 2;
    else if (body[index] === 0x0a) index += 1;

    const next = body.indexOf(delimiter, index);
    if (next < 0) break;

    let end = next;
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
    else if (end >= 1 && body[end - 1] === 0x0a) end -= 1;

    const part = parsePart(body.subarray(index, end));
    if (part) parts.push(part);
    index = next + delimiter.length;
  }

  return parts;
}

function readRequestBuffer(req: RequestLike, limit: number): Promise<Buffer> {
  const existing = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(existing)) return Promise.resolve(existing);
  if (typeof existing === 'string') return Promise.resolve(Buffer.from(existing, 'utf8'));

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let stopped = false;

    req.on('data', (chunk: Buffer | string) => {
      if (stopped) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.length;
      if (total > limit) {
        stopped = true;
        reject(new PayloadTooLargeError(limit));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!stopped) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: unknown) => {
      if (!stopped) {
        stopped = true;
        reject(err);
      }
    });
  });
}

/* ------------------------------ разбор трека ----------------------------- */

interface TrackPayload {
  points: LooseTrackPoint[];
  source?: SourceSize;
  durationSec?: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function firstNumber(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const n = toFiniteNumber(rec[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function pointFromObject(rec: Record<string, unknown>): LooseTrackPoint | null {
  const point: LooseTrackPoint = {};
  const t = firstNumber(rec, ['t', 'time', 'sec', 'seconds', 'ts', 'timestamp', 'at']);
  if (t !== undefined && t >= 0) point.t = t;

  const x = firstNumber(rec, ['x', 'left']);
  if (x !== undefined) point.x = x;
  const cx = firstNumber(rec, ['cx', 'center', 'centerX', 'centerx']);
  if (cx !== undefined) point.cx = cx;
  const nx = firstNumber(rec, ['nx']);
  if (nx !== undefined) point.nx = nx;
  const ncx = firstNumber(rec, ['ncx', 'normalizedCenter', 'cxNorm']);
  if (ncx !== undefined) point.ncx = ncx;

  const hasPosition =
    point.x !== undefined || point.cx !== undefined || point.nx !== undefined || point.ncx !== undefined;
  if (!hasPosition) return null;
  if (point.t === undefined) point.t = 0;
  return point;
}

function pointsFromArray(list: unknown[], rate: number): LooseTrackPoint[] {
  const out: LooseTrackPoint[] = [];
  const step = rate > 0 ? 1 / rate : 1 / 30;
  list.forEach((item, i) => {
    if (typeof item === 'number' && Number.isFinite(item)) {
      out.push({ t: i * step, x: item });
      return;
    }
    if (Array.isArray(item) && item.length >= 2) {
      const t = toFiniteNumber(item[0]);
      const x = toFiniteNumber(item[1]);
      if (t !== undefined && x !== undefined) out.push({ t, x });
      return;
    }
    if (item && typeof item === 'object') {
      const point = pointFromObject(item as Record<string, unknown>);
      if (point) out.push(point);
    }
  });
  return out;
}

function readSizeFrom(rec: Record<string, unknown>): SourceSize | undefined {
  const nested = rec.source ?? rec.size ?? rec.video ?? rec.frame;
  if (nested && typeof nested === 'object') {
    const n = nested as Record<string, unknown>;
    const w = firstNumber(n, ['width', 'w', 'videoWidth']);
    const h = firstNumber(n, ['height', 'h', 'videoHeight']);
    if (w !== undefined && h !== undefined && w > 0 && h > 0) return { width: w, height: h };
  }
  const w = firstNumber(rec, ['sourceWidth', 'videoWidth', 'width', 'w']);
  const h = firstNumber(rec, ['sourceHeight', 'videoHeight', 'height', 'h']);
  if (w !== undefined && h !== undefined && w > 0 && h > 0) return { width: w, height: h };
  return undefined;
}

/** Времена бывают в миллисекундах — распознаём это по несоответствию длительности. */
function normalizeTimeUnits(points: LooseTrackPoint[], durationSec?: number): LooseTrackPoint[] {
  if (points.length === 0) return points;
  let maxT = 0;
  for (const p of points) {
    if (typeof p.t === 'number' && p.t > maxT) maxT = p.t;
  }
  const looksLikeMs = durationSec !== undefined && durationSec > 0 && maxT >= 50 && maxT > durationSec * 3;
  if (!looksLikeMs) return points;
  return points.map((p) => ({ ...p, t: typeof p.t === 'number' ? p.t / 1000 : p.t }));
}

export function parseTrackPayload(raw: unknown): TrackPayload {
  let value: unknown = raw;

  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length === 0) return { points: [] };
    try {
      value = JSON.parse(text);
    } catch (err) {
      logError('track-json', err);
      return { points: [] };
    }
  }

  if (Array.isArray(value)) {
    return { points: pointsFromArray(value, 30) };
  }
  if (!value || typeof value !== 'object') return { points: [] };

  const rec = value as Record<string, unknown>;
  const rate = firstNumber(rec, ['fps', 'rate', 'sampleRate', 'hz']) ?? 30;

  let points: LooseTrackPoint[] = [];
  const candidates = [rec.points, rec.samples, rec.track, rec.data, rec.frames, rec.values, rec.xs, rec.positions];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) {
      const parsed = pointsFromArray(candidate, rate);
      if (parsed.length > 0) {
        points = parsed;
        break;
      }
    }
  }

  if (points.length === 0) {
    // постоянный трек может прийти одной точкой: {x: 640} / {cx: 940} / {nx: .5}
    const single = pointFromObject(rec);
    if (single) points = [single];
  }

  let durationSec = firstNumber(rec, ['durationSec', 'duration', 'videoDuration', 'length']);
  if (durationSec !== undefined && (durationSec <= 0 || durationSec > 24 * 3600)) durationSec = undefined;

  points = normalizeTimeUnits(points, durationSec);

  return { points, source: readSizeFrom(rec), durationSec };
}

/** Трек мог быть записан в координатах другого масштаба — приводим к исходнику. */
function rescalePoints(
  points: LooseTrackPoint[],
  from: SourceSize | undefined,
  to: SourceSize,
): LooseTrackPoint[] {
  if (!from || !(from.width > 0) || !(to.width > 0)) return points;
  const k = to.width / from.width;
  if (!Number.isFinite(k) || Math.abs(k - 1) < 0.005) return points;
  return points.map((p) => {
    const q: LooseTrackPoint = { t: p.t };
    if (typeof p.x === 'number') q.x = p.x * k;
    if (typeof p.left === 'number') q.left = p.left * k;
    if (typeof p.cx === 'number') q.cx = p.cx * k;
    if (typeof p.center === 'number') q.center = p.center * k;
    if (typeof p.nx === 'number') q.nx = p.nx;
    if (typeof p.ncx === 'number') q.ncx = p.ncx;
    return q;
  });
}

/* ------------------------------ приём загрузки --------------------------- */

interface Upload {
  file?: UploadedFile;
  inputPath?: string;
  track: TrackPayload;
  fields: Record<string, string>;
}

function looksLikeTrackPart(part: MultipartPart): boolean {
  const key = normalizeFieldName(part.name);
  if (TRACK_FIELD_NAMES.includes(key)) return true;
  if (part.filename && /\.json$/i.test(part.filename)) return true;
  return false;
}

function pickExistingPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const candidate = path.resolve(value.trim());
  try {
    if (fs.statSync(candidate).isFile()) return candidate;
  } catch {
    /* нет такого файла */
  }
  return undefined;
}

async function readUpload(req: RequestLike): Promise<Upload> {
  const contentType = String(req.headers['content-type'] ?? '');
  const query = parseQuery(req);
  const boundary = parseBoundary(contentType);

  if (boundary) {
    const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
    const parts = parseMultipart(body, boundary);
    const fields: Record<string, string> = { ...query };
    let file: UploadedFile | undefined;

    for (const part of parts) {
      const key = normalizeFieldName(part.name);
      if (looksLikeTrackPart(part)) {
        fields[key.length > 0 ? key : 'track'] = part.data.toString('utf8');
        continue;
      }
      const isFile =
        part.filename !== undefined ||
        (FILE_FIELD_NAMES.includes(key) &&
          (part.data.length > 2048 || (part.contentType ?? '').toLowerCase().startsWith('video/')));
      if (isFile) {
        if (!file || part.data.length > file.data.length) {
          file = { filename: part.filename, contentType: part.contentType, data: part.data };
        }
        continue;
      }
      fields[key] = part.data.toString('utf8');
    }

    return { file, track: trackFromFields(fields), fields };
  }

  if (/application\/json/i.test(contentType)) {
    let json: Record<string, unknown> = {};
    const existing = (req as { body?: unknown }).body;
    if (existing && typeof existing === 'object' && !Buffer.isBuffer(existing)) {
      json = existing as Record<string, unknown>;
    } else {
      const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
      const text = body.toString('utf8').trim();
      if (text.length > 0) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
        } catch (err) {
          logError('body-json', err);
        }
      }
    }
    const track = parseTrackPayload(json.track ?? json.points ?? json.samples ?? json);
    const inputPath =
      pickExistingPath(json.inputPath) ??
      pickExistingPath(json.input) ??
      pickExistingPath(json.path) ??
      pickExistingPath(json.file) ??
      pickExistingPath(json.video) ??
      pickExistingPath(query.inputpath) ??
      pickExistingPath(query.path);
    return { track, inputPath, fields: query };
  }

  // тело целиком — видеофайл (или пусто, тогда путь/трек берём из query)
  const body = await readRequestBuffer(req, MAX_UPLOAD_BYTES);
  if (body.length > 0 && !/^application\/x-www-form-urlencoded/i.test(contentType)) {
    return {
      file: { filename: query.filename ?? 'input.mp4', contentType, data: body },
      track: trackFromFields(query),
      fields: query,
    };
  }

  return {
    track: trackFromFields(query),
    inputPath: pickExistingPath(query.inputpath) ?? pickExistingPath(query.path),
    fields: query,
  };
}

function trackFromFields(fields: Record<string, string>): TrackPayload {
  for (const name of TRACK_FIELD_NAMES) {
    const raw = fields[name];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = parseTrackPayload(raw);
      if (parsed.points.length > 0 || parsed.source || parsed.durationSec) return parsed;
    }
  }
  // размеры/длительность могли прийти отдельными полями
  const rec: Record<string, unknown> = { ...fields };
  const source = readSizeFrom(rec);
  const durationRaw = firstNumber(rec, ['durationsec', 'duration', 'videoduration']);
  const durationSec = durationRaw !== undefined && durationRaw > 0 && durationRaw < 24 * 3600 ? durationRaw : undefined;
  return { points: [], source, durationSec };
}

/* --------------------------------- файлы --------------------------------- */

function safeFileName(name: string | undefined, fallback: string): string {
  const base = path.basename(String(name ?? '').trim() || fallback);
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  return cleaned.length > 0 ? cleaned.slice(-120) : fallback;
}

function outputFileNameFor(inputName: string | undefined): string {
  const base = safeFileName(inputName, 'video.mp4').replace(/\.[A-Za-z0-9]+$/, '');
  const stem = base.length > 0 ? base : 'video';
  return `vertical-${stem}.mp4`;
}

function looksLikeVideo(file: UploadedFile): boolean {
  const type = (file.contentType ?? '').toLowerCase();
  if (type.startsWith('video/')) return true;
  const ext = path.extname(file.filename ?? '').toLowerCase();
  if (VIDEO_EXTENSIONS.includes(ext)) return true;
  // неизвестный тип не отвергаем: реальную проверку делает ffprobe
  return !type.startsWith('text/') && !type.startsWith('application/json');
}

function scheduleCleanup(job: RenderJob, workDir: string): void {
  waitForJob(job.id)
    .catch(() => undefined)
    .then(() => {
      const timer = setTimeout(() => {
        fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }, 30 * 60 * 1000);
      if (typeof timer.unref === 'function') timer.unref();
    })
    .catch(() => undefined);
}

/* -------------------------------- маршруты -------------------------------- */

async function handleCreate(req: RequestLike, res: ServerResponse): Promise<void> {
  let upload: Upload;
  try {
    upload = await readUpload(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: 'payload_too_large', message: err.message });
      return;
    }
    throw err;
  }

  if (!upload.file && !upload.inputPath) {
    sendJson(res, 400, {
      error: 'no_file',
      message: 'Не передан видеофайл. Загрузите ролик в формате mp4 или mov.',
    });
    return;
  }

  if (upload.file && !looksLikeVideo(upload.file)) {
    sendJson(res, 415, {
      error: 'unsupported_format',
      message: 'Поддерживаются видеофайлы mp4 и mov.',
    });
    return;
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loom-job-'));
  let inputPath: string;
  if (upload.file) {
    inputPath = path.join(workDir, safeFileName(upload.file.filename, 'input.mp4'));
    await fsp.writeFile(inputPath, upload.file.data);
  } else {
    inputPath = upload.inputPath as string;
  }

  const probed = await probeSource(inputPath).catch((err: unknown) => {
    logError('ffprobe', err);
    return null;
  });

  if (!probed) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    sendJson(res, 400, {
      error: 'invalid_video',
      message: 'Не удалось прочитать видеофайл. Загрузите ролик в формате mp4 или mov.',
    });
    return;
  }

  if (probed.durationSec > MAX_DURATION_SEC) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    sendJson(res, 413, {
      error: 'too_long',
      message: `Ролик слишком длинный: максимум ${Math.round(MAX_DURATION_SEC / 60)} минут.`,
    });
    return;
  }

  const source: SourceSize = { width: probed.width, height: probed.height };
  const points = rescalePoints(upload.track.points, upload.track.source, source);
  const durationSec = probed.durationSec > 0 ? probed.durationSec : upload.track.durationSec;

  const job = createJob({
    inputPath,
    outputDir: workDir,
    fileName: outputFileNameFor(upload.file?.filename),
    source,
    durationSec,
    track: points,
  });

  // сначала отдаём jobId, только потом запускаем ffmpeg
  sendJson(res, 200, jobPayload(job));

  try {
    startRender(job);
    scheduleCleanup(job, workDir);
  } catch (err) {
    logError('start-render', err);
  }
}

function handleStatus(res: ServerResponse, id: string): void {
  const job = getJob(id);
  if (!job) {
    sendJson(res, 404, { error: 'not_found', message: 'Задача сборки не найдена.' });
    return;
  }
  sendJson(res, 200, jobPayload(job));
}

async function handleFile(res: ServerResponse, id: string): Promise<void> {
  const job = getJob(id);
  if (!job) {
    sendJson(res, 404, { error: 'not_found', message: 'Задача сборки не найдена.' });
    return;
  }
  if (job.status === 'error') {
    sendJson(res, 500, { error: 'render_failed', message: job.error ?? 'Сборка не удалась.' });
    return;
  }

  let size = 0;
  try {
    const stat = await fsp.stat(job.outputPath);
    size = stat.size;
  } catch {
    size = 0;
  }

  if (job.status !== 'done' || size === 0) {
    sendJson(res, 409, {
      error: 'not_ready',
      message: 'Файл ещё собирается.',
      state: job.status,
      progress: job.progress,
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename="${job.fileName}"`,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });

  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(job.outputPath);
    stream.on('error', (err) => {
      logError('stream', err);
      res.end();
      resolve();
    });
    stream.on('close', () => resolve());
    stream.pipe(res);
  });
}

function handleCancel(res: ServerResponse, id: string): void {
  const job = cancelJob(id);
  if (!job) {
    sendJson(res, 404, { error: 'not_found', message: 'Задача сборки не найдена.' });
    return;
  }
  sendJson(res, 200, jobPayload(job));
}

async function route(req: RequestLike, res: ServerResponse, matched: Matched): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const rest = matched.rest;
  const query = parseQuery(req);

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Length': '0',
    });
    res.end();
    return;
  }

  const first = rest[0] ? normalizeFieldName(rest[0]) : '';
  const second = rest[1] ? normalizeFieldName(rest[1]) : '';

  if (method === 'POST' && (rest.length === 0 || (rest.length === 1 && CREATE_ACTIONS.includes(first)))) {
    await handleCreate(req, res);
    return;
  }

  if (method === 'POST' && rest.length === 2 && CANCEL_ACTIONS.includes(second)) {
    handleCancel(res, rest[0]);
    return;
  }

  const id = rest.length > 0 ? rest[0] : (query.jobid ?? query.id ?? '');

  if (method === 'GET' || method === 'HEAD') {
    if (!id) {
      sendJson(res, 400, { error: 'no_job_id', message: 'Не указан идентификатор задачи.' });
      return;
    }
    if (rest.length >= 2 && FILE_ACTIONS.includes(second)) {
      await handleFile(res, id);
      return;
    }
    if (rest.length >= 2 && !STATUS_ACTIONS.includes(second)) {
      sendJson(res, 404, { error: 'not_found', message: 'Неизвестный маршрут API сборки.' });
      return;
    }
    if (FILE_ACTIONS.includes(normalizeFieldName(query.action ?? ''))) {
      await handleFile(res, id);
      return;
    }
    handleStatus(res, id);
    return;
  }

  sendJson(res, 405, { error: 'method_not_allowed', message: 'Метод не поддерживается.' });
}

/**
 * Обработчик API сборки. Работает и как middleware express (req, res, next),
 * и как обработчик node:http (тогда на «чужие» пути отвечает 404 JSON).
 */
/**
 * @returns true, если запрос относится к API рендера и уже обработан
 * (ответ отправлен или будет отправлен асинхронно) - вызывающая сторона
 * (src/server/index.ts) НЕ должна пытаться отдать статику/404 сама.
 * false - запрос не наш, вызывающая сторона решает сама (статика/404).
 * ВАЖНО: раньше при !matched эта функция САМА слала 404 без вызова next(),
 * из-за чего ЛЮБОЙ путь вне /api/* (включая '/') получал 404 здесь и
 * никогда не доходил до раздачи index.html - сервер технически поднимался,
 * но был "не готов" для любого клиента, включая простой health-check по '/'.
 */
export function handleRenderRequest(req: RequestLike, res: ServerResponse, next?: NextFunction): boolean {
  let matched: Matched | null = null;
  try {
    matched = matchPrefix(requestPath(req));
  } catch (err) {
    logError('match', err);
    matched = null;
  }

  if (!matched) {
    if (typeof next === 'function') next();
    return false;
  }

  route(req, res, matched).catch((err: unknown) => {
    logError('route', err);
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: 'payload_too_large', message: err.message });
      return;
    }
    sendJson(res, 500, {
      error: 'internal_error',
      message: err instanceof Error ? err.message : 'Внутренняя ошибка сервера.',
    });
  });
  return true;
}

/** true, если запрос адресован API сборки. */
export function isRenderApiRequest(req: RequestLike): boolean {
  return matchPrefix(requestPath(req)) !== null;
}

/* --------- совместимые имена: как бы сервер ни подключал этот модуль -------- */

export const renderRoutes = handleRenderRequest;
export const handleRenderRoutes = handleRenderRequest;
export const renderRouter = handleRenderRequest;
export const router = handleRenderRequest;
export const handleRender = handleRenderRequest;
export const renderMiddleware = handleRenderRequest;
export const renderRoutesHandler = handleRenderRequest;
export const renderApi = handleRenderRequest;

export function createRenderRoutes(): typeof handleRenderRequest {
  return handleRenderRequest;
}
export function createRenderRouter(): typeof handleRenderRequest {
  return handleRenderRequest;
}

export function registerRenderRoutes(app?: { use?: (handler: unknown) => unknown }): typeof handleRenderRequest {
  if (app && typeof app.use === 'function') app.use(handleRenderRequest);
  return handleRenderRequest;
}
export const attachRenderRoutes = registerRenderRoutes;
export const mountRenderRoutes = registerRenderRoutes;
export const installRenderRoutes = registerRenderRoutes;
export const useRenderRoutes = registerRenderRoutes;
export const applyRenderRoutes = registerRenderRoutes;
export const setupRenderRoutes = registerRenderRoutes;

export default handleRenderRequest;
