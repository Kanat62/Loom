/**
 * Звуковая дорожка исходного ролика -> огибающая энергии речи.
 *
 * Считается офлайн (WebAudio / OfflineAudioContext) на тех же временных
 * отсчётах, что и покадровый разбор видео, чтобы обе дорожки данных
 * (лица и звук) можно было сопоставлять индекс в индекс.
 *
 * Ни одна функция не бросает: если звука нет или формат не читается,
 * возвращается пустая огибающая с hasAudio = false, и автоматика
 * продолжает работать по одному видеоряду.
 */

export interface AudioEnvelope {
  /** временные отсчёты в секундах */
  times: Float64Array;
  /** нормированная энергия 0..1 */
  energy: Float32Array;
  /** флаг «в этот момент звучит голос» */
  voiced: Uint8Array;
  /** удалось ли вообще декодировать звук */
  hasAudio: boolean;
}

const TARGET_RATE = 16000;
const WINDOW_SEC = 0.06;
const PRE_EMPHASIS = 0.97;
const RELEASE_SEC = 0.25;
const DECODE_TIMEOUT_MS = 25000;

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function getOfflineCtor(): OfflineCtor | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const ctor = (g['OfflineAudioContext'] || g['webkitOfflineAudioContext']) as OfflineCtor | undefined;
  return ctor || null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

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

function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (!n) return 0;
  const copy = Float64Array.from(values as ArrayLike<number>);
  copy.sort();
  const idx = Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)));
  return copy[idx];
}

/** Декодирует звук из файла. Возвращает null, если дорожки нет или формат не читается. */
export async function decodeAudioBuffer(source: Blob | ArrayBuffer): Promise<AudioBuffer | null> {
  const Ctor = getOfflineCtor();
  if (!Ctor) return null;

  let data: ArrayBuffer;
  try {
    data = source instanceof Blob ? await source.arrayBuffer() : source.slice(0);
  } catch {
    return null;
  }

  let ctx: OfflineAudioContext;
  try {
    ctx = new Ctor(1, TARGET_RATE, TARGET_RATE);
  } catch {
    return null;
  }

  const decode = new Promise<AudioBuffer | null>((resolve) => {
    try {
      const maybe = (ctx as unknown as {
        decodeAudioData: (
          d: ArrayBuffer,
          ok?: (b: AudioBuffer) => void,
          err?: (e: unknown) => void
        ) => Promise<AudioBuffer> | undefined;
      }).decodeAudioData(
        data,
        (b) => resolve(b),
        () => resolve(null)
      );
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(
          (b) => resolve(b),
          () => resolve(null)
        );
      }
    } catch {
      resolve(null);
    }
  });

  return withTimeout(decode, DECODE_TIMEOUT_MS, null);
}

/** Сводит буфер в моно и приводит к 16 кГц. */
async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const Ctor = getOfflineCtor();
  const length = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE));

  if (Ctor) {
    try {
      const offline = new Ctor(1, length, TARGET_RATE);
      const src = offline.createBufferSource();
      src.buffer = buffer;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await withTimeout(offline.startRendering(), DECODE_TIMEOUT_MS, null as unknown as AudioBuffer);
      if (rendered) return Float32Array.from(rendered.getChannelData(0));
    } catch {
      /* падаем на ручной пересчёт ниже */
    }
  }

  const channels = buffer.numberOfChannels || 1;
  const ratio = buffer.sampleRate / TARGET_RATE;
  const out = new Float32Array(length);
  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < length; i++) {
    const srcIndex = Math.min(buffer.length - 1, Math.round(i * ratio));
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += chans[c][srcIndex];
    out[i] = sum / channels;
  }
  return out;
}

/**
 * Огибающая энергии речи на заданных временных отсчётах.
 * Никогда не бросает: если звука нет, возвращает нули и hasAudio = false.
 */
export async function extractEnergyEnvelope(
  source: Blob | ArrayBuffer,
  times: ArrayLike<number>
): Promise<AudioEnvelope> {
  const t = Float64Array.from(times as ArrayLike<number>);
  const energy = new Float32Array(t.length);
  const voiced = new Uint8Array(t.length);

  let buffer: AudioBuffer | null = null;
  try {
    buffer = await decodeAudioBuffer(source);
  } catch {
    buffer = null;
  }
  if (!buffer || buffer.length === 0) {
    return { times: t, energy, voiced, hasAudio: false };
  }

  let mono: Float32Array;
  try {
    mono = await toMono16k(buffer);
  } catch {
    return { times: t, energy, voiced, hasAudio: false };
  }

  // Предыскажение убирает низкочастотный гул, речь после него выделяется лучше.
  const filtered = new Float32Array(mono.length);
  let prev = 0;
  for (let i = 0; i < mono.length; i++) {
    const s = mono[i];
    filtered[i] = s - PRE_EMPHASIS * prev;
    prev = s;
  }

  const half = Math.max(1, Math.round((WINDOW_SEC * TARGET_RATE) / 2));
  const raw = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const center = Math.round(t[i] * TARGET_RATE);
    const from = Math.max(0, center - half);
    const to = Math.min(filtered.length, center + half);
    let sum = 0;
    let n = 0;
    for (let j = from; j < to; j++) {
      const v = filtered[j];
      sum += v * v;
      n++;
    }
    raw[i] = n ? Math.sqrt(sum / n) : 0;
  }

  const loud = percentile(raw, 0.95) || 1e-6;
  for (let i = 0; i < raw.length; i++) energy[i] = clamp01(raw[i] / loud);

  const floor = percentile(energy, 0.25);
  const onThreshold = Math.min(0.6, Math.max(0.1, floor + 0.14));
  const offThreshold = onThreshold * 0.55;
  const releaseSteps = Math.max(
    1,
    Math.round(RELEASE_SEC / Math.max(1e-3, t.length > 1 ? t[1] - t[0] : 0.04))
  );

  let active = false;
  let sinceOn = 0;
  for (let i = 0; i < energy.length; i++) {
    const e = energy[i];
    if (!active && e > onThreshold) {
      active = true;
      sinceOn = 0;
    } else if (active) {
      if (e > offThreshold) sinceOn = 0;
      else if (++sinceOn > releaseSteps) active = false;
    }
    voiced[i] = active ? 1 : 0;
  }

  return { times: t, energy, voiced, hasAudio: true };
}
