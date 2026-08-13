/**
 * Отрисовка превью-канваса: рисует в canvas ровно ту область исходного
 * видео, которая попадает в вертикальную рамку, растягивая её на весь
 * канвас (соотношение сторон канваса задаётся атрибутами width/height в
 * разметке — 9:16).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewController {
  /** Отрисовать кадр рамки frame (в координатах исходного видео). */
  render(frame: Rect): void;
  /** Область исходника, реально нарисованная последним вызовом render(). */
  readonly lastRect: Rect | null;
}

// HAVE_CURRENT_DATA — минимальный readyState, при котором у видео есть
// декодированный кадр, пригодный для drawImage.
const MIN_READY_STATE = 2;

export function createPreview(canvas: HTMLCanvasElement, video: HTMLVideoElement): PreviewController {
  const ctx = canvas.getContext('2d');
  let lastRect: Rect | null = null;

  function render(frame: Rect): void {
    if (!ctx) return;
    if (!video.videoWidth || !video.videoHeight) return;
    if (video.readyState < MIN_READY_STATE) return;
    if (frame.width <= 0 || frame.height <= 0) return;

    const srcW = Math.min(frame.width, video.videoWidth);
    const srcX = Math.max(0, Math.min(frame.x, video.videoWidth - srcW));
    const srcY = 0;
    const srcH = video.videoHeight;

    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
      lastRect = { x: srcX, y: srcY, width: srcW, height: srcH };
    } catch {
      // Кадр ещё не готов к отрисовке — пропускаем этот тик, следующий rAF повторит попытку.
    }
  }

  return {
    render,
    get lastRect() {
      return lastRect;
    },
  };
}
