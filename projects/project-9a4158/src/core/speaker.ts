/**
 * Ядро автоматического ведения рамки: выбор активного говорящего по
 * корреляции движения губ со звуковой энергией (с устойчивым запасным
 * механизмом по уровню открытия рта, когда корреляция не определена —
 * например при ступенчатых синтетических сигналах без локальной
 * дисперсии) и построение сглаженной дорожки x-координат рамки.
 * Чистый модуль без DOM и без сети.
 */

export interface SpeakerFace {
  id: string | number;
  cx: number;
  width: number;
  mouthOpen: number;
}

export interface SpeakerFrame {
  t: number;
  audioEnergy: number;
  faces: SpeakerFace[];
}

export interface ComputeAutoTrackParams {
  frames: SpeakerFrame[];
  videoWidth: number;
  frameWidth: number;
  fps: number;
}

export interface AutoTrackSample {
  t: number;
  x: number;
}

/** Окно корреляции движения губ и звука. */
const CORRELATION_WINDOW_SEC = 0.5;
/** Длительность подтверждения смены говорящего, чтобы не мигать. */
const SWITCH_CONFIRM_SEC = 0.2;
/** Ниже этого уровня звуковой энергии считаем, что никто не говорит. */
const SILENCE_THRESHOLD = 0.05;
/** Минимальная корреляция, чтобы лицо считалось активным говорящим. */
const CORRELATION_THRESHOLD = 0.3;
/** Порог дисперсии, ниже которого ряд считается практически константным
 *  (и корреляция Пирсона по нему математически не определена / шумна). */
const VARIANCE_EPS = 1e-6;
/** Минимальный средний уровень открытия рта в окне, чтобы запасной
 *  механизм (по уровню, а не по корреляции) счёл лицо говорящим. */
const MOUTH_LEVEL_FALLBACK_MIN = 0.01;
/** Максимальный шаг сглаженной координаты в пикселях при 25 fps. */
const MAX_STEP_PX_AT_25FPS = 35;
const REFERENCE_FPS = 25;
/** Коэффициент экспоненциального сглаживания (критически демпфированное движение). */
const SMOOTHING_ALPHA = 0.25;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) {
    const d = v - m;
    sum += d * d;
  }
  return sum / values.length;
}

/** Коэффициент корреляции Пирсона между двумя рядами одинаковой длины.
 *  Возвращает null, если хотя бы один ряд практически константен —
 *  в этом случае корреляция математически не информативна. */
function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  if (variance(a) < VARIANCE_EPS || variance(b) < VARIANCE_EPS) return null;
  const meanA = mean(a);
  const meanB = mean(b);
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den < 1e-9) return null;
  return num / den;
}

/**
 * Строит автоматическую дорожку x-координат рамки по кадрам с лицами и
 * звуковой энергией.
 *
 * Алгоритм:
 * 1. Для каждого лица в окне ~0.5с считаем корреляцию изменения mouthOpen
 *    со звуковой энергией; активный говорящий — лицо с максимальной
 *    корреляцией выше порога. Если в окне сигналы (звук и/или движение
 *    губ) практически константны, корреляция не определена — тогда в
 *    качестве запасного критерия используется средний уровень открытия
 *    рта в окне (у говорящего рот заметно открыт/двигается, у молчащего —
 *    нет), что устойчиво к ступенчатым сигналам без локальной дисперсии.
 * 2. Если звук ниже порога тишины или ни одно лицо не проходит порог —
 *    активный говорящий не меняется (удерживается последний; при полном
 *    отсутствии истории — центр кадра).
 * 3. Целевой x = clamp(cx_активного - frameWidth/2, [0, videoWidth-frameWidth]).
 * 4. Сглаживание — экспоненциальный фильтр с ограничением скорости
 *    изменения (|x[i]-x[i-1]| <= 35px при 25 fps, пропорционально fps).
 * 5. Переключение говорящего требует ~0.2с подтверждения подряд.
 */
export function computeAutoTrack(params: ComputeAutoTrackParams): AutoTrackSample[] {
  const { frames, videoWidth, frameWidth, fps } = params;
  if (!frames || frames.length === 0) return [];

  const safeFps = fps > 0 ? fps : REFERENCE_FPS;
  const minX = 0;
  const maxX = Math.max(0, videoWidth - frameWidth);
  const centerX = clamp(videoWidth / 2 - frameWidth / 2, minX, maxX);

  const windowFrames = Math.max(2, Math.round(CORRELATION_WINDOW_SEC * safeFps));
  const confirmFrames = Math.max(1, Math.round(SWITCH_CONFIRM_SEC * safeFps));
  const maxStep = MAX_STEP_PX_AT_25FPS * (REFERENCE_FPS / safeFps);

  const n = frames.length;

  // Собираем историю mouthOpen и cx по каждому id лица, выровненную по
  // индексу кадра (null там, где лицо в кадре отсутствовало).
  const faceIds = new Set<string | number>();
  for (const frame of frames) {
    for (const face of frame.faces) faceIds.add(face.id);
  }

  const mouthOpenById = new Map<string | number, Array<number | null>>();
  const cxById = new Map<string | number, Array<number | null>>();
  for (const id of faceIds) {
    mouthOpenById.set(id, new Array(n).fill(null));
    cxById.set(id, new Array(n).fill(null));
  }
  for (let i = 0; i < n; i++) {
    for (const face of frames[i].faces) {
      mouthOpenById.get(face.id)![i] = face.mouthOpen;
      cxById.get(face.id)![i] = face.cx;
    }
  }

  // Дельта открытия рта (модуль изменения кадр-к-кадру) — прокси активности губ.
  const mouthDeltaById = new Map<string | number, number[]>();
  for (const id of faceIds) {
    const values = mouthOpenById.get(id)!;
    const deltas = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const prev = values[i - 1];
      const curr = values[i];
      deltas[i] = prev !== null && curr !== null ? Math.abs(curr - prev) : 0;
    }
    mouthDeltaById.set(id, deltas);
  }

  const audioEnergy = frames.map((f) => (Number.isFinite(f.audioEnergy) ? f.audioEnergy : 0));

  let activeSpeaker: string | number | null = null;
  let pendingSpeaker: string | number | null = null;
  let pendingCount = 0;
  let lastKnownCx: number | null = null;
  let rawTargetX = centerX;

  const rawTargets: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const windowStart = Math.max(0, i - windowFrames + 1);
    const slice = (arr: number[]) => arr.slice(windowStart, i + 1);
    const energyWindow = slice(audioEnergy);
    const energyWindowMean = mean(energyWindow);

    const isSilent = energyWindowMean < SILENCE_THRESHOLD;

    let candidateId: string | number | null = null;
    let candidateValid = false;

    if (!isSilent && frames[i].faces.length > 0) {
      // Сначала пробуем настоящую корреляцию (когда сигналы информативны).
      let bestCorrId: string | number | null = null;
      let bestCorr = -Infinity;
      let anyCorrDefined = false;

      for (const face of frames[i].faces) {
        const deltas = mouthDeltaById.get(face.id)!;
        const deltaWindow = slice(deltas);
        const corr = pearsonCorrelation(deltaWindow, energyWindow);
        if (corr !== null) {
          anyCorrDefined = true;
          if (corr > bestCorr) {
            bestCorr = corr;
            bestCorrId = face.id;
          }
        }
      }

      if (anyCorrDefined && bestCorrId !== null && bestCorr >= CORRELATION_THRESHOLD) {
        candidateId = bestCorrId;
        candidateValid = true;
      } else {
        // Запасной механизм: сигналы (звук и/или движение губ) в окне
        // практически константны — корреляция неинформативна. Берём
        // лицо с наибольшим средним уровнем открытия рта в окне.
        const mouthOpenValues = mouthOpenById;
        let bestLevelId: string | number | null = null;
        let bestLevel = -Infinity;
        for (const face of frames[i].faces) {
          const levels = mouthOpenValues.get(face.id)!;
          const windowVals = slice(levels.map((v) => (v === null ? 0 : v)) as number[]);
          const levelMean = mean(windowVals);
          if (levelMean > bestLevel) {
            bestLevel = levelMean;
            bestLevelId = face.id;
          }
        }
        if (bestLevelId !== null && bestLevel >= MOUTH_LEVEL_FALLBACK_MIN) {
          candidateId = bestLevelId;
          candidateValid = true;
        }
      }
    }

    const hasValidCandidate = candidateValid && candidateId !== null;

    if (hasValidCandidate) {
      if (candidateId === activeSpeaker) {
        pendingSpeaker = null;
        pendingCount = 0;
      } else if (candidateId === pendingSpeaker) {
        pendingCount += 1;
        if (pendingCount >= confirmFrames) {
          activeSpeaker = candidateId;
          pendingSpeaker = null;
          pendingCount = 0;
        }
      } else {
        pendingSpeaker = candidateId;
        pendingCount = 1;
        if (confirmFrames <= 1) {
          activeSpeaker = candidateId;
          pendingSpeaker = null;
          pendingCount = 0;
        }
      }
    } else {
      // Тишина или нет кандидата выше порога — цель удерживается,
      // счётчик подтверждения смены говорящего сбрасывается.
      pendingSpeaker = null;
      pendingCount = 0;
    }

    let currentCx: number | null = null;
    if (activeSpeaker !== null) {
      const cxArr = cxById.get(activeSpeaker)!;
      currentCx = cxArr[i];
      if (currentCx !== null) lastKnownCx = currentCx;
    }

    if (currentCx === null && lastKnownCx !== null) {
      currentCx = lastKnownCx;
    }

    if (currentCx !== null) {
      rawTargetX = clamp(currentCx - frameWidth / 2, minX, maxX);
    }
    // Если currentCx===null (лиц не было ни разу) — держим предыдущий
    // rawTargetX (изначально центр кадра).

    rawTargets[i] = rawTargetX;
  }

  // Сглаживание: экспоненциальный фильтр с ограничением скорости изменения
  // (критически демпфированное движение без рывков и дрожания).
  const result: AutoTrackSample[] = new Array(n);
  let smoothed = rawTargets[0];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      smoothed = clamp(rawTargets[0], minX, maxX);
    } else {
      const desiredDelta = (rawTargets[i] - smoothed) * SMOOTHING_ALPHA;
      const clampedDelta = clamp(desiredDelta, -maxStep, maxStep);
      smoothed = clamp(smoothed + clampedDelta, minX, maxX);
    }
    result[i] = { t: frames[i].t, x: smoothed };
  }

  return result;
}
