/**
 * Геометрия вертикальной рамки 9:16.
 *
 * Единственный источник истины для КЛИЕНТА (отрисовка рамки и превью) и для
 * СЕРВЕРА (crop в ffmpeg). Обе стороны обязаны получать ОДИНАКОВЫЕ целые
 * числа, иначе итоговый файл не совпадёт покадрово с тем, что показывало
 * превью.
 *
 * Правила (нарушать нельзя):
 *   height = высота исходного кадра, приведённая к чётной (требование кодеков;
 *            для реальных роликов высота уже чётная, значение не меняется);
 *   width  = toEven(height * 9 / 16), но не больше ширины исходника;
 *   x      = левый край рамки в координатах ИСХОДНОГО кадра, ЦЕЛОЕ,
 *            clamp(0 .. sourceWidth - width);
 *   y      = 0 — рамка всегда во всю высоту кадра.
 *
 * Никакого масштабирования, паддингов и смены пропорций: итоговый кадр — это
 * ровно пиксели исходника внутри прямоугольника (x, 0, width, height).
 *
 * ВЫРАВНИВАНИЕ X ПО ЦВЕТОРАЗНОСТНОЙ СЕТКЕ.
 * Итоговый файл кодируется в yuv420p (цветность прорежена вдвое по обеим осям).
 * Фильтр crop в ffmpeg при этом сам приводит x к чётному (`x &= ~1`), если не
 * включён режим exact. Чтобы превью на клиенте показывало РОВНО то же, что
 * попадёт в файл, обе стороны обязаны считать crop-прямоугольник одной
 * функцией cropRect(), которая уже выполняет это выравнивание (cropXForOutput).
 * Сдвиг не превышает 1 пикселя и на управление рамкой не влияет, но без него
 * кадр файла может оказаться на пиксель левее превью.
 *
 * Модуль намеренно без зависимостей: он импортируется и в браузере, и в Node.
 * Клиент зовёт frameWidth(), сервер — outWidth(); это ОДНА И ТА ЖЕ функция.
 */

export const TARGET_ASPECT_W = 9;
export const TARGET_ASPECT_H = 16;

/** Отношение ширины к высоте вертикальной рамки (9/16 = 0.5625). */
export const TARGET_ASPECT = TARGET_ASPECT_W / TARGET_ASPECT_H;

export interface SourceSize {
  readonly width: number;
  readonly height: number;
}

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}

/**
 * Ближайшее чётное число, не превышающее округления вверх.
 * Чётность обязательна для yuv420p: нечётные ширина/высота ломают кодирование.
 */
export function toEven(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function isValidSize(size: unknown): size is SourceSize {
  if (typeof size !== 'object' || size === null) return false;
  const s = size as Partial<SourceSize>;
  return (
    typeof s.width === 'number' &&
    typeof s.height === 'number' &&
    Number.isFinite(s.width) &&
    Number.isFinite(s.height) &&
    s.width > 0 &&
    s.height > 0
  );
}

/**
 * Аргументы можно передавать объектом {width, height} или числами.
 * Исходник по условию горизонтальный, поэтому при двух числах порядок не важен:
 * высота — меньшая сторона. Одно число трактуется как высота.
 */
function resolveSize(a: SourceSize | number, b?: number): { width: number; height: number } {
  if (typeof a === 'object' && a !== null) {
    return { width: Number(a.width), height: Number(a.height) };
  }
  if (typeof b === 'number' && Number.isFinite(b)) {
    return { width: Math.max(a, b), height: Math.min(a, b) };
  }
  return { width: Number.POSITIVE_INFINITY, height: Number(a) };
}

/**
 * Ширина вертикальной рамки/итогового кадра в пикселях исходника.
 * ОДНА функция и для клиентского превью, и для серверного crop.
 */
export function frameWidth(source: SourceSize): number;
export function frameWidth(sourceHeight: number, sourceWidth?: number): number;
export function frameWidth(a: SourceSize | number, b?: number): number {
  const { width, height } = resolveSize(a, b);
  if (!Number.isFinite(height) || height <= 0) return 0;
  let w = toEven(height * TARGET_ASPECT);
  if (Number.isFinite(width) && width > 0) {
    w = Math.min(w, toEven(width));
  }
  return Math.max(2, w);
}

/**
 * Ширина итогового кадра для СЕРВЕРНОГО crop.
 * Это буквально та же функция, что рисует рамку на клиенте (frameWidth):
 * общий код — единственная гарантия, что x/w сервера и превью совпадают.
 */
export const outWidth: typeof frameWidth = frameWidth;

/** Историческое имя-алиас (то же самое, что outWidth/frameWidth). */
export const outputWidth: typeof frameWidth = frameWidth;

/** Высота итогового кадра — высота исходника (приведённая к чётной). */
export function outHeight(source: SourceSize): number;
export function outHeight(sourceHeight: number, sourceWidth?: number): number;
export function outHeight(a: SourceSize | number, b?: number): number {
  const { height } = resolveSize(a, b);
  if (!Number.isFinite(height) || height <= 0) return 0;
  return Math.max(2, toEven(height));
}

/** Алиас: высота итогового кадра. */
export const outputHeight: typeof outHeight = outHeight;

/** Максимально допустимый левый край рамки: дальше она упирается в край кадра. */
export function maxFrameLeft(source: SourceSize): number {
  const w = frameWidth(source);
  return Math.max(0, Math.floor(source.width) - w);
}

/** Целочисленный левый край рамки, гарантированно внутри исходного кадра. */
export function clampFrameLeft(x: number, source: SourceSize): number {
  return clamp(Math.round(Number.isFinite(x) ? x : 0), 0, maxFrameLeft(source));
}

/** Левый край рамки по её центру (центр — в пикселях исходника). */
export function frameLeftFromCenter(centerX: number, source: SourceSize): number {
  return clampFrameLeft(centerX - frameWidth(source) / 2, source);
}

/** Центр рамки по её левому краю. */
export function frameCenterFromLeft(x: number, source: SourceSize): number {
  return clampFrameLeft(x, source) + frameWidth(source) / 2;
}

/** Левый край рамки по нормированному (0..1) центру. */
export function frameLeftFromNormalizedCenter(centerNorm: number, source: SourceSize): number {
  return frameLeftFromCenter(clamp(centerNorm, 0, 1) * source.width, source);
}

/** Нормированный (0..1) центр рамки по её левому краю. */
export function normalizedCenterFromFrameLeft(x: number, source: SourceSize): number {
  if (!(source.width > 0)) return 0.5;
  return clamp(frameCenterFromLeft(x, source) / source.width, 0, 1);
}

/** Левый край рамки, центрированной по кадру (значение по умолчанию). */
export function centeredFrameLeft(source: SourceSize): number {
  return frameLeftFromCenter(source.width / 2, source);
}

/**
 * Приведение X к чётному вниз — ровно то, что делает фильтр crop в ffmpeg для
 * yuv420p (`x &= ~1`). Вынесено отдельно, чтобы клиент рисовал превью тем же
 * прямоугольником, который получит кодек.
 */
export function alignCropX(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const floored = Math.floor(x);
  const aligned = floored - (((floored % 2) + 2) % 2);
  return aligned < 0 ? 0 : aligned;
}

/**
 * Левый край итогового crop: сначала клэмп по границам кадра, затем
 * выравнивание по цветоразностной сетке. Значение целое и одинаковое
 * на клиенте и на сервере.
 */
export function cropXForOutput(x: number, source: SourceSize): number {
  return alignCropX(clampFrameLeft(x, source));
}

/**
 * Итоговый прямоугольник обрезки. Ровно этим прямоугольником клиент рисует
 * превью (drawImage(video, x, y, width, height, 0, 0, ...)) и ровно его
 * сервер передаёт в ffmpeg-фильтр crop.
 */
export function cropRect(x: number, source: SourceSize): CropRect {
  return {
    x: cropXForOutput(x, source),
    y: 0,
    width: outWidth(source),
    height: outHeight(source),
  };
}
