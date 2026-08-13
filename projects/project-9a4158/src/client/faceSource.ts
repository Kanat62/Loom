/**
 * Источник наблюдений о лицах в кадре.
 *
 * Две реализации:
 *  - MediapipeFaceSource — основная, на @mediapipe/tasks-vision (FaceLandmarker).
 *    Библиотека подключается ТОЛЬКО лениво, по URL из статики (public/vendor),
 *    и только если модель /models/face_landmarker.task реально отдаётся
 *    сервером. Никаких bare-импортов в браузерном коде — иначе сборка/загрузка
 *    страницы падает целиком.
 *  - HeuristicFaceSource — запасная: тон кожи + межкадровое движение.
 *
 * Обе отдают одинаковый набор наблюдений, поэтому расчёт автодорожки
 * не знает, откуда пришли данные. createFaceSource() никогда не бросает.
 */

export type FaceSourceKind = 'mediapipe' | 'heuristic';

export interface FaceObservation {
  /** устойчивый идентификатор лица между кадрами */
  id: number;
  /** центр лица по X, нормировано к ширине кадра (0..1) */
  cx: number;
  /** центр лица по Y, нормировано к высоте кадра (0..1) */
  cy: number;
  /** ширина лица, доля кадра */
  w: number;
  /** высота лица, доля кадра */
  h: number;
  /** раскрытие рта 0..1 (для эвристики — активность области рта) */
  mouthOpen: number;
  /** уверенность наблюдения 0..1 */
  score: number;
}

export interface FrameInput {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  timeMs: number;
}

export interface FaceSource {
  readonly kind: FaceSourceKind;
  init(): Promise<boolean>;
  detect(frame: FrameInput): Promise<FaceObservation[]>;
  dispose(): void;
}

const MODEL_URL = '/models/face_landmarker.task';
const WASM_DIRS = ['/vendor/tasks-vision/wasm', '/models/wasm', '/models'];
const MODULE_URLS = [
  '/vendor/tasks-vision/vision_bundle.mjs',
  '/vendor/tasks-vision.mjs',
  '/models/vision_bundle.mjs'
];
const INIT_TIMEOUT_MS = 10000;
const PROBE_TIMEOUT_MS = 4000;

/**
 * Импорт по вычисляемому пути через new Function: сборщик не пытается
 * разрешить путь на этапе компиляции, файл берётся из статики в рантайме.
 */
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

/** Ждёт промис не дольше ms, иначе отдаёт запасное значение. Не бросает. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    p.then(
      (v) => finish(v),
      () => finish(fallback)
    );
  });
}

/** Есть ли ресурс в статике. Никогда не бросает и не висит. */
async function resourceExists(url: string): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  const probe = async (): Promise<boolean> => {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) return true;
      if (head.status === 405 || head.status === 501) {
        const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        return res.ok || res.status === 206;
      }
      return false;
    } catch {
      return false;
    }
  };
  return withTimeout(probe(), PROBE_TIMEOUT_MS, false);
}

/** Присваивает наблюдениям устойчивые идентификаторы между кадрами. */
class IdTracker {
  private prev: Array<{ id: number; cx: number; cy: number }> = [];
  private next = 1;

  reset(): void {
    this.prev = [];
    this.next = 1;
  }

  assign(faces: Array<Omit<FaceObservation, 'id'>>): FaceObservation[] {
    const used = new Set<number>();
    const out: FaceObservation[] = [];
    for (const face of faces) {
      let bestId = -1;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const p of this.prev) {
        if (used.has(p.id)) continue;
        const d = Math.hypot(p.cx - face.cx, p.cy - face.cy);
        if (d < bestDist) {
          bestDist = d;
          bestId = p.id;
        }
      }
      const id = bestId > 0 && bestDist < 0.15 ? bestId : this.next++;
      used.add(id);
      out.push({ id, cx: face.cx, cy: face.cy, w: face.w, h: face.h, mouthOpen: face.mouthOpen, score: face.score });
    }
    this.prev = out.map((f) => ({ id: f.id, cx: f.cx, cy: f.cy }));
    return out;
  }
}

// --- MediaPipe ---------------------------------------------------------------

interface LandmarkPoint {
  x: number;
  y: number;
}

export class MediapipeFaceSource implements FaceSource {
  readonly kind: FaceSourceKind = 'mediapipe';
  private landmarker: {
    detectForVideo: (input: CanvasImageSource, ts: number) => { faceLandmarks?: LandmarkPoint[][] };
    close?: () => void;
  } | null = null;
  private lastTs = -1;
  private tracker = new IdTracker();

  async init(): Promise<boolean> {
    if (typeof document === 'undefined') return false;
    // Сначала модель: нет файла — реализация не используется вовсе.
    if (!(await resourceExists(MODEL_URL))) return false;

    const mod = await this.loadModule();
    if (!mod) return false;

    const rec = mod as Record<string, unknown>;
    const FilesetResolver = rec['FilesetResolver'] as
      | { forVisionTasks: (dir: string) => Promise<unknown> }
      | undefined;
    const FaceLandmarker = rec['FaceLandmarker'] as
      | { createFromOptions: (fileset: unknown, opts: unknown) => Promise<unknown> }
      | undefined;
    if (!FilesetResolver || !FaceLandmarker) return false;

    for (const dir of WASM_DIRS) {
      try {
        const fileset = await FilesetResolver.forVisionTasks(dir);
        const created = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 4
        });
        this.landmarker = created as MediapipeFaceSource['landmarker'];
        if (this.landmarker && typeof this.landmarker.detectForVideo === 'function') return true;
        this.landmarker = null;
      } catch {
        /* следующий каталог wasm */
      }
    }
    return false;
  }

  private async loadModule(): Promise<unknown | null> {
    for (const url of MODULE_URLS) {
      if (!(await resourceExists(url))) continue;
      try {
        const mod = (await dynamicImport(url)) as Record<string, unknown> | null;
        if (!mod) continue;
        if (mod['FaceLandmarker']) return mod;
        const def = mod['default'] as Record<string, unknown> | undefined;
        if (def && def['FaceLandmarker']) return def;
      } catch {
        /* пробуем следующий адрес */
      }
    }
    return null;
  }

  async detect(frame: FrameInput): Promise<FaceObservation[]> {
    if (!this.landmarker) return [];
    const ts = Math.max(Math.round(frame.timeMs), this.lastTs + 1);
    this.lastTs = ts;

    let result: { faceLandmarks?: LandmarkPoint[][] };
    try {
      result = this.landmarker.detectForVideo(frame.canvas, ts);
    } catch {
      return [];
    }

    const list = result && result.faceLandmarks ? result.faceLandmarks : [];
    const faces: Array<Omit<FaceObservation, 'id'>> = [];
    for (const lm of list) {
      if (!lm || lm.length < 20) continue;
      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;
      for (const p of lm) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const w = Math.max(1e-3, maxX - minX);
      const h = Math.max(1e-3, maxY - minY);
      faces.push({
        cx: clamp(minX + w / 2, 0, 1),
        cy: clamp(minY + h / 2, 0, 1),
        w,
        h,
        mouthOpen: this.mouthOpen(lm, h),
        score: 1
      });
    }
    return this.tracker.assign(faces);
  }

  private mouthOpen(lm: LandmarkPoint[], faceHeight: number): number {
    const upper = lm[13];
    const lower = lm[14];
    if (!upper || !lower) return 0;
    const gap = Math.hypot(lower.x - upper.x, lower.y - upper.y);
    const leftEye = lm[33];
    const rightEye = lm[263];
    const scale =
      leftEye && rightEye ? Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) : faceHeight;
    return clamp(gap / Math.max(1e-4, scale * 0.45), 0, 1);
  }

  dispose(): void {
    try {
      if (this.landmarker && typeof this.landmarker.close === 'function') this.landmarker.close();
    } catch {
      /* закрытие необязательно */
    }
    this.landmarker = null;
    this.tracker.reset();
  }
}

// --- Эвристика ---------------------------------------------------------------

export class HeuristicFaceSource implements FaceSource {
  readonly kind: FaceSourceKind = 'heuristic';
  private work: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private prevLuma: Float32Array | null = null;
  private tracker = new IdTracker();
  private readonly cols = 96;

  async init(): Promise<boolean> {
    if (typeof document === 'undefined') return false;
    this.work = document.createElement('canvas');
    this.ctx = this.work.getContext('2d', { willReadFrequently: true });
    return !!this.ctx;
  }

  async detect(frame: FrameInput): Promise<FaceObservation[]> {
    if (!this.work || !this.ctx || !frame.width || !frame.height) return [];

    const w = this.cols;
    const h = Math.max(8, Math.round((w * frame.height) / frame.width));
    if (this.work.width !== w || this.work.height !== h) {
      this.work.width = w;
      this.work.height = h;
      this.prevLuma = null;
    }

    try {
      this.ctx.drawImage(frame.canvas, 0, 0, w, h);
    } catch {
      return [];
    }

    let data: Uint8ClampedArray;
    try {
      data = this.ctx.getImageData(0, 0, w, h).data;
    } catch {
      return [];
    }

    const luma = new Float32Array(w * h);
    const skin = new Uint8Array(w * h);
    for (let i = 0, px = 0; px < w * h; px++, i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      luma[px] = 0.299 * r + 0.587 * g + 0.114 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const isSkin =
        r > 95 && g > 40 && b > 20 && max - min > 15 && Math.abs(r - g) > 15 && r > g && r > b;
      skin[px] = isSkin ? 1 : 0;
    }

    const motion = new Float32Array(w * h);
    if (this.prevLuma && this.prevLuma.length === luma.length) {
      for (let px = 0; px < luma.length; px++) motion[px] = Math.abs(luma[px] - this.prevLuma[px]);
    }
    this.prevLuma = luma;

    const colSkin = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) colSkin[x] += skin[row + x];
    }
    const smoothed = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let d = -2; d <= 2; d++) {
        const xi = x + d;
        if (xi < 0 || xi >= w) continue;
        sum += colSkin[xi];
        n++;
      }
      smoothed[x] = sum / Math.max(1, n);
    }

    const threshold = Math.max(1.5, h * 0.08);
    const segments = this.segments(smoothed, threshold, Math.max(3, Math.round(w * 0.04)));

    const faces: Array<Omit<FaceObservation, 'id'>> = [];
    for (const seg of segments.slice(0, 3)) {
      let minY = h;
      let maxY = 0;
      let weight = 0;
      let cxAcc = 0;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = seg.from; x <= seg.to; x++) {
          if (!skin[row + x]) continue;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          cxAcc += x;
          weight++;
        }
      }
      if (weight < 6) continue;
      const cx = cxAcc / weight / w;
      const top = minY / h;
      const bottom = (maxY + 1) / h;
      const faceH = Math.max(1e-3, bottom - top);
      const faceW = Math.max(1e-3, (seg.to - seg.from + 1) / w);

      // область рта — нижняя треть найденного пятна кожи
      const mouthTop = Math.floor(minY + (maxY - minY) * 0.6);
      let motionSum = 0;
      let motionCount = 0;
      for (let y = mouthTop; y <= maxY; y++) {
        const row = y * w;
        for (let x = seg.from; x <= seg.to; x++) {
          motionSum += motion[row + x];
          motionCount++;
        }
      }
      const mouthOpen = motionCount ? clamp(motionSum / motionCount / 12, 0, 1) : 0;

      faces.push({
        cx: clamp(cx, 0, 1),
        cy: clamp(top + faceH / 2, 0, 1),
        w: faceW,
        h: faceH,
        mouthOpen,
        score: clamp(weight / Math.max(1, faceW * w * h), 0, 1)
      });
    }

    if (!faces.length) {
      // Кожи не нашли — ведём по самому подвижному участку кадра.
      const colMotion = new Float32Array(w);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) colMotion[x] += motion[row + x];
      }
      let bestX = -1;
      let bestVal = 0;
      for (let x = 0; x < w; x++) {
        if (colMotion[x] > bestVal) {
          bestVal = colMotion[x];
          bestX = x;
        }
      }
      if (bestX >= 0 && bestVal / h > 3) {
        faces.push({
          cx: clamp(bestX / w, 0, 1),
          cy: 0.5,
          w: 0.15,
          h: 0.3,
          mouthOpen: clamp(bestVal / h / 24, 0, 1),
          score: 0.3
        });
      }
    }

    return this.tracker.assign(faces);
  }

  private segments(
    values: Float32Array,
    threshold: number,
    minWidth: number
  ): Array<{ from: number; to: number; mass: number }> {
    const out: Array<{ from: number; to: number; mass: number }> = [];
    let from = -1;
    let mass = 0;
    for (let x = 0; x < values.length; x++) {
      const above = values[x] >= threshold;
      if (above) {
        if (from < 0) {
          from = x;
          mass = 0;
        }
        mass += values[x];
      } else if (from >= 0) {
        if (x - from >= minWidth) out.push({ from, to: x - 1, mass });
        from = -1;
      }
    }
    if (from >= 0 && values.length - from >= minWidth) {
      out.push({ from, to: values.length - 1, mass });
    }
    out.sort((a, b) => b.mass - a.mass);
    return out;
  }

  dispose(): void {
    this.prevLuma = null;
    this.tracker.reset();
    this.work = null;
    this.ctx = null;
  }
}

/**
 * Выбирает доступный источник лиц: сначала MediaPipe с локальной моделью,
 * при её отсутствии (или при затянувшейся инициализации) — эвристику.
 * Никогда не бросает.
 */
export async function createFaceSource(): Promise<FaceSource> {
  const mediapipe = new MediapipeFaceSource();
  let ok = false;
  try {
    ok = await withTimeout(mediapipe.init(), INIT_TIMEOUT_MS, false);
  } catch {
    ok = false;
  }
  if (ok) return mediapipe;
  mediapipe.dispose();

  const heuristic = new HeuristicFaceSource();
  try {
    await heuristic.init();
  } catch {
    /* эвристика работает и без прогрева */
  }
  return heuristic;
}
