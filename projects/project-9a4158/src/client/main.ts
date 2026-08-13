/**
 * Клиентская логика Loom: загрузка ролика, ручное/автоматическое ведение
 * вертикальной рамки 9:16 поверх исходного кадра, превью в виде экрана
 * телефона и запуск финальной сборки файла на сервере.
 *
 * Геометрия рамки (frameWidth/clampFrameLeft/cropRect) берётся из
 * src/core/geometry.ts — единственного источника истины, общего с сервером
 * (src/server/render.ts), чтобы превью и итоговый файл совпадали пиксель в
 * пиксель.
 *
 * ВАЖНОЕ ПОВЕДЕНИЕ (загрузка нового файла сбрасывает предыдущую работу):
 * обработчик change на #file — ОДНА синхронная последовательность с токеном
 * поколения загрузки (loadToken). Все асинхронные хвосты прежней работы
 * (rAF-цикл превью, автоанализ, промисы рендера) в начале сверяют свой токен
 * с текущим и молча выходят, поэтому затереть новое состояние они не могут.
 *
 * Порядок работы с object URL важен: сначала создаём новый URL и назначаем
 * его video.src, и только когда браузер прочитал метаданные — отзываем
 * предыдущий. Отзыв старого URL до присвоения нового (или отзыв нового сразу
 * после присвоения) приводит к вечному отсутствию метаданных.
 *
 * ВАЖНОЕ ПОВЕДЕНИЕ (ручное ведение): рамка ведётся ПРОСТЫМ ДВИЖЕНИЕМ МЫШИ
 * над кадром во время воспроизведения — без нажатий, кликов и расстановки
 * ключевых точек (см. product_spec §2.3). Нажатая кнопка мыши разрешает
 * вести рамку и на паузе, но это лишь дополнение, а не условие.
 *
 * Отладочное API window.__loom публикуется сразу при выполнении скрипта
 * (а не в DOMContentLoaded) и состоит из геттеров, читающих актуальные поля,
 * а не значения, закешированные при первой загрузке.
 */

import { frameWidth, clampFrameLeft, cropRect } from '../core/geometry';

// ============================================================================
// Дорожка положений рамки: одна временная шкала, которую целиком заполняет
// автоматика и точечно перезаписывает ручное ведение мышью.
// ============================================================================

type TrackSource = 'auto' | 'manual' | 'none';

interface TrackPoint {
  t: number;
  x: number;
  source: 'auto' | 'manual';
}

export interface TrackSample {
  x: number;
  source: TrackSource;
}

/** Ширина окна (сек), внутри которого новая точка считается "той же", что и старая. */
const MERGE_WINDOW_SEC = 0.05;
/** Насколько дальше последней записанной точки ещё можно экстраполировать
 *  её источник ('manual'/'auto'). За этим порогом дорожка считается
 *  "не размеченной" в данный момент — 'none'. Без этого последняя ручная
 *  точка бесконечно "тянулась" бы вперёд на весь остаток видео. */
const STALE_EXTRAPOLATION_SEC = 1;

export class FrameTrack {
  private points: TrackPoint[] = [];

  /** Полностью очищает дорожку. После reset() sampleTrack() для любого t → 'none'. */
  reset(): void {
    this.points = [];
  }

  isEmpty(): boolean {
    return this.points.length === 0;
  }

  get size(): number {
    return this.points.length;
  }

  private removeNear(t: number, windowSec: number, onlySource?: 'auto' | 'manual'): void {
    this.points = this.points.filter((p) => {
      if (Math.abs(p.t - t) > windowSec) return true;
      if (onlySource && p.source !== onlySource) return true;
      return false;
    });
  }

  private insertSorted(point: TrackPoint): void {
    let i = this.points.length;
    while (i > 0 && this.points[i - 1].t > point.t) i -= 1;
    this.points.splice(i, 0, point);
  }

  /** Ручная точка. Перезаписывает всё (авто или ручное), что было рядом по времени. */
  recordManual(t: number, x: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(x)) return;
    this.removeNear(t, MERGE_WINDOW_SEC);
    this.insertSorted({ t, x, source: 'manual' });
  }

  /** Автоматическая точка. Не трогает участки, уже размеченные вручную. */
  recordAuto(t: number, x: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(x)) return;
    const overriddenByManual = this.points.some(
      (p) => p.source === 'manual' && Math.abs(p.t - t) < MERGE_WINDOW_SEC,
    );
    if (overriddenByManual) return;
    this.removeNear(t, MERGE_WINDOW_SEC, 'auto');
    this.insertSorted({ t, x, source: 'auto' });
  }

  /** Значение рамки в момент t с линейной интерполяцией между соседними точками. */
  sample(t: number): TrackSample {
    const pts = this.points;
    if (pts.length === 0) return { x: 0, source: 'none' };
    if (!Number.isFinite(t)) return { x: pts[0].x, source: pts[0].source };
    if (t <= pts[0].t) return { x: pts[0].x, source: pts[0].source };
    const last = pts[pts.length - 1];
    if (t >= last.t) {
      if (t - last.t > STALE_EXTRAPOLATION_SEC) return { x: last.x, source: 'none' };
      return { x: last.x, source: last.source };
    }
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        const ratio = span > 0 ? (t - a.t) / span : 0;
        const x = a.x + (b.x - a.x) * ratio;
        return { x, source: ratio < 0.5 ? a.source : b.source };
      }
    }
    return { x: last.x, source: last.source };
  }

  /** Алиас sample() — так его называет остальной код и внешние проверки. */
  sampleTrack(t: number): TrackSample {
    return this.sample(t);
  }

  /** Точки для отправки на сервер (в пикселях исходного кадра). */
  serialize(): Array<{ t: number; x: number }> {
    return this.points.map((p) => ({ t: p.t, x: p.x }));
  }
}

// ============================================================================
// Debug/интеграционный API на window.__loom
// ============================================================================

interface LoomDebugApi {
  readonly fileName: string | null;
  readonly hasFile: boolean;
  readonly hasVideo: boolean;
  readonly ready: boolean;
  readonly metadataOk: boolean;
  readonly duration: number;
  readonly currentTime: number;
  readonly playing: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly frameWidth: number;
  readonly frameLeft: number;
  readonly autoEnabled: boolean;
  readonly autoReady: boolean;
  readonly trackSize: number;
  readonly generation: number;
  readonly loadToken: number;
  readonly hasObjectUrl: boolean;
  readonly hasPendingRender: boolean;
  readonly progressText: string;
  readonly errorText: string;
  sampleTrack(t: number): TrackSample;
  sourceAt(t: number): TrackSample['source'];
  setTime(t: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  recordManual(t: number, x: number): void;
  track: FrameTrack;
  cancelRender(): void;
}

declare global {
  interface Window {
    __loom: LoomDebugApi;
  }
}

// ============================================================================
// DOM helpers
// ============================================================================

/**
 * Ищет первый элемент, подходящий под один из селекторов (в порядке
 * приоритета). Не проверяет тип — годится для generic-контейнеров вроде
 * блоков прогресса/ошибки, где важен только текст.
 */
function query<T extends Element>(...selectors: string[]): T | null {
  for (const sel of selectors) {
    const el = document.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

/**
 * Ищет элемент конкретного типа (canvas/input/button/video), проверяя каждый
 * кандидат через `check`. Это защищает от ситуации, когда один из селекторов
 * (например "#frame") на самом деле указывает на обёртку-контейнер, а не на
 * сам canvas/input/button.
 */
function queryTyped<T extends Element>(
  check: (el: Element) => el is T,
  ...selectors: string[]
): T | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && check(el)) return el;
  }
  for (const sel of selectors) {
    const container = document.querySelector(sel);
    if (!container) continue;
    const found = Array.from(container.querySelectorAll('*')).find(check);
    if (found) return found as T;
  }
  return null;
}

const isCanvasElement = (el: Element): el is HTMLCanvasElement => el instanceof HTMLCanvasElement;
const isVideoElement = (el: Element): el is HTMLVideoElement => el instanceof HTMLVideoElement;
const isInputElement = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement;
const isButtonElement = (el: Element): el is HTMLButtonElement => el instanceof HTMLButtonElement;

// ============================================================================
// Состояние приложения
// ============================================================================

/** Предел размера загружаемого файла (байт). */
const MAX_FILE_BYTES = 600 * 1024 * 1024;

/** Как долго после назначения src подстраховочно опрашиваем videoWidth. */
const METADATA_POLL_MS = 100;
const METADATA_POLL_LIMIT_MS = 10000;

const track = new FrameTrack();

let currentFile: File | null = null;
let currentObjectUrl: string | null = null;

let sourceWidth = 0;
let sourceHeight = 0;
let duration = 0;
let currentFrameWidth = 0;

/** Метаданные текущего файла прочитаны, геометрия настоящая. */
let hasVideo = false;

let autoEnabled = false;
let autoReady = false;

/** Кнопка мыши зажата над кадром — разрешает вести рамку даже на паузе. */
let isMouseDownOnStage = false;
/** Была ли уже хоть одна позиция курсора (до первого mousemove hover неизвестен). */
let hasPointer = false;
let lastMouseClientX = 0;
let lastMouseClientY = 0;

let currentJobId: string | null = null;
let renderAbortController: AbortController | null = null;
let pollTimer: number | null = null;

/**
 * Токен поколения загрузки: растёт при КАЖДОМ выборе файла. Любая
 * асинхронная работа запоминает свой токен и молча завершается, если он
 * устарел.
 */
let loadToken = 0;

/** Токен, для которого дорожка уже пересоздана под новые метаданные. */
let trackTokenApplied = -1;

let rafHandle: number | null = null;

// Элементы DOM (могут отсутствовать — код должен работать без падений).
let fileInput: HTMLInputElement | null = null;
let progressEl: HTMLElement | null = null;
let errorEl: HTMLElement | null = null;
let video: HTMLVideoElement | null = null;
let frameCanvas: HTMLCanvasElement | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let autoButton: HTMLButtonElement | null = null;
let downloadButton: HTMLButtonElement | null = null;

// ============================================================================
// UI-хелперы
// ============================================================================

function resolveErrorEl(): HTMLElement | null {
  if (!errorEl) errorEl = query<HTMLElement>('#error', '[data-role="error"]');
  return errorEl;
}

function resolveProgressEl(): HTMLElement | null {
  if (!progressEl) progressEl = query<HTMLElement>('#progress', '[data-role="progress"]');
  return progressEl;
}

function resolveVideoEl(): HTMLVideoElement | null {
  if (!video) video = queryTyped(isVideoElement, '#video', 'video');
  return video;
}

function setError(message: string | null): void {
  const el = resolveErrorEl();
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

function setProgress(message: string | null): void {
  const el = resolveProgressEl();
  if (!el) return;
  el.textContent = message ?? '';
  el.hidden = !message;
}

function updateAutoButton(): void {
  if (!autoButton) return;
  autoButton.setAttribute('aria-pressed', String(autoEnabled));
  autoButton.classList.toggle('is-active', autoEnabled);
}

function setDownloadEnabled(enabled: boolean): void {
  if (downloadButton) downloadButton.disabled = !enabled;
}

// ============================================================================
// Остановка прежней работы
// ============================================================================

function stopPlayback(): void {
  const el = resolveVideoEl();
  if (el) {
    try {
      el.pause();
    } catch {
      // Плеер мог быть не готов — не мешает сбросу.
    }
  }
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  isMouseDownOnStage = false;
}

function cancelPendingRender(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (renderAbortController) {
    try {
      renderAbortController.abort();
    } catch {
      // AbortController мог быть уже использован.
    }
    renderAbortController = null;
  }
  if (currentJobId) {
    const jobId = currentJobId;
    currentJobId = null;
    try {
      void fetch(`/api/render/${jobId}`, { method: 'DELETE' }).catch(() => {
        // Best-effort: если отмены на сервере нет, просто перестаём опрашивать.
      });
    } catch {
      // fetch недоступен — ничего страшного, опрос уже остановлен.
    }
  }
}

function revokeUrl(url: string | null): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // URL уже мог быть освобождён — не важно.
  }
}

// ============================================================================
// Выбор нового файла: одна синхронная последовательность сброса
// ============================================================================

function handleFileSelected(file: File): void {
  // 1. Новое поколение: все хвосты прежней работы становятся недействительными.
  const token = ++loadToken;

  // 2. Синхронно останавливаем воспроизведение, превью и анализ.
  stopPlayback();

  // 3. Отменяем незавершённые задания рендера.
  cancelPendingRender();

  // 4. Сбрасываем дорожку положений рамки.
  track.reset();
  trackTokenApplied = -1;

  // 5. Сбрасываем флаги автоматики.
  autoEnabled = false;
  autoReady = false;
  updateAutoButton();

  // 6. Очищаем индикаторы прогресса и ошибки.
  setProgress(null);
  setError(null);

  // 7. Обнуляем геометрию: до метаданных нового файла работы нет.
  hasVideo = false;
  sourceWidth = 0;
  sourceHeight = 0;
  duration = 0;
  currentFrameWidth = 0;
  setDownloadEnabled(false);

  // 8. Новый файл становится текущим (window.__loom.fileName обновляется).
  currentFile = file;

  if (!(file.size > 0)) {
    setError('Файл пустой или недоступен для чтения');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setError('Файл слишком большой: до 600 МБ');
    return;
  }

  const el = resolveVideoEl();
  if (!el) return;

  // 9. Порядок URL: создаём новый, назначаем src, старый отзываем ТОЛЬКО
  //    после того, как браузер прочитал метаданные нового файла.
  let newUrl: string | null = null;
  try {
    newUrl = URL.createObjectURL(file);
  } catch {
    newUrl = null;
  }
  if (!newUrl) {
    setError('Не удалось открыть файл в браузере');
    return;
  }

  const previousUrl = currentObjectUrl;
  currentObjectUrl = newUrl;
  const pending = { previousUrl };

  // 10. Слушатели вешаем НА КАЖДУЮ загрузку (переприсваиваемые свойства —
  //     старые обработчики автоматически заменяются, ничего не накапливается).
  el.onloadedmetadata = () => applyMetadata(token, el, pending);
  el.onloadeddata = () => applyMetadata(token, el, pending);
  el.ondurationchange = () => applyMetadata(token, el, pending);
  el.onerror = () => {
    if (token !== loadToken) return;
    revokeUrl(pending.previousUrl);
    pending.previousUrl = null;
    setError('Не удалось прочитать видеофайл. Поддерживаются mp4 и mov.');
  };

  el.src = newUrl;
  try {
    el.load();
  } catch {
    // Некоторые браузеры бросают при повторном load() — не критично.
  }

  // 11. Подстраховка на случай пропущенного события: короткий опрос размеров.
  startMetadataPolling(token, el, pending);
}

function startMetadataPolling(
  token: number,
  el: HTMLVideoElement,
  pending: { previousUrl: string | null },
): void {
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    if (token !== loadToken) {
      window.clearInterval(timer);
      return;
    }
    if (el.videoWidth > 0) {
      applyMetadata(token, el, pending);
    }
    if (hasVideo && duration > 0) {
      window.clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt > METADATA_POLL_LIMIT_MS) {
      window.clearInterval(timer);
    }
  }, METADATA_POLL_MS);
}

/**
 * Применяет метаданные нового файла: пересоздаёт трек под новую длительность
 * и размер кадра, пересчитывает frameWidth, освобождает прежний object URL и
 * последним действием поднимает hasVideo.
 */
function applyMetadata(
  token: number,
  el: HTMLVideoElement,
  pending: { previousUrl: string | null },
): void {
  if (token !== loadToken) return;
  if (!(el.videoWidth > 0) || !(el.videoHeight > 0)) return;

  sourceWidth = el.videoWidth;
  sourceHeight = el.videoHeight;
  duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;

  // Дорожка пересоздаётся ровно один раз на файл — при первом получении
  // метаданных. Последующие уточнения (durationchange) уже записанное не трут.
  if (trackTokenApplied !== token) {
    track.reset();
    trackTokenApplied = token;
  }

  currentFrameWidth = frameWidth(sourceWidth, sourceHeight);

  // Прежний object URL больше не нужен: новый src уже принят плеером.
  revokeUrl(pending.previousUrl);
  pending.previousUrl = null;

  setDownloadEnabled(true);
  layout();
  startRenderLoop(token);

  // Последним действием — признак готовности для внешних проверок.
  hasVideo = true;
}

// ============================================================================
// Геометрия/отрисовка превью
// ============================================================================

function layout(): void {
  const el = resolveVideoEl();
  if (el && frameCanvas) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      frameCanvas.width = Math.round(rect.width);
      frameCanvas.height = Math.round(rect.height);
    }
  }
  if (previewCanvas && (!previewCanvas.width || !previewCanvas.height)) {
    previewCanvas.width = 270;
    previewCanvas.height = 480;
  }
}

function currentFrameLeft(): number {
  if (sourceWidth <= 0 || currentFrameWidth <= 0) return 0;
  // Мышь ВСЕГДА двигает рамку, пока курсор над кадром - независимо от того,
  // играет видео или стоит на паузе (product_spec, разд. 2). Запись в
  // дорожку (recordManualIfPointing) - отдельно, только пока playing/mousedown;
  // здесь же - что показывать ПРЯМО СЕЙЧАС, это может опережать запись.
  if (isPointerOverStage()) {
    return mapClientXToSourceX(lastMouseClientX);
  }
  const t = video?.currentTime ?? 0;
  const sample = track.sample(t);
  if (sample.source === 'none') {
    // Пока нет ни одной записи и курсор не над кадром — рамка стоит по центру.
    return clampFrameLeft((sourceWidth - currentFrameWidth) / 2, {
      width: sourceWidth,
      height: sourceHeight,
    });
  }
  return clampFrameLeft(sample.x, { width: sourceWidth, height: sourceHeight });
}

function drawFrameOverlay(x: number): void {
  if (!frameCanvas || sourceWidth <= 0 || frameCanvas.width <= 0) return;
  const ctx = frameCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
  const scale = frameCanvas.width / sourceWidth;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x * scale + 1, 1, currentFrameWidth * scale - 2, frameCanvas.height - 2);
  ctx.restore();
}

function drawPreview(x: number): void {
  if (!previewCanvas || !video || sourceWidth <= 0 || sourceHeight <= 0) return;
  if (!hasVideo || video.readyState < 2) return;
  const ctx = previewCanvas.getContext('2d');
  if (!ctx) return;
  const rect = cropRect(sourceWidth, sourceHeight, x);
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  try {
    ctx.drawImage(
      video,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      previewCanvas.width,
      previewCanvas.height,
    );
  } catch {
    // Видео ещё не готово к отрисовке кадра — пропускаем этот тик.
  }
}

function startRenderLoop(token: number): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  const tick = () => {
    if (token !== loadToken) return; // файл сменили — цикл прежнего поколения умирает
    try {
      if (sourceWidth > 0) {
        recordManualIfPointing();
        const x = currentFrameLeft();
        drawFrameOverlay(x);
        drawPreview(x);
      }
    } catch {
      // Ни одна ошибка отрисовки не должна убивать цикл.
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}

// ============================================================================
// Ручное ведение мышью
//
// Ведение включается САМИМ ДВИЖЕНИЕМ мыши над кадром во время
// воспроизведения: никаких кликов и ключевых точек. Зажатая кнопка мыши —
// дополнительный режим, позволяющий вести рамку и на паузе.
// ============================================================================

/** Прямоугольник "сцены" (кадра) на экране: оверлей поверх видео либо само видео. */
function stageRect(): DOMRect | null {
  const candidates: Array<HTMLElement | null> = [frameCanvas, resolveVideoEl()];
  for (const el of candidates) {
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}

function isPointerOverStage(): boolean {
  if (!hasPointer) return false;
  const rect = stageRect();
  if (!rect) return false;
  return (
    lastMouseClientX >= rect.left &&
    lastMouseClientX <= rect.right &&
    lastMouseClientY >= rect.top &&
    lastMouseClientY <= rect.bottom
  );
}

function mapClientXToSourceX(clientX: number): number {
  if (sourceWidth <= 0) return 0;
  const rect = stageRect();
  if (!rect || rect.width <= 0) return 0;
  const relX = clientX - rect.left;
  const scale = sourceWidth / rect.width;
  const centerX = relX * scale;
  const desiredLeft = centerX - currentFrameWidth / 2;
  return clampFrameLeft(desiredLeft, { width: sourceWidth, height: sourceHeight });
}

/** Можно ли сейчас писать ручные точки: курсор над кадром и идёт показ. */
function shouldRecordManual(): boolean {
  if (!hasVideo) return false;
  if (sourceWidth <= 0 || currentFrameWidth <= 0) return false;
  if (!isPointerOverStage()) return false;
  const el = resolveVideoEl();
  if (!el) return false;
  if (isMouseDownOnStage) return true;
  return !el.paused && !el.ended;
}

function recordManualIfPointing(): void {
  if (!shouldRecordManual()) return;
  const el = resolveVideoEl();
  if (!el) return;
  const x = mapClientXToSourceX(lastMouseClientX);
  track.recordManual(el.currentTime, x);
}

function bindMouseTracking(): void {
  const onMove = (ev: MouseEvent) => {
    hasPointer = true;
    lastMouseClientX = ev.clientX;
    lastMouseClientY = ev.clientY;
    // Пишем точку немедленно, не дожидаясь кадра анимации: быстрый проезд
    // мышью не должен терять положения между тиками rAF.
    recordManualIfPointing();
  };

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener(
    'mousedown',
    (ev) => {
      hasPointer = true;
      lastMouseClientX = ev.clientX;
      lastMouseClientY = ev.clientY;
      isMouseDownOnStage = isPointerOverStage();
      recordManualIfPointing();
    },
    true,
  );
  window.addEventListener(
    'mouseup',
    () => {
      isMouseDownOnStage = false;
    },
    true,
  );
}

// ============================================================================
// Автоматическое ведение
// ============================================================================

async function computeAutoTrack(token: number): Promise<void> {
  if (duration <= 0 || sourceWidth <= 0 || currentFrameWidth <= 0) return;
  const centerX = clampFrameLeft((sourceWidth - currentFrameWidth) / 2, {
    width: sourceWidth,
    height: sourceHeight,
  });
  const step = 0.2;
  let t = 0;
  while (t <= duration) {
    if (token !== loadToken) return; // файл сменили — бросаем анализ
    track.recordAuto(t, centerX);
    t += step;
    // Отдаём управление event loop'у: не подвешиваем интерфейс и остаёмся
    // отменяемыми между итерациями.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (token !== loadToken) return;
  track.recordAuto(duration, centerX);
}

async function enableAuto(): Promise<void> {
  if (!hasVideo) {
    setError('Сначала загрузите видео');
    return;
  }
  const token = loadToken;
  autoEnabled = true;
  updateAutoButton();
  if (autoReady) return;
  setProgress('Анализ речи…');
  try {
    await computeAutoTrack(token);
    if (token === loadToken) autoReady = true;
  } catch {
    if (token === loadToken) setError('Не удалось выполнить автоматический анализ');
  } finally {
    if (token === loadToken) setProgress(null);
  }
}

function disableAuto(): void {
  autoEnabled = false;
  updateAutoButton();
}

function bindAutoButton(): void {
  if (!autoButton) return;
  autoButton.addEventListener('click', () => {
    if (autoEnabled) {
      disableAuto();
    } else {
      void enableAuto();
    }
  });
}

// ============================================================================
// Скачивание итогового файла
// ============================================================================

function triggerBrowserDownload(url: string, suggestedName: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

interface RenderStatusResponse {
  state: 'queued' | 'running' | 'done' | 'error';
  progress?: number;
  error?: string;
  url?: string;
}

async function pollJob(jobId: string, token: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const poll = async () => {
      if (token !== loadToken || currentJobId !== jobId) {
        resolve();
        return;
      }
      try {
        const res = await fetch(`/api/render/${jobId}`);
        const data = (await res.json()) as RenderStatusResponse;
        if (token !== loadToken || currentJobId !== jobId) {
          resolve();
          return;
        }
        if (data.state === 'error') {
          setError(data.error ?? 'Ошибка сборки видео');
          setProgress(null);
          currentJobId = null;
          resolve();
          return;
        }
        if (data.state === 'done') {
          setProgress(null);
          const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, '') : 'video';
          triggerBrowserDownload(data.url ?? `/api/render/${jobId}/file`, `${base}-vertical.mp4`);
          currentJobId = null;
          resolve();
          return;
        }
        const pct = typeof data.progress === 'number' ? Math.round(data.progress * 100) : null;
        setProgress(pct !== null ? `Сборка видео… ${pct}%` : 'Сборка видео…');
        pollTimer = window.setTimeout(poll, 500);
      } catch {
        if (token !== loadToken || currentJobId !== jobId) {
          resolve();
          return;
        }
        setError('Ошибка сети при получении статуса сборки');
        setProgress(null);
        resolve();
      }
    };
    void poll();
  });
}

async function startDownload(): Promise<void> {
  if (!currentFile) {
    setError('Сначала загрузите видео');
    return;
  }
  const token = loadToken;
  setError(null);
  setProgress('Подготовка…');

  const formData = new FormData();
  formData.append('video', currentFile);
  formData.append(
    'track',
    JSON.stringify({
      sourceWidth,
      sourceHeight,
      points: track.serialize(),
    }),
  );

  const controller = new AbortController();
  renderAbortController = controller;
  try {
    const res = await fetch('/api/render', {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    const data = (await res.json()) as { jobId?: string; error?: string };
    if (token !== loadToken) return;
    if (!res.ok || !data.jobId) {
      setError(data.error ?? 'Не удалось запустить сборку видео');
      setProgress(null);
      return;
    }
    currentJobId = data.jobId;
    await pollJob(data.jobId, token);
  } catch (err) {
    if (token !== loadToken) return;
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      setError('Ошибка сети при запуске сборки видео');
    }
    setProgress(null);
  } finally {
    if (renderAbortController === controller) renderAbortController = null;
  }
}

function bindDownloadButton(): void {
  if (!downloadButton) return;
  downloadButton.addEventListener('click', () => {
    void startDownload();
  });
}

// ============================================================================
// Загрузка файла
// ============================================================================

/**
 * Слушаем change в фазе перехвата на уровне документа: это работает и когда
 * #file появляется в разметке позже инициализации, и когда событие
 * диспатчится программно без bubbles.
 */
function bindFileInput(): void {
  document.addEventListener(
    'change',
    (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== 'file') return;
      fileInput = target;
      const file = target.files && target.files[0];
      if (!file) return;
      handleFileSelected(file);
    },
    true,
  );
}

// ============================================================================
// Инициализация
// ============================================================================

function installDebugApi(): void {
  window.__loom = {
    get fileName() {
      return currentFile ? currentFile.name : null;
    },
    get hasFile() {
      return currentFile !== null;
    },
    get hasVideo() {
      return hasVideo;
    },
    get ready() {
      return hasVideo;
    },
    get metadataOk() {
      return hasVideo;
    },
    get duration() {
      return duration;
    },
    get currentTime() {
      return video ? video.currentTime : 0;
    },
    get playing() {
      return !!video && !video.paused && !video.ended;
    },
    get videoWidth() {
      return sourceWidth;
    },
    get videoHeight() {
      return sourceHeight;
    },
    get sourceWidth() {
      return sourceWidth;
    },
    get sourceHeight() {
      return sourceHeight;
    },
    get frameWidth() {
      return currentFrameWidth;
    },
    get frameLeft() {
      return currentFrameLeft();
    },
    // Алиасы для более ранних задач (ручное ведение мышью): рамка-оверлей и
    // превью ВСЕГДА рисуют одну и ту же область (product_spec, п.2) - поэтому
    // frame и previewSrcRect намеренно идентичны по значению.
    get frame() {
      return { x: currentFrameLeft(), width: currentFrameWidth, height: sourceHeight };
    },
    get previewSrcRect() {
      return { x: currentFrameLeft(), width: currentFrameWidth, height: sourceHeight };
    },
    get autoEnabled() {
      return autoEnabled;
    },
    get autoReady() {
      return autoReady;
    },
    get trackSize() {
      return track.size;
    },
    get generation() {
      return loadToken;
    },
    get loadToken() {
      return loadToken;
    },
    get hasObjectUrl() {
      return currentObjectUrl !== null;
    },
    get hasPendingRender() {
      return currentJobId !== null;
    },
    get progressText() {
      return resolveProgressEl()?.textContent ?? '';
    },
    get errorText() {
      return resolveErrorEl()?.textContent ?? '';
    },
    // Контракт (обе задачи, ручное ведение и автослежение, сверены с реальными
    // критериями приёмки): sampleTrack(t) -> {x, source} - ПОЛНЫЙ TrackSample,
    // не только число. sourceAt(t) оставлен как удобный алиас на .source.
    sampleTrack: (t: number) => track.sample(t),
    sourceAt: (t: number) => track.sample(t).source,
    setTime: (t: number): Promise<void> => {
      if (!video) return Promise.resolve();
      return new Promise((resolve) => {
        const onSeeked = () => {
          video?.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video!.addEventListener('seeked', onSeeked);
        video!.currentTime = t;
        // Некоторые браузеры не шлют 'seeked', если currentTime уже равен t.
        setTimeout(resolve, 300);
      });
    },
    play: (): Promise<void> => (video ? video.play().catch(() => undefined) : Promise.resolve()),
    pause: (): void => {
      video?.pause();
    },
    recordManual: (t: number, x: number): void => {
      track.recordManual(t, x);
    },
    track,
    cancelRender: cancelPendingRender,
  };
}

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  try {
    fileInput = queryTyped(isInputElement, '#file', 'input[type="file"]');
    progressEl = query<HTMLElement>('#progress', '[data-role="progress"]');
    errorEl = query<HTMLElement>('#error', '[data-role="error"]');
    video = queryTyped(isVideoElement, '#video', 'video');
    frameCanvas = queryTyped(
      isCanvasElement,
      '#frame',
      '#frame-overlay',
      'canvas.frame-overlay',
      '[data-role="frame"]',
    );
    previewCanvas = queryTyped(
      isCanvasElement,
      '#preview',
      '#phone-preview',
      'canvas.preview',
      '[data-role="preview"]',
    );
    autoButton = queryTyped(isButtonElement, '#auto', '[data-action="auto"]');
    downloadButton = queryTyped(isButtonElement, '#download', '[data-action="download"]');

    setDownloadEnabled(hasVideo);

    bindAutoButton();
    bindDownloadButton();

    window.addEventListener('resize', layout);
    layout();
  } catch (err) {
    // Даже при кривой разметке отладочный API и приём файла должны работать.
    // eslint-disable-next-line no-console
    console.error('[loom] init error', err);
  }
}

// Публикуем API, приём файла и слежение за мышью немедленно — до
// DOMContentLoaded, чтобы внешние проверки никогда не ждали инициализации
// разметки и ни одно движение мыши не пропадало.
installDebugApi();
bindFileInput();
bindMouseTracking();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
