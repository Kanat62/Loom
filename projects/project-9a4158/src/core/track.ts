export type TrackSample = { t: number; x: number };

export type SampleSource = 'manual' | 'auto' | 'none';

export interface TrackSampleResult {
  x: number;
  source: SampleSource;
}

export interface CreateTrackOptions {
  duration: number;
  videoWidth: number;
  frameWidth: number;
}

export interface Track {
  clampX(x: number): number;
  setAuto(samples: TrackSample[]): void;
  recordManual(t: number, x: number): void;
  sampleAt(t: number): TrackSampleResult;
  hasManualAt(t: number): boolean;
  reset(): void;
}

const MANUAL_QUANT_STEP = 0.05;
const MANUAL_GAP_THRESHOLD = 0.35;
const EPS = 1e-9;

/**
 * Нормализованный центр диапазона [0,1] — используется модулем
 * определения говорящего (speaker.ts) как значение по умолчанию,
 * когда пока не на кого ориентироваться.
 */
export const CENTER = 0.5;

/**
 * Зажимает нормализованное значение в диапазон [0,1].
 * Используется модулем определения говорящего (speaker.ts) для
 * нормализованных координат до перевода их в пиксели видео.
 */
export function clamp01(v: number): number {
  if (Number.isNaN(v)) return CENTER;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Создаёт дорожку положений вертикальной рамки во времени.
 *
 * Дорожка состоит из двух слоёв:
 *  - auto  — заполняется целиком через setAuto(), источник по умолчанию;
 *  - manual — заполняется точечно через recordManual() при ручном ведении
 *             мышью, перекрывает auto на тех отрезках, где были ручные
 *             выборки.
 *
 * Никакой связи с DOM/браузером — чистая функция состояния.
 */
export function createTrack(options: CreateTrackOptions): Track {
  const { videoWidth, frameWidth } = options;

  let autoSamples: TrackSample[] = [];
  // Ключ — квантованное время (в шагах MANUAL_QUANT_STEP), значение —
  // сама выборка. Повторная запись в тот же квантованный момент
  // перезаписывает предыдущую.
  let manualSamples: Map<number, TrackSample> = new Map();

  function clampX(x: number): number {
    const max = Math.max(0, videoWidth - frameWidth);
    if (x < 0) return 0;
    if (x > max) return max;
    return x;
  }

  function quantizeTime(t: number): number {
    const key = Math.round(t / MANUAL_QUANT_STEP);
    return key * MANUAL_QUANT_STEP;
  }

  function setAuto(samples: TrackSample[]): void {
    autoSamples = samples
      .map((s) => ({ t: s.t, x: clampX(s.x) }))
      .sort((a, b) => a.t - b.t);
  }

  function recordManual(t: number, x: number): void {
    const qt = quantizeTime(t);
    const key = Math.round(qt / MANUAL_QUANT_STEP);
    manualSamples.set(key, { t: qt, x: clampX(x) });
  }

  function getManualSorted(): TrackSample[] {
    return Array.from(manualSamples.values()).sort((a, b) => a.t - b.t);
  }

  /** Линейная интерполяция x по отсортированному массиву выборок. */
  function interpolate(samples: TrackSample[], t: number): number | null {
    if (samples.length === 0) return null;
    if (samples.length === 1) return samples[0].x;
    if (t <= samples[0].t) return samples[0].x;
    const last = samples[samples.length - 1];
    if (t >= last.t) return last.x;

    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const a = samples[lo];
    const b = samples[hi];
    if (b.t - a.t < EPS) return a.x;
    const ratio = (t - a.t) / (b.t - a.t);
    return a.x + (b.x - a.x) * ratio;
  }

  /**
   * Определяет, попадает ли момент t в записанный вручную отрезок:
   *  - точное совпадение с какой-либо ручной выборкой — всегда попадание;
   *  - иначе t должен лежать между двумя соседними ручными выборками,
   *    расстояние между которыми не превышает MANUAL_GAP_THRESHOLD.
   */
  function isInManualSegment(samples: TrackSample[], t: number): boolean {
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i].t - t) < EPS) {
        return true;
      }
    }
    if (samples.length < 2) return false;
    if (t < samples[0].t || t > samples[samples.length - 1].t) {
      return false;
    }

    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].t <= t) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    const a = samples[lo];
    const b = samples[hi];
    const gap = b.t - a.t;
    return gap <= MANUAL_GAP_THRESHOLD + EPS && t >= a.t && t <= b.t;
  }

  function hasManualAt(t: number): boolean {
    return isInManualSegment(getManualSorted(), t);
  }

  function sampleAt(t: number): TrackSampleResult {
    const manual = getManualSorted();
    if (isInManualSegment(manual, t)) {
      const x = interpolate(manual, t);
      if (x !== null) {
        return { x, source: 'manual' };
      }
    }
    if (autoSamples.length > 0) {
      const x = interpolate(autoSamples, t);
      if (x !== null) {
        return { x, source: 'auto' };
      }
    }
    return { x: clampX(0), source: 'none' };
  }

  function reset(): void {
    autoSamples = [];
    manualSamples = new Map();
  }

  return {
    clampX,
    setAuto,
    recordManual,
    sampleAt,
    hasManualAt,
    reset,
  };
}
