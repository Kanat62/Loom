/**
 * LOOM — небольшие асинхронные утилиты клиента.
 *
 * Главное правило модуля: ни одно ожидание не может висеть вечно.
 * Любая операция, зависящая от событий браузера (загрузка видео, seek,
 * инициализация wasm), оборачивается таймаутом и возвращает признак неудачи
 * вместо исключения.
 */

export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, Math.max(0, ms));
  });
}

/** Отдаёт управление браузеру (перерисовка прогресса между шагами цикла). */
export function nextTask(): Promise<void> {
  return delay(0);
}

/** Ждёт промис не дольше ms; при таймауте или ошибке отдаёт fallback. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      if (timer) window.clearTimeout(timer);
      resolve(value);
    };
    timer = window.setTimeout(() => finish(fallback), Math.max(0, ms));
    promise.then(
      (value) => finish(value),
      () => finish(fallback)
    );
  });
}

/** Ждёт одно из событий; true — дождались, false — таймаут или 'error'. */
export function waitForEvent(
  target: EventTarget,
  names: string | string[],
  timeoutMs: number
): Promise<boolean> {
  const list = typeof names === 'string' ? [names] : names;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      for (const name of list) target.removeEventListener(name, onEvent);
      target.removeEventListener('error', onError);
      if (timer) window.clearTimeout(timer);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const onError = () => finish(false);
    for (const name of list) target.addEventListener(name, onEvent);
    target.addEventListener('error', onError);
    timer = window.setTimeout(() => finish(false), Math.max(0, timeoutMs));
  });
}

/** fetch с таймаутом: вместо исключения — null. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  const hasAbort = typeof AbortController !== 'undefined';
  const controller = hasAbort ? new AbortController() : null;
  const timer = window.setTimeout(() => {
    try {
      if (controller) controller.abort();
    } catch {
      // безразлично
    }
  }, Math.max(1, timeoutMs));
  try {
    const options: RequestInit = controller ? { ...init, signal: controller.signal } : init;
    return await fetch(url, options);
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}
