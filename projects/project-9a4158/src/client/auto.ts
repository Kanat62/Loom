/**
 * Автоматическое ведение рамки в браузере.
 *
 * Ролик прогоняется по кадрам с шагом 1/25 c через offscreen video + canvas:
 * каждый кадр отдаётся детектору лиц, звук отдельно даёт огибающую энергии
 * на тех же отсчётах. Полученные frames считаются ядром computeAutoTrack
 * (dist/core/speaker, подгружается лениво по URL из статики); если ядро
 * недоступно или вернуло непонятный результат, работает локальный расчёт
 * с той же логикой (говорящий = лицо, чьи губы шевелятся синхронно с речью;
 * при тишине рамка остаётся на месте).
 */

import { extractEnergyEnvelope } from './audio.js';
import { createFaceSource } from './faceSource.js';
import type { FaceObservation, FaceSource, FaceSourceKind } from './faceSource.js';

export interface AutoFrame {
  t: number;
  energy: number;
  voiced: boolean;
  faces: FaceObservation[];
}

export interface AutoSample {
  /** время в секундах */
  t: number;
  /** центр рамки по X, нормировано к ширине исходного кадра (0..1) */
  x: number;
}

export interface AutoProgress {
  phase: 'audio' | 'video' | 'track' | 'done';
  value: number;
}

export interface AutoAnalysisOptions {
  fps?: number;
  /** пропорция итоговой рамки, по умолчанию 9/16 */
  frameAspect?: number;
  onProgress?: (progress: AutoProgress) => void;
  signal?: AbortSignal;
}

export interface AutoTrackOptions {
  halfWidth: number;
  fps: number;
  duration: number;
  sourceWidth: number;
  sourceHeight: number;
  frameWidth: number;
}

export interface AutoAnalysisResult {
  samples: AutoSample[];
  frames: AutoFrame[];
  faceKind: FaceSourceKind | string;
  duration: number;
  sourceWidth: number;
  sourceHeight: number;
  halfWidth: number;
}

const DEFAULT_FPS = 25;
const DEFAULT_ASPECT = 9 / 16;
const ANALYSIS_MAX_WIDTH = 640;
const MAX_ANALYSIS_FRAMES = 1500;
const SMOOTH_TAU = 0.32;
const SWITCH_HOLD_SEC = 0.3;
const MIN_SPEECH_SCORE = 0.004;
const CORE_URLS = ['/core/speaker.js', '/dist/core/speaker.js', '/js/core/speaker.js'];

/** Импорт по вычисляемому пути: сборщик не разрешает адрес на этапе сборки. */
const dynamicImport: (specifier: string) => Promise<unknown> = (() => {
  try {
    return new Function('s', 'return import(s);') as (s: string) => Promise<unknown>;
  } catch {
    return async () => null;
  }
})();

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function stdev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  return Math.sqrt(acc / n);
}

function abortError(): Error {
  const err = new Error('Анализ отменён');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal && signal.aborted) throw abortError();
}

function waitForEvent(el: HTMLMediaElement, type: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = (): void => {
      el.removeEventListener(type, onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
    };
    const onOk = (): void => {
      clean();
      resolve();
    };
    const onErr = (): void => {
      clean();
      reject(new Error('Не удалось прочитать видеофайл'));
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error('Истекло время ожидания видео (' + type + ')'));
    }, timeoutMs);
    el.addEventListener(type, onOk);
    el.addEventListener('error', onErr);
  });
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      video.removeEventListener('seeked', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    video.addEventListener('seeked', done);
    try {
      video.currentTime = t;
    } catch {
      done();
    }
  });
}

// --- Ядро -------------------------------------------------------------------

type CoreComputeFn = (...args: unknown[]) => unknown;

let coreLoaded = false;
let coreFn: CoreComputeFn | null = null;

async function loadCoreComputeAutoTrack(): Promise<CoreComputeFn | null> {
  if (coreLoaded) return coreFn;
  coreLoaded = true;
  for (const url of CORE_URLS) {
    try {
      const mod = (await dynamicImport(url)) as Record<string, unknown> | null;
      if (!mod) continue;
      const direct = mod['computeAutoTrack'];
      const def = mod['default'] as Record<string, unknown> | undefined;
      const fn = (typeof direct === 'function' ? direct : def && def['computeAutoTrack']) as
        | CoreComputeFn
        | undefined;
      if (typeof fn === 'function') {
        coreFn = fn;
        return coreFn;
      }
    } catch {
      /* следующий адрес; при неудаче считаем локально */
    }
  }
  coreFn = null;
  return null;
}

function normalizeSamples(
  raw: unknown,
  frames: AutoFrame[],
  opts: AutoTrackOptions,
  depth = 0
): AutoSample[] | null {
  if (raw == null || depth > 3) return null;

  if (Array.isArray(raw)) {
    if (!raw.length) return null;
    const out: AutoSample[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as unknown;
      if (typeof item === 'number') {
        const t = frames[i] ? frames[i].t : i / Math.max(1, opts.fps);
        out.push({ t, x: item });
      } else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        const t = [rec['t'], rec['time'], rec['sec']].find((v) => typeof v === 'number') as
          | number
          | undefined;
        const x = [rec['x'], rec['cx'], rec['center'], rec['value']].find(
          (v) => typeof v === 'number'
        ) as number | undefined;
        if (x == null) return null;
        out.push({ t: t != null ? t : frames[i] ? frames[i].t : i / Math.max(1, opts.fps), x });
      } else {
        return null;
      }
    }
    return rescale(out, opts);
  }

  if (typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    for (const key of ['samples', 'track', 'points', 'values', 'xs', 'positions']) {
      if (rec[key] != null) {
        const nested = normalizeSamples(rec[key], frames, opts, depth + 1);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function rescale(samples: AutoSample[], opts: AutoTrackOptions): AutoSample[] {
  let max = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.x)) return [];
    max = Math.max(max, Math.abs(s.x));
  }
  const divisor = max > 1.5 && opts.sourceWidth > 0 ? opts.sourceWidth : 1;
  const half = clamp(opts.halfWidth, 0.01, 0.5);
  return samples
    .filter((s) => Number.isFinite(s.t))
    .map((s) => ({ t: s.t, x: clamp(s.x / divisor, half, 1 - half) }))
    .sort((a, b) => a.t - b.t);
}

/** Расчёт автодорожки: ядро проекта, при неудаче — локальный расчёт. */
export async function computeAutoTrack(
  frames: AutoFrame[],
  opts: AutoTrackOptions
): Promise<AutoSample[]> {
  const core = await loadCoreComputeAutoTrack();
  if (core) {
    const attempts: Array<() => unknown> = [
      () => core(frames, opts),
      () => core({ frames, ...opts }),
      () => core(frames)
    ];
    for (const attempt of attempts) {
      try {
        const result = await Promise.resolve(attempt());
        const samples = normalizeSamples(result, frames, opts);
        if (samples && samples.length) return samples;
      } catch {
        /* пробуем следующую форму вызова */
      }
    }
  }
  return computeAutoTrackLocal(frames, opts);
}

/**
 * Локальный расчёт: говорящий — лицо с наибольшей изменчивостью рта в моменты,
 * когда в звуке есть речь. Переключение с выдержкой, при тишине рамка стоит.
 */
export function computeAutoTrackLocal(frames: AutoFrame[], opts: AutoTrackOptions): AutoSample[] {
  const half = clamp(opts.halfWidth, 0.01, 0.5);
  const out: AutoSample[] = [];
  const mouthHistory = new Map<number, number[]>();
  const smoothCx = new Map<number, number>();

  let currentId: number | null = null;
  let candidateId: number | null = null;
  let candidateSince = 0;
  let target = 0.5;
  let x = 0.5;
  let prevT = frames.length ? frames[0].t : 0;

  for (const frame of frames) {
    const dt = clamp(frame.t - prevT, 0, 0.5);
    prevT = frame.t;

    const scores = new Map<number, number>();
    const present = new Set<number>();
    for (const face of frame.faces) {
      present.add(face.id);
      const history = mouthHistory.get(face.id) || [];
      history.push(face.mouthOpen);
      if (history.length > 12) history.shift();
      mouthHistory.set(face.id, history);

      const prevCx = smoothCx.get(face.id);
      const cx = prevCx == null ? face.cx : prevCx + (face.cx - prevCx) * 0.4;
      smoothCx.set(face.id, cx);

      const variation = stdev(history);
      const voiceGain = frame.voiced ? 1 : 0.15;
      scores.set(face.id, variation * voiceGain * (0.4 + frame.energy));
    }

    let bestId: number | null = null;
    let bestScore = 0;
    for (const entry of Array.from(scores.entries())) {
      if (entry[1] > bestScore) {
        bestScore = entry[1];
        bestId = entry[0];
      }
    }

    if (frame.voiced && bestId != null && bestScore > MIN_SPEECH_SCORE) {
      const currentScore = currentId != null ? scores.get(currentId) || 0 : 0;
      if (currentId == null || bestId === currentId || !present.has(currentId)) {
        currentId = bestId;
        candidateId = null;
      } else if (bestScore > currentScore * 1.3) {
        if (candidateId !== bestId) {
          candidateId = bestId;
          candidateSince = frame.t;
        }
        if (frame.t - candidateSince >= SWITCH_HOLD_SEC) {
          currentId = bestId;
          candidateId = null;
        }
      } else {
        candidateId = null;
      }
    }

    if (currentId != null && present.has(currentId)) {
      const cx = smoothCx.get(currentId);
      if (cx != null) target = cx;
    } else if (currentId == null && frame.faces.length === 1) {
      const only = smoothCx.get(frame.faces[0].id);
      if (only != null) target = only;
    }
    // Если говорящего нет или он ушёл из кадра — цель не меняется:
    // рамка остаётся там, где была, до следующей реплики.

    x += (target - x) * (1 - Math.exp(-dt / SMOOTH_TAU));
    out.push({ t: frame.t, x: clamp(x, half, 1 - half) });
  }

  return out;
}

// --- Прогон ролика ----------------------------------------------------------

async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  await seekTo(video, 1e6);
  if (Number.isFinite(video.duration) && video.duration > 0) {
    await seekTo(video, 0);
    return video.duration;
  }
  throw new Error('Не удалось определить длительность ролика');
}

/** Полный прогон ролика: звук + лица + расчёт автодорожки. */
export async function analyzeAuto(
  file: Blob,
  options: AutoAnalysisOptions = {}
): Promise<AutoAnalysisResult> {
  const fps = options.fps && options.fps > 0 ? options.fps : DEFAULT_FPS;
  const aspect = options.frameAspect && options.frameAspect > 0 ? options.frameAspect : DEFAULT_ASPECT;
  const report = options.onProgress || ((): void => undefined);

  throwIfAborted(options.signal);

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;

  let faceSource: FaceSource | null = null;

  try {
    report({ phase: 'audio', value: 0.01 });
    // Слушатели вешаются ДО присвоения src, иначе событие можно пропустить.
    const metadata = waitForEvent(video, 'loadedmetadata', 30000);
    video.src = url;
    try {
      video.load();
    } catch {
      /* некоторые браузеры уже начали загрузку по src */
    }
    await metadata;

    const duration = await resolveDuration(video);
    const sourceWidth = video.videoWidth || 1920;
    const sourceHeight = video.videoHeight || 1080;
    const frameWidth = Math.min(sourceWidth, sourceHeight * aspect);
    const halfWidth = clamp(frameWidth / sourceWidth / 2, 0.01, 0.5);

    // Шаг 1/fps, но не больше MAX_ANALYSIS_FRAMES кадров на ролик,
    // иначе длинное видео анализируется недопустимо долго.
    const step = Math.max(1 / fps, duration / MAX_ANALYSIS_FRAMES);
    const times: number[] = [];
    for (let t = 0; t < duration - 1e-4; t += step) times.push(Math.round(t * 1e4) / 1e4);
    if (!times.length) times.push(0);

    throwIfAborted(options.signal);
    const envelope = await extractEnergyEnvelope(file, times);
    report({ phase: 'video', value: 0.2 });

    const scale = Math.min(1, ANALYSIS_MAX_WIDTH / sourceWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(sourceWidth * scale));
    canvas.height = Math.max(2, Math.round(sourceHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D недоступен');

    faceSource = await createFaceSource();

    const frames: AutoFrame[] = [];
    for (let i = 0; i < times.length; i++) {
      throwIfAborted(options.signal);
      await seekTo(video, Math.min(times[i], Math.max(0, duration - 1e-3)));
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch {
        /* кадр не удалось отрисовать — считаем его пустым */
      }
      let faces: FaceObservation[] = [];
      try {
        faces = await faceSource.detect({
          canvas,
          width: canvas.width,
          height: canvas.height,
          timeMs: times[i] * 1000
        });
      } catch {
        faces = [];
      }
      frames.push({
        t: times[i],
        energy: envelope.hasAudio ? envelope.energy[i] || 0 : 0.6,
        voiced: envelope.hasAudio ? envelope.voiced[i] === 1 : true,
        faces
      });
      if (i % 4 === 0 || i === times.length - 1) {
        report({ phase: 'video', value: 0.2 + (0.75 * (i + 1)) / times.length });
      }
    }

    report({ phase: 'track', value: 0.96 });
    const samples = await computeAutoTrack(frames, {
      halfWidth,
      fps,
      duration,
      sourceWidth,
      sourceHeight,
      frameWidth
    });
    report({ phase: 'done', value: 1 });

    return {
      samples,
      frames,
      faceKind: faceSource.kind,
      duration,
      sourceWidth,
      sourceHeight,
      halfWidth
    };
  } finally {
    if (faceSource) faceSource.dispose();
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      /* элемент всё равно будет удалён */
    }
    URL.revokeObjectURL(url);
  }
}
