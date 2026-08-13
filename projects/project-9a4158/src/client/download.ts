/**
 * Кнопка #download: отправляет исходный видеофайл и текущую дорожку
 * положений рамки на сервер (POST /api/render), опрашивает прогресс сборки
 * (GET /api/render/:id) и обновляет #progress, а по готовности скачивает
 * итоговый mp4 (GET /api/render/:id/file).
 *
 * Модуль самодостаточен и не делает top-level await/сетевых запросов при
 * загрузке — он лишь вешает обработчик клика на #download, если такая кнопка
 * есть в DOM. Исходный файл и трек он берёт из window.__loom — общего
 * состояния предпросмотра (см. main.ts), с фолбэком на прямой опрос DOM,
 * чтобы модуль не падал, если main.ts предоставляет чуть иной набор полей.
 */

export interface TrackSampleDTO {
  t: number;
  x: number;
}

export interface TrackDTO {
  duration: number;
  videoWidth: number;
  videoHeight: number;
  samples: TrackSampleDTO[];
}

export interface LoomGlobalState {
  getFile?: () => File | null | undefined;
  getTrack?: () => TrackDTO | null | undefined;
  file?: File | null;
  track?: TrackDTO | null;
}

declare global {
  interface Window {
    __loom?: LoomGlobalState;
  }
}

const POLL_INTERVAL_MS = 500;

function resolveFile(doc: Document): File | null {
  const loom = window.__loom;
  if (loom) {
    if (typeof loom.getFile === 'function') {
      const f = loom.getFile();
      if (f) return f;
    }
    if (loom.file) return loom.file;
  }
  const input = doc.querySelector<HTMLInputElement>('input[type="file"]');
  return input?.files?.[0] ?? null;
}

function resolveTrack(): TrackDTO | null {
  const loom = window.__loom;
  if (loom) {
    if (typeof loom.getTrack === 'function') {
      const t = loom.getTrack();
      if (t) return t;
    }
    if (loom.track) return loom.track;
  }
  return null;
}

function setProgressUI(el: Element | null, ratio: number): void {
  if (!el) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  if (el instanceof HTMLProgressElement) {
    el.max = 1;
    el.value = clamped;
  }
  el.textContent = `${Math.round(clamped * 100)}%`;
}

function setProgressError(el: Element | null, message: string): void {
  if (!el) return;
  el.textContent = `Ошибка: ${message}`;
}

interface RenderStatus {
  state: 'running' | 'done' | 'error';
  progress: number;
  error?: string;
}

async function pollJob(jobId: string, progressEl: Element | null): Promise<void> {
  for (;;) {
    const res = await fetch(`/api/render/${encodeURIComponent(jobId)}`);
    if (!res.ok) {
      throw new Error(`status request failed: ${res.status}`);
    }
    const data = (await res.json()) as RenderStatus;
    if (data.state === 'error') {
      throw new Error(data.error || 'render failed');
    }
    setProgressUI(progressEl, data.progress ?? 0);
    if (data.state === 'done') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function triggerFileDownload(jobId: string, doc: Document): Promise<void> {
  const res = await fetch(`/api/render/${encodeURIComponent(jobId)}/file`);
  if (!res.ok) {
    throw new Error(`file request failed: ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = 'vertical.mp4';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function startDownloadFlow(
  button: HTMLButtonElement,
  progressEl: Element | null,
  doc: Document
): Promise<void> {
  const file = resolveFile(doc);
  const track = resolveTrack();
  if (!file) {
    setProgressError(progressEl, 'нет исходного файла');
    return;
  }
  if (!track || !Array.isArray(track.samples)) {
    setProgressError(progressEl, 'нет данных трека');
    return;
  }

  button.disabled = true;
  setProgressUI(progressEl, 0);
  try {
    const form = new FormData();
    form.append('video', file, file.name);
    form.append('track', JSON.stringify(track));

    const res = await fetch('/api/render', { method: 'POST', body: form });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `render request failed: ${res.status}`);
    }
    const { jobId } = (await res.json()) as { jobId?: string };
    if (!jobId) {
      throw new Error('server did not return jobId');
    }

    await pollJob(jobId, progressEl);
    setProgressUI(progressEl, 1);
    await triggerFileDownload(jobId, doc);
  } catch (err) {
    setProgressError(progressEl, err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
  }
}

/** Вешает обработчик клика на #download. Безопасно вызывать повторно (idempotent) — второй вызов просто найдёт ту же кнопку и переустановит обработчик. */
export function initDownload(doc: Document = document): void {
  const button = doc.querySelector<HTMLButtonElement>('#download');
  if (!button) return;
  const progressEl = doc.querySelector('#progress');
  button.addEventListener('click', () => {
    void startDownloadFlow(button, progressEl, doc);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initDownload());
  } else {
    initDownload();
  }
}
