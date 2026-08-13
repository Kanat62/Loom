/**
 * Слой ВВОДА для ручного ведения рамки.
 *
 * Здесь нет ничего про <video>, дорожку положений и отрисовку — только:
 *   1) где сейчас курсор (PointerTracker),
 *   2) как перевести экранную координату в координату ИСХОДНОГО кадра
 *      (contentRect + screenToSourceX),
 *   3) как плавно довести рамку до цели (Smoother).
 *
 * Формула ширины вертикального кадра здесь НЕ дублируется: она живёт
 * в src/core/geometry.ts и общая с сервером.
 */

/** Прямоугольник РЕАЛЬНОГО содержимого кадра на экране (client-координаты). */
export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** экранных пикселей на один пиксель исходника */
  scale: number;
}

/**
 * Прямоугольник кадра внутри элемента с учётом вписывания (object-fit: contain).
 * Если размеры исходника неизвестны — возвращает сам бокс элемента.
 */
export function contentRect(
  element: Element,
  srcWidth: number,
  srcHeight: number,
): ContentRect {
  const box = element.getBoundingClientRect();
  if (!(srcWidth > 0) || !(srcHeight > 0) || box.width <= 0 || box.height <= 0) {
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      scale: box.width > 0 && srcWidth > 0 ? box.width / srcWidth : 1,
    };
  }
  const scale = Math.min(box.width / srcWidth, box.height / srcHeight);
  const width = srcWidth * scale;
  const height = srcHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
    scale,
  };
}

/** Экранный X -> X в координатах исходного кадра (пиксели исходника). */
export function screenToSourceX(clientX: number, rect: ContentRect): number {
  if (!Number.isFinite(clientX) || !(rect.scale > 0)) return 0;
  return (clientX - rect.left) / rect.scale;
}

/** Клэмп ЛЕВОГО края рамки в границы исходного кадра: 0 <= x <= srcWidth - frameW. */
export function clampFrameLeft(x: number, frameWidthPx: number, srcWidth: number): number {
  const max = Math.max(0, (srcWidth || 0) - (frameWidthPx || 0));
  if (!Number.isFinite(x)) return max / 2;
  if (x < 0) return 0;
  if (x > max) return max;
  return x;
}

/** Левый край рамки для заданного центра (в координатах исходника), с упором в края. */
export function frameLeftForCenter(
  centerSrcX: number,
  frameWidthPx: number,
  srcWidth: number,
): number {
  return clampFrameLeft(centerSrcX - frameWidthPx / 2, frameWidthPx, srcWidth);
}

/**
 * Экспоненциальное сглаживание с заданным ВРЕМЕНЕМ ВЫХОДА на цель.
 * За settleSeconds остаётся меньше 1% рассогласования (5 постоянных времени),
 * движение непрерывное — без рывков и без дрожания.
 */
export class Smoother {
  private readonly settleSeconds: number;
  private current = 0;
  private targetValue = 0;

  constructor(settleSeconds = 0.2) {
    this.settleSeconds = Math.max(0.001, settleSeconds);
  }

  /** Время выхода на цель, секунды. */
  get settleTime(): number {
    return this.settleSeconds;
  }

  get value(): number {
    return this.current;
  }

  get target(): number {
    return this.targetValue;
  }

  set target(value: number) {
    if (Number.isFinite(value)) this.targetValue = value;
  }

  /** Мгновенно поставить значение (перемотка, загрузка, чтение из дорожки). */
  snap(value: number): void {
    if (!Number.isFinite(value)) return;
    this.current = value;
    this.targetValue = value;
  }

  /** Шаг сглаживания за dt секунд. */
  step(dt: number): number {
    if (!Number.isFinite(dt) || dt <= 0) return this.current;
    const delta = this.targetValue - this.current;
    if (Math.abs(delta) < 0.01) {
      this.current = this.targetValue;
      return this.current;
    }
    const tau = this.settleSeconds / 5;
    const k = 1 - Math.exp(-Math.min(dt, 0.25) / tau);
    this.current += delta * k;
    return this.current;
  }
}

/**
 * Отслеживает курсор над сценой.
 *
 * Активность включается ПЕРВЫМ движением мыши внутри сцены и держится, пока её
 * явно не сбросят (перемотка/пауза/новый файл). Если курсор ушёл за пределы
 * сцены — координата продолжает учитываться, но рамка упрётся в край кадра
 * (клэмп делается уже в геометрии, здесь координата не искажается).
 *
 * Слушатели висят на window в фазе ПЕРЕХВАТА: так ловятся и обычные
 * всплывающие события, и синтетические, отправленные прямо в элемент.
 */
export class PointerTracker {
  private element: Element | null = null;
  private activeFlag = false;
  private lastClientX = 0;
  private lastClientY = 0;
  private lastMoveAt = 0;

  private readonly handler = (event: Event): void => {
    this.handleMove(event as MouseEvent);
  };

  attach(element: Element): void {
    this.detach();
    this.element = element;
    window.addEventListener('mousemove', this.handler, true);
    window.addEventListener('pointermove', this.handler, true);
    window.addEventListener('mousedown', this.handler, true);
  }

  detach(): void {
    if (!this.element) return;
    window.removeEventListener('mousemove', this.handler, true);
    window.removeEventListener('pointermove', this.handler, true);
    window.removeEventListener('mousedown', this.handler, true);
    this.element = null;
    this.activeFlag = false;
  }

  private handleMove(event: MouseEvent): void {
    const element = this.element;
    if (!element) return;
    const x = event.clientX;
    const y = event.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      if (inside) this.activeFlag = true;
    }
    if (!this.activeFlag) return;

    this.lastClientX = x;
    this.lastClientY = y;
    this.lastMoveAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Ведёт ли сейчас рамку пользователь мышью. */
  get active(): boolean {
    return this.activeFlag;
  }

  get clientX(): number {
    return this.lastClientX;
  }

  get clientY(): number {
    return this.lastClientY;
  }

  get lastMoveTime(): number {
    return this.lastMoveAt;
  }

  /** Отдать управление дорожке (перемотка, пауза, новый файл). */
  deactivate(): void {
    this.activeFlag = false;
  }
}
