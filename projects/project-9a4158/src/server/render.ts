/**
 * Финальный рендер вертикального ролика 9:16 + очередь задач рендера.
 *
 * ГЕОМЕТРИЯ (единственный источник истины — src/core/geometry.ts, функции
 * outWidth()/frameWidth()/outHeight()/clampFrameLeft()/cropXForOutput()/
 * cropRect(); клиент рисует превью ТЕМИ ЖЕ функциями, поэтому кадр файла
 * совпадает с превью пиксель в пиксель):
 *
 *   outHeight = высота исходного кадра, БЕЗ масштабирования (чётная)
 *   outWidth  = toEven(outHeight * 9 / 16), не больше ширины исходника
 *               ← ОДНА общая функция для клиента (frameWidth) и сервера
 *                 (outWidth === frameWidth, это один и тот же код)
 *   x         = значение трека, т.е. ЛЕВЫЙ край рамки в координатах ИСХОДНОГО
 *               кадра, целое, clamp(0 .. srcWidth - outWidth), выровненное
 *               вниз до чётного (cropXForOutput) — ровно так же, как это
 *               делает сам фильтр crop для yuv420p
 *   y         = 0 (рамка всегда во всю высоту кадра)
 *
 * Итоговый кадр = crop(source, x, 0, outWidth, outHeight). Ничего сверх
 * обрезки:
 *   - нет scale, нет pad, нет setsar/setdar, нет смены пропорций;
 *   - нет -r и нет setpts: частота кадров и таймстемпы остаются исходными
 *     (-fps_mode passthrough, старое имя -vsync passthrough);
 *   - звук копируется как есть (-c:a copy), fallback на aac только если
 *     контейнер mp4 физически не принимает исходный аудиокодек.
 * Следствие: при ПОСТОЯННОМ треке кадр результата в момент t покадрово
 * совпадает с crop исходного кадра в тот же момент t.
 *
 * Цепочка фильтров строго такая:
 *   sendcmd=f='crop.cmd',crop=w=OUT_W:h=SRC_H:x=X0:y=0
 * где OUT_W/SRC_H — фиксированные ЧИСЛА (не выражения от in_w/in_h), а X0 —
 * первый сэмпл трека (чтобы интервал до первой команды не уехал). Движение
 * рамки во времени задаётся командами sendcmd `crop x <целое>` — теми же
 * целыми значениями, которые клиент использовал в превью, без интерполяции.
 *
 * Файл команд лежит в рабочем каталоге процесса ffmpeg и передаётся ОТНОСИТЕЛЬНЫМ
 * именем: абсолютный путь Windows (C:\...) содержит двоеточие, которое в
 * filtergraph трактуется как разделитель опций и ломает разбор фильтра.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import {
  centeredFrameLeft,
  clampFrameLeft,
  cropRect,
  cropXForOutput,
  frameLeftFromCenter,
  frameWidth,
  isValidSize,
  outHeight,
  outWidth,
  type CropRect,
  type SourceSize,
} from '../core/geometry.js';

export type { CropRect, SourceSize };
// Ре-экспорт общей геометрии: сервер и клиент считают её ОДНИМ кодом.
export { outWidth, outHeight, frameWidth, cropRect, clampFrameLeft, cropXForOutput };

/** Точка трека: время в секундах + левый край рамки в пикселях исходника. */
export interface TrackPoint {
  t: number;
  x: number;
}

/**
 * Терпимый к формату вход: помимо {t, x} принимаются time/left (пиксели),
 * cx/center (центр в пикселях), nx/ncx (нормированные 0..1).
 */
export interface LooseTrackPoint {
  t?: number;
  time?: number;
  x?: number;
  left?: number;
  cx?: number;
  center?: number;
  nx?: number;
  ncx?: number;
}

export interface RenderRequest {
  inputPath: string;
  outputPath: string;
  /** Размер исходного кадра. Если не задан — берётся из ffprobe. */
  source?: SourceSize;
  /** Длительность исходника в секундах (для прогресса). Необязательно. */
  durationSec?: number;
  track?: readonly LooseTrackPoint[];
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  outputPath: string;
  width: number;
  height: number;
  durationSec: number;
  source: SourceSize;
}

export interface ProbedSource {
  width: number;
  height: number;
  durationSec: number;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecOptions {
  onProgress?: (fraction: number) => void;
  durationSec?: number;
  signal?: AbortSignal;
  cwd?: string;
}

const DEFAULT_FFMPEG = 'ffmpeg';
const DEFAULT_FFPROBE = 'ffprobe';

/** Имя файла команд sendcmd внутри рабочего каталога рендера. */
const CMD_FILE_NAME = 'crop.cmd';

/**
 * Качество кодирования. Обрезка обязана быть визуально неотличима от исходника,
 * поэтому CRF низкий; переопределяется переменной окружения LOOM_RENDER_CRF.
 */
function videoCrf(): string {
  const raw = process.env.LOOM_RENDER_CRF;
  const value = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(value) && value >= 0 && value <= 51) return String(Math.round(value));
  return '16';
}

function pickPath(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const p = (value as { path?: unknown }).path;
    if (typeof p === 'string' && p.length > 0) return p;
  }
  return undefined;
}

/**
 * Путь к бинарю. Спецификатор пакета собирается в рантайме, поэтому бандлер
 * не вшивает пакет в бандл и сборка не падает, если пакета нет в зависимостях.
 */
async function resolveBinary(envVar: string, packageParts: string[], fallback: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const specifier = packageParts.join('-');
  try {
    const mod: unknown = await import(specifier);
    const direct = pickPath(mod);
    if (direct) return direct;
    const fromDefault = pickPath((mod as { default?: unknown } | null)?.default);
    if (fromDefault) return fromDefault;
  } catch {
    // пакета нет — используем бинарь из PATH
  }
  return fallback;
}

let ffmpegPromise: Promise<string> | null = null;
let ffprobePromise: Promise<string> | null = null;

export function ffmpegBinary(): Promise<string> {
  if (!ffmpegPromise) ffmpegPromise = resolveBinary('FFMPEG_PATH', ['ffmpeg', 'static'], DEFAULT_FFMPEG);
  return ffmpegPromise;
}

export function ffprobeBinary(): Promise<string> {
  if (!ffprobePromise) ffprobePromise = resolveBinary('FFPROBE_PATH', ['ffprobe', 'static'], DEFAULT_FFPROBE);
  return ffprobePromise;
}

function execProcess(bin: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: options.cwd });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let pending = '';

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
    };

    if (options.signal) {
      if (options.signal.aborted) child.kill('SIGKILL');
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (!options.onProgress) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        const match = /^out_time_us=(-?[0-9]+)$/.exec(line);
        if (match && options.durationSec && options.durationSec > 0) {
          const seconds = Number(match[1]) / 1e6;
          const fraction = seconds / options.durationSec;
          options.onProgress(fraction < 0 ? 0 : fraction > 1 ? 1 : fraction);
        } else if (line === 'progress=end') {
          options.onProgress(1);
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64000) stderr = stderr.slice(-32000);
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function probeSource(inputPath: string): Promise<ProbedSource> {
  const bin = await ffprobeBinary();
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    resolvePath(inputPath),
  ];
  const { code, stdout, stderr } = await execProcess(bin, args);
  if (code !== 0) {
    throw new Error(`ffprobe завершился с кодом ${code}: ${stderr.trim() || 'нет вывода'}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ffprobe вернул некорректный JSON');
  }
  const stream = parsed?.streams?.[0] ?? {};
  const width = Number(stream.width);
  const height = Number(stream.height);
  const durationSec = Number(parsed?.format?.duration ?? stream.duration ?? 0) || 0;
  if (!(width > 0 && height > 0)) {
    throw new Error('ffprobe не вернул размеры видеопотока');
  }
  return { width, height, durationSec };
}

/** Приводит любой поддерживаемый формат точки к {t, x} с целым x внутри кадра. */
export function normalizeTrack(track: readonly LooseTrackPoint[] | undefined, source: SourceSize): TrackPoint[] {
  if (!track || track.length === 0) return [];
  const points: TrackPoint[] = [];
  for (const raw of track) {
    if (!raw || typeof raw !== 'object') continue;
    const time = typeof raw.t === 'number' ? raw.t : typeof raw.time === 'number' ? raw.time : NaN;
    if (!Number.isFinite(time) || time < 0) continue;

    let left: number | undefined;
    if (typeof raw.x === 'number' && Number.isFinite(raw.x)) left = raw.x;
    else if (typeof raw.left === 'number' && Number.isFinite(raw.left)) left = raw.left;
    else if (typeof raw.nx === 'number' && Number.isFinite(raw.nx)) left = raw.nx * source.width;
    else if (typeof raw.cx === 'number' && Number.isFinite(raw.cx)) left = frameLeftFromCenter(raw.cx, source);
    else if (typeof raw.center === 'number' && Number.isFinite(raw.center)) left = frameLeftFromCenter(raw.center, source);
    else if (typeof raw.ncx === 'number' && Number.isFinite(raw.ncx)) left = frameLeftFromCenter(raw.ncx * source.width, source);
    if (left === undefined) continue;

    points.push({ t: time, x: clampFrameLeft(left, source) });
  }

  points.sort((a, b) => a.t - b.t);

  // одна точка на момент времени: побеждает последняя записанная
  const deduped: TrackPoint[] = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.t - point.t) < 1e-9) deduped[deduped.length - 1] = point;
    else deduped.push(point);
  }
  return deduped;
}

/**
 * Приводит x каждой точки к тому целому значению, которое реально получит
 * фильтр crop (см. cropXForOutput). Ровно эти же числа использует клиент,
 * рисуя превью через cropRect().
 */
export function alignTrackForCrop(points: readonly TrackPoint[], source: SourceSize): TrackPoint[] {
  return points.map((point) => ({ t: point.t, x: cropXForOutput(point.x, source) }));
}

function formatTime(seconds: number): string {
  return (seconds < 0 ? 0 : seconds).toFixed(6);
}

/**
 * Скрипт для фильтра sendcmd: интервал [начало-конец] и команда `crop x <int>`
 * на входе в интервал. Первая точка ставится на 0 (её значение уже стоит
 * дефолтом в самой строке crop), повторяющиеся подряд значения x пропускаются.
 */
export function buildSendCmdScript(points: readonly TrackPoint[], durationSec?: number): string {
  if (points.length === 0) return '';
  const lines: string[] = [];
  let previousX: number | null = null;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const start = i === 0 ? 0 : point.t;
    const next = points[i + 1];
    const tail = durationSec && durationSec > start ? durationSec : start + 1;
    const stop = next && next.t > start ? next.t : tail + 1;
    if (!(stop > start)) continue;
    if (previousX !== null && previousX === point.x) continue;
    lines.push(`${formatTime(start)}-${formatTime(stop)} [enter] crop x ${point.x};`);
    previousX = point.x;
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** Экранирование пути внутри filtergraph (значение берётся в одинарные кавычки). */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/'/g, "\\'");
}

/**
 * `crop=w=OUT_W:h=SRC_H:x=X0:y=0` — w/h фиксированные числа, x — стартовое
 * значение трека; дальше x меняют только команды sendcmd.
 */
export function buildFilter(crop: CropRect, cmdFilePath: string | null): string {
  const cropPart = `crop=w=${crop.width}:h=${crop.height}:x=${crop.x}:y=${crop.y}`;
  if (!cmdFilePath) return cropPart;
  return `sendcmd=f='${escapeFilterPath(cmdFilePath)}',${cropPart}`;
}

function buildArgs(
  inputPath: string,
  outputPath: string,
  filter: string,
  syncFlag: string[],
  audio: 'copy' | 'aac',
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'error',
    '-nostats',
    '-progress', 'pipe:1',
    '-y',
    '-i', inputPath,
    '-filter_complex', `[0:v]${filter}[vout]`,
    '-map', '[vout]',
    '-map', '0:a?',
    // только обрезка: ни scale, ни pad, ни -r, ни setpts
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', videoCrf(),
    '-pix_fmt', 'yuv420p',
    ...syncFlag,
    '-c:a', audio,
    ...(audio === 'aac' ? ['-b:a', '192k'] : []),
    '-movflags', '+faststart',
    outputPath,
  ];
}

export async function renderVertical(request: RenderRequest): Promise<RenderResult> {
  if (!request?.inputPath) throw new Error('renderVertical: не задан inputPath');
  if (!request?.outputPath) throw new Error('renderVertical: не задан outputPath');

  // абсолютные пути: рабочий каталог процесса ffmpeg подменяется на временный
  const inputPath = resolvePath(request.inputPath);
  const outputPath = resolvePath(request.outputPath);

  let source = request.source;
  let durationSec = request.durationSec;

  if (!isValidSize(source) || !(typeof durationSec === 'number' && durationSec > 0)) {
    const probed = await probeSource(inputPath).catch(() => null);
    if (!isValidSize(source)) {
      if (!probed) throw new Error('Не удалось определить размер исходного кадра');
      source = { width: probed.width, height: probed.height };
    }
    if (!(typeof durationSec === 'number' && durationSec > 0) && probed && probed.durationSec > 0) {
      durationSec = probed.durationSec;
    }
  }

  const size = source as SourceSize;
  const width = outWidth(size);
  const height = outHeight(size);
  const points = alignTrackForCrop(normalizeTrack(request.track, size), size);
  const initialX = points.length > 0 ? points[0].x : centeredFrameLeft(size);
  const crop = cropRect(initialX, size);
  const script = buildSendCmdScript(points, durationSec);

  const workDir = await mkdtemp(join(tmpdir(), 'loom-render-'));
  const cmdPath = join(workDir, CMD_FILE_NAME);

  try {
    let cmdFile: string | null = null;
    if (script.length > 0) {
      await writeFile(cmdPath, script, 'utf8');
      cmdFile = CMD_FILE_NAME;
    }

    const filter = buildFilter(crop, cmdFile);
    const bin = await ffmpegBinary();

    let syncFlag = ['-fps_mode', 'passthrough'];
    let audio: 'copy' | 'aac' = 'copy';
    let lastError = '';

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (request.signal?.aborted) throw new Error('Рендер отменён');
      const args = buildArgs(inputPath, outputPath, filter, syncFlag, audio);
      const result = await execProcess(bin, args, {
        onProgress: request.onProgress,
        durationSec,
        signal: request.signal,
        cwd: workDir,
      });

      if (result.code === 0) {
        request.onProgress?.(1);
        return {
          outputPath,
          width,
          height,
          durationSec: durationSec ?? 0,
          source: size,
        };
      }

      lastError = result.stderr.trim();

      // старые сборки ffmpeg не знают -fps_mode, у них тот же смысл у -vsync
      if (syncFlag[0] === '-fps_mode' && /fps_mode|Unrecognized option|Option not found/i.test(lastError)) {
        syncFlag = ['-vsync', 'passthrough'];
        continue;
      }
      // аудиокодек исходника несовместим с mp4 — перекодируем звук, картинку не трогаем
      if (audio === 'copy' && /(audio|codec|Invalid data|not supported|incompatible|could not|muxer)/i.test(lastError)) {
        audio = 'aac';
        continue;
      }

      throw new Error(`ffmpeg завершился с кодом ${result.code}: ${lastError || 'нет вывода'}`);
    }

    throw new Error(`ffmpeg не смог собрать файл: ${lastError || 'нет вывода'}`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------------ *
 *  Очередь задач рендера: createJob → startRender → getJob (опрос прогресса)
 * ------------------------------------------------------------------------ */

export type RenderJobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

/** Публичное состояние задачи — объект безопасно отдавать в res.json(). */
export interface RenderJob {
  id: string;
  status: RenderJobStatus;
  /** Алиас status: некоторые роуты читают job.state. */
  state: RenderJobStatus;
  /** Прогресс 0..1. */
  progress: number;
  /** Прогресс 0..100 (целое). */
  percent: number;
  error?: string;
  inputPath?: string;
  outputPath: string;
  fileName: string;
  width?: number;
  height?: number;
  durationSec?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateJobInput {
  id?: string;
  inputPath?: string;
  outputPath?: string;
  outputDir?: string;
  fileName?: string;
  source?: SourceSize;
  width?: number;
  height?: number;
  durationSec?: number;
  duration?: number;
  track?: readonly LooseTrackPoint[];
}

export interface StartRenderOptions extends CreateJobInput {
  onProgress?: (fraction: number) => void;
}

interface JobInternal {
  job: RenderJob;
  source?: SourceSize;
  track: LooseTrackPoint[];
  controller?: AbortController;
  promise?: Promise<RenderJob>;
}

const jobs = new Map<string, JobInternal>();
let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `job_${Date.now().toString(36)}_${jobCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function touch(job: RenderJob, status?: RenderJobStatus): void {
  if (status) {
    job.status = status;
    job.state = status;
  }
  job.updatedAt = Date.now();
}

function readSize(input: CreateJobInput): SourceSize | undefined {
  if (isValidSize(input.source)) return { width: input.source.width, height: input.source.height };
  const w = Number(input.width);
  const h = Number(input.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  return undefined;
}

function readDuration(input: CreateJobInput): number | undefined {
  const value = typeof input.durationSec === 'number' ? input.durationSec : input.duration;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function applyInput(entry: JobInternal, input: CreateJobInput): void {
  const { job } = entry;
  if (typeof input.inputPath === 'string' && input.inputPath.length > 0) job.inputPath = input.inputPath;
  if (typeof input.outputPath === 'string' && input.outputPath.length > 0) job.outputPath = input.outputPath;
  if (typeof input.fileName === 'string' && input.fileName.length > 0) job.fileName = input.fileName;

  const size = readSize(input);
  if (size) {
    entry.source = size;
    job.width = outWidth(size);
    job.height = outHeight(size);
  }

  const duration = readDuration(input);
  if (duration !== undefined) job.durationSec = duration;

  if (Array.isArray(input.track)) entry.track = input.track.slice();

  touch(job);
}

/** Создаёт задачу рендера. Принимает объект настроек или просто путь к файлу. */
export function createJob(input: CreateJobInput | string = {}): RenderJob {
  const opts: CreateJobInput = typeof input === 'string' ? { inputPath: input } : (input ?? {});
  const id = typeof opts.id === 'string' && opts.id.length > 0 ? opts.id : nextJobId();
  const fileName = typeof opts.fileName === 'string' && opts.fileName.length > 0 ? opts.fileName : `vertical-${id}.mp4`;
  const dir = typeof opts.outputDir === 'string' && opts.outputDir.length > 0 ? opts.outputDir : tmpdir();
  const now = Date.now();

  const job: RenderJob = {
    id,
    status: 'pending',
    state: 'pending',
    progress: 0,
    percent: 0,
    outputPath: typeof opts.outputPath === 'string' && opts.outputPath.length > 0 ? opts.outputPath : join(dir, fileName),
    fileName,
    createdAt: now,
    updatedAt: now,
  };

  const entry: JobInternal = { job, track: [] };
  jobs.set(id, entry);
  applyInput(entry, opts);
  return job;
}

/** Возвращает задачу по id (или сам объект задачи, если передали его). */
export function getJob(id: string | RenderJob | null | undefined): RenderJob | undefined {
  if (!id) return undefined;
  const key = typeof id === 'string' ? id : id.id;
  return jobs.get(key)?.job;
}

export function listJobs(): RenderJob[] {
  return Array.from(jobs.values(), (entry) => entry.job);
}

export function removeJob(id: string | RenderJob): boolean {
  const key = typeof id === 'string' ? id : id.id;
  return jobs.delete(key);
}

export function cancelJob(id: string | RenderJob): RenderJob | undefined {
  const key = typeof id === 'string' ? id : id.id;
  const entry = jobs.get(key);
  if (!entry) return undefined;
  entry.controller?.abort();
  if (entry.job.status === 'pending' || entry.job.status === 'running') {
    touch(entry.job, 'cancelled');
  }
  return entry.job;
}

/** Ждёт завершения задачи (для тестов и синхронных сценариев). */
export function waitForJob(id: string | RenderJob): Promise<RenderJob | undefined> {
  const key = typeof id === 'string' ? id : id.id;
  const entry = jobs.get(key);
  if (!entry) return Promise.resolve(undefined);
  return entry.promise ?? Promise.resolve(entry.job);
}

function resolveEntry(
  target: RenderJob | CreateJobInput | string | undefined,
  options: StartRenderOptions,
): JobInternal {
  if (typeof target === 'string') {
    const existing = jobs.get(target);
    if (existing) return existing;
    // строка — не id, значит это путь к исходному файлу
    const created = createJob({ ...options, inputPath: target });
    return jobs.get(created.id) as JobInternal;
  }
  if (target && typeof target === 'object') {
    const maybeId = (target as RenderJob).id;
    if (typeof maybeId === 'string') {
      const existing = jobs.get(maybeId);
      if (existing) return existing;
    }
    const created = createJob(target as CreateJobInput);
    return jobs.get(created.id) as JobInternal;
  }
  const created = createJob(options);
  return jobs.get(created.id) as JobInternal;
}

/**
 * Запускает рендер задачи в фоне и СРАЗУ возвращает её состояние —
 * прогресс потом опрашивается через getJob(id).
 */
export function startRender(
  target?: RenderJob | CreateJobInput | string,
  options: StartRenderOptions = {},
): RenderJob {
  const entry = resolveEntry(target, options);
  applyInput(entry, options);
  const { job } = entry;

  if (job.status === 'running' || job.status === 'done') return job;

  if (!job.inputPath) {
    job.error = 'Не задан путь к исходному файлу';
    touch(job, 'error');
    return job;
  }

  const controller = new AbortController();
  entry.controller = controller;
  job.error = undefined;
  job.progress = 0;
  job.percent = 0;
  touch(job, 'running');

  entry.promise = renderVertical({
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    source: entry.source,
    durationSec: job.durationSec,
    track: entry.track,
    signal: controller.signal,
    onProgress: (fraction) => {
      const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
      job.progress = clamped;
      job.percent = Math.round(clamped * 100);
      touch(job);
      try {
        options.onProgress?.(clamped);
      } catch {
        // колбэк вызывающего не должен ронять рендер
      }
    },
  })
    .then((result) => {
      job.width = result.width;
      job.height = result.height;
      if (result.durationSec > 0) job.durationSec = result.durationSec;
      job.outputPath = result.outputPath;
      job.progress = 1;
      job.percent = 100;
      touch(job, 'done');
      return job;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      job.error = message;
      touch(job, controller.signal.aborted ? 'cancelled' : 'error');
      return job;
    });

  return job;
}

export const render = renderVertical;
export default renderVertical;
