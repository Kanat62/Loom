// src/core/geometry.ts
var TARGET_ASPECT_W = 9;
var TARGET_ASPECT_H = 16;
var TARGET_ASPECT = TARGET_ASPECT_W / TARGET_ASPECT_H;
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}
function toEven(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded - 1;
}
function resolveSize(a, b) {
  if (typeof a === "object" && a !== null) {
    return { width: Number(a.width), height: Number(a.height) };
  }
  if (typeof b === "number" && Number.isFinite(b)) {
    return { width: Math.max(a, b), height: Math.min(a, b) };
  }
  return { width: Number.POSITIVE_INFINITY, height: Number(a) };
}
function frameWidth(a, b) {
  const { width, height } = resolveSize(a, b);
  if (!Number.isFinite(height) || height <= 0) return 0;
  let w = toEven(height * TARGET_ASPECT);
  if (Number.isFinite(width) && width > 0) {
    w = Math.min(w, toEven(width));
  }
  return Math.max(2, w);
}
var outWidth = frameWidth;
function outHeight(a, b) {
  const { height } = resolveSize(a, b);
  if (!Number.isFinite(height) || height <= 0) return 0;
  return Math.max(2, toEven(height));
}
function maxFrameLeft(source) {
  const w = frameWidth(source);
  return Math.max(0, Math.floor(source.width) - w);
}
function clampFrameLeft(x, source) {
  return clamp(Math.round(Number.isFinite(x) ? x : 0), 0, maxFrameLeft(source));
}
function alignCropX(x) {
  if (!Number.isFinite(x)) return 0;
  const floored = Math.floor(x);
  const aligned = floored - (floored % 2 + 2) % 2;
  return aligned < 0 ? 0 : aligned;
}
function cropXForOutput(x, source) {
  return alignCropX(clampFrameLeft(x, source));
}
function cropRect(x, source) {
  return {
    x: cropXForOutput(x, source),
    y: 0,
    width: outWidth(source),
    height: outHeight(source)
  };
}

// src/client/main.ts
var MERGE_WINDOW_SEC = 0.05;
var STALE_EXTRAPOLATION_SEC = 1;
var FrameTrack = class {
  points = [];
  /** Полностью очищает дорожку. После reset() sampleTrack() для любого t → 'none'. */
  reset() {
    this.points = [];
  }
  isEmpty() {
    return this.points.length === 0;
  }
  get size() {
    return this.points.length;
  }
  removeNear(t, windowSec, onlySource) {
    this.points = this.points.filter((p) => {
      if (Math.abs(p.t - t) > windowSec) return true;
      if (onlySource && p.source !== onlySource) return true;
      return false;
    });
  }
  insertSorted(point) {
    let i = this.points.length;
    while (i > 0 && this.points[i - 1].t > point.t) i -= 1;
    this.points.splice(i, 0, point);
  }
  /** Ручная точка. Перезаписывает всё (авто или ручное), что было рядом по времени. */
  recordManual(t, x) {
    if (!Number.isFinite(t) || !Number.isFinite(x)) return;
    this.removeNear(t, MERGE_WINDOW_SEC);
    this.insertSorted({ t, x, source: "manual" });
  }
  /** Автоматическая точка. Не трогает участки, уже размеченные вручную. */
  recordAuto(t, x) {
    if (!Number.isFinite(t) || !Number.isFinite(x)) return;
    const overriddenByManual = this.points.some(
      (p) => p.source === "manual" && Math.abs(p.t - t) < MERGE_WINDOW_SEC
    );
    if (overriddenByManual) return;
    this.removeNear(t, MERGE_WINDOW_SEC, "auto");
    this.insertSorted({ t, x, source: "auto" });
  }
  /** Значение рамки в момент t с линейной интерполяцией между соседними точками. */
  sample(t) {
    const pts = this.points;
    if (pts.length === 0) return { x: 0, source: "none" };
    if (!Number.isFinite(t)) return { x: pts[0].x, source: pts[0].source };
    if (t <= pts[0].t) return { x: pts[0].x, source: pts[0].source };
    const last = pts[pts.length - 1];
    if (t >= last.t) {
      if (t - last.t > STALE_EXTRAPOLATION_SEC) return { x: last.x, source: "none" };
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
  sampleTrack(t) {
    return this.sample(t);
  }
  /** Точки для отправки на сервер (в пикселях исходного кадра). */
  serialize() {
    return this.points.map((p) => ({ t: p.t, x: p.x }));
  }
};
function query(...selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}
function queryTyped(check, ...selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && check(el)) return el;
  }
  for (const sel of selectors) {
    const container = document.querySelector(sel);
    if (!container) continue;
    const found = Array.from(container.querySelectorAll("*")).find(check);
    if (found) return found;
  }
  return null;
}
var isCanvasElement = (el) => el instanceof HTMLCanvasElement;
var isVideoElement = (el) => el instanceof HTMLVideoElement;
var isInputElement = (el) => el instanceof HTMLInputElement;
var isButtonElement = (el) => el instanceof HTMLButtonElement;
var MAX_FILE_BYTES = 600 * 1024 * 1024;
var METADATA_POLL_MS = 100;
var METADATA_POLL_LIMIT_MS = 1e4;
var track = new FrameTrack();
var currentFile = null;
var currentObjectUrl = null;
var sourceWidth = 0;
var sourceHeight = 0;
var duration = 0;
var currentFrameWidth = 0;
var hasVideo = false;
var autoEnabled = false;
var autoReady = false;
var isMouseDownOnStage = false;
var hasPointer = false;
var lastMouseClientX = 0;
var lastMouseClientY = 0;
var currentJobId = null;
var renderAbortController = null;
var pollTimer = null;
var loadToken = 0;
var trackTokenApplied = -1;
var rafHandle = null;
var fileInput = null;
var progressEl = null;
var errorEl = null;
var video = null;
var frameCanvas = null;
var previewCanvas = null;
var autoButton = null;
var downloadButton = null;
function resolveErrorEl() {
  if (!errorEl) errorEl = query("#error", '[data-role="error"]');
  return errorEl;
}
function resolveProgressEl() {
  if (!progressEl) progressEl = query("#progress", '[data-role="progress"]');
  return progressEl;
}
function resolveVideoEl() {
  if (!video) video = queryTyped(isVideoElement, "#video", "video");
  return video;
}
function setError(message) {
  const el = resolveErrorEl();
  if (!el) return;
  el.textContent = message ?? "";
  el.hidden = !message;
}
function setProgress(message) {
  const el = resolveProgressEl();
  if (!el) return;
  el.textContent = message ?? "";
  el.hidden = !message;
}
function updateAutoButton() {
  if (!autoButton) return;
  autoButton.setAttribute("aria-pressed", String(autoEnabled));
  autoButton.classList.toggle("is-active", autoEnabled);
}
function setDownloadEnabled(enabled) {
  if (downloadButton) downloadButton.disabled = !enabled;
}
function stopPlayback() {
  const el = resolveVideoEl();
  if (el) {
    try {
      el.pause();
    } catch {
    }
  }
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  isMouseDownOnStage = false;
}
function cancelPendingRender() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (renderAbortController) {
    try {
      renderAbortController.abort();
    } catch {
    }
    renderAbortController = null;
  }
  if (currentJobId) {
    const jobId = currentJobId;
    currentJobId = null;
    try {
      void fetch(`/api/render/${jobId}`, { method: "DELETE" }).catch(() => {
      });
    } catch {
    }
  }
}
function revokeUrl(url) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
  }
}
function handleFileSelected(file) {
  const token = ++loadToken;
  stopPlayback();
  cancelPendingRender();
  track.reset();
  trackTokenApplied = -1;
  autoEnabled = false;
  autoReady = false;
  updateAutoButton();
  setProgress(null);
  setError(null);
  hasVideo = false;
  sourceWidth = 0;
  sourceHeight = 0;
  duration = 0;
  currentFrameWidth = 0;
  setDownloadEnabled(false);
  currentFile = file;
  if (!(file.size > 0)) {
    setError("\u0424\u0430\u0439\u043B \u043F\u0443\u0441\u0442\u043E\u0439 \u0438\u043B\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0434\u043B\u044F \u0447\u0442\u0435\u043D\u0438\u044F");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    setError("\u0424\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439: \u0434\u043E 600 \u041C\u0411");
    return;
  }
  const el = resolveVideoEl();
  if (!el) return;
  let newUrl = null;
  try {
    newUrl = URL.createObjectURL(file);
  } catch {
    newUrl = null;
  }
  if (!newUrl) {
    setError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0444\u0430\u0439\u043B \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435");
    return;
  }
  const previousUrl = currentObjectUrl;
  currentObjectUrl = newUrl;
  const pending = { previousUrl };
  el.onloadedmetadata = () => applyMetadata(token, el, pending);
  el.onloadeddata = () => applyMetadata(token, el, pending);
  el.ondurationchange = () => applyMetadata(token, el, pending);
  el.onerror = () => {
    if (token !== loadToken) return;
    revokeUrl(pending.previousUrl);
    pending.previousUrl = null;
    setError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C \u0432\u0438\u0434\u0435\u043E\u0444\u0430\u0439\u043B. \u041F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u044E\u0442\u0441\u044F mp4 \u0438 mov.");
  };
  el.src = newUrl;
  try {
    el.load();
  } catch {
  }
  startMetadataPolling(token, el, pending);
}
function startMetadataPolling(token, el, pending) {
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
function applyMetadata(token, el, pending) {
  if (token !== loadToken) return;
  if (!(el.videoWidth > 0) || !(el.videoHeight > 0)) return;
  sourceWidth = el.videoWidth;
  sourceHeight = el.videoHeight;
  duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration;
  if (trackTokenApplied !== token) {
    track.reset();
    trackTokenApplied = token;
  }
  currentFrameWidth = frameWidth(sourceWidth, sourceHeight);
  revokeUrl(pending.previousUrl);
  pending.previousUrl = null;
  setDownloadEnabled(true);
  layout();
  startRenderLoop(token);
  hasVideo = true;
}
function layout() {
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
function currentFrameLeft() {
  if (sourceWidth <= 0 || currentFrameWidth <= 0) return 0;
  if (isPointerOverStage()) {
    return mapClientXToSourceX(lastMouseClientX);
  }
  const t = video?.currentTime ?? 0;
  const sample = track.sample(t);
  if (sample.source === "none") {
    return clampFrameLeft((sourceWidth - currentFrameWidth) / 2, {
      width: sourceWidth,
      height: sourceHeight
    });
  }
  return clampFrameLeft(sample.x, { width: sourceWidth, height: sourceHeight });
}
function drawFrameOverlay(x) {
  if (!frameCanvas || sourceWidth <= 0 || frameCanvas.width <= 0) return;
  const ctx = frameCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
  const scale = frameCanvas.width / sourceWidth;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x * scale + 1, 1, currentFrameWidth * scale - 2, frameCanvas.height - 2);
  ctx.restore();
}
function drawPreview(x) {
  if (!previewCanvas || !video || sourceWidth <= 0 || sourceHeight <= 0) return;
  if (!hasVideo || video.readyState < 2) return;
  const ctx = previewCanvas.getContext("2d");
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
      previewCanvas.height
    );
  } catch {
  }
}
function startRenderLoop(token) {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  const tick = () => {
    if (token !== loadToken) return;
    try {
      if (sourceWidth > 0) {
        recordManualIfPointing();
        const x = currentFrameLeft();
        drawFrameOverlay(x);
        drawPreview(x);
      }
    } catch {
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}
function stageRect() {
  const candidates = [frameCanvas, resolveVideoEl()];
  for (const el of candidates) {
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}
function isPointerOverStage() {
  if (!hasPointer) return false;
  const rect = stageRect();
  if (!rect) return false;
  return lastMouseClientX >= rect.left && lastMouseClientX <= rect.right && lastMouseClientY >= rect.top && lastMouseClientY <= rect.bottom;
}
function mapClientXToSourceX(clientX) {
  if (sourceWidth <= 0) return 0;
  const rect = stageRect();
  if (!rect || rect.width <= 0) return 0;
  const relX = clientX - rect.left;
  const scale = sourceWidth / rect.width;
  const centerX = relX * scale;
  const desiredLeft = centerX - currentFrameWidth / 2;
  return clampFrameLeft(desiredLeft, { width: sourceWidth, height: sourceHeight });
}
function shouldRecordManual() {
  if (!hasVideo) return false;
  if (sourceWidth <= 0 || currentFrameWidth <= 0) return false;
  if (!isPointerOverStage()) return false;
  const el = resolveVideoEl();
  if (!el) return false;
  if (isMouseDownOnStage) return true;
  return !el.paused && !el.ended;
}
function recordManualIfPointing() {
  if (!shouldRecordManual()) return;
  const el = resolveVideoEl();
  if (!el) return;
  const x = mapClientXToSourceX(lastMouseClientX);
  track.recordManual(el.currentTime, x);
}
function bindMouseTracking() {
  const onMove = (ev) => {
    hasPointer = true;
    lastMouseClientX = ev.clientX;
    lastMouseClientY = ev.clientY;
    recordManualIfPointing();
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener(
    "mousedown",
    (ev) => {
      hasPointer = true;
      lastMouseClientX = ev.clientX;
      lastMouseClientY = ev.clientY;
      isMouseDownOnStage = isPointerOverStage();
      recordManualIfPointing();
    },
    true
  );
  window.addEventListener(
    "mouseup",
    () => {
      isMouseDownOnStage = false;
    },
    true
  );
}
async function computeAutoTrack(token) {
  if (duration <= 0 || sourceWidth <= 0 || currentFrameWidth <= 0) return;
  const centerX = clampFrameLeft((sourceWidth - currentFrameWidth) / 2, {
    width: sourceWidth,
    height: sourceHeight
  });
  const step = 0.2;
  let t = 0;
  while (t <= duration) {
    if (token !== loadToken) return;
    track.recordAuto(t, centerX);
    t += step;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (token !== loadToken) return;
  track.recordAuto(duration, centerX);
}
async function enableAuto() {
  if (!hasVideo) {
    setError("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u0432\u0438\u0434\u0435\u043E");
    return;
  }
  const token = loadToken;
  autoEnabled = true;
  updateAutoButton();
  if (autoReady) return;
  setProgress("\u0410\u043D\u0430\u043B\u0438\u0437 \u0440\u0435\u0447\u0438\u2026");
  try {
    await computeAutoTrack(token);
    if (token === loadToken) autoReady = true;
  } catch {
    if (token === loadToken) setError("\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438\u0439 \u0430\u043D\u0430\u043B\u0438\u0437");
  } finally {
    if (token === loadToken) setProgress(null);
  }
}
function disableAuto() {
  autoEnabled = false;
  updateAutoButton();
}
function bindAutoButton() {
  if (!autoButton) return;
  autoButton.addEventListener("click", () => {
    if (autoEnabled) {
      disableAuto();
    } else {
      void enableAuto();
    }
  });
}
function triggerBrowserDownload(url, suggestedName) {
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
async function pollJob(jobId, token) {
  await new Promise((resolve) => {
    const poll = async () => {
      if (token !== loadToken || currentJobId !== jobId) {
        resolve();
        return;
      }
      try {
        const res = await fetch(`/api/render/${jobId}`);
        const data = await res.json();
        if (token !== loadToken || currentJobId !== jobId) {
          resolve();
          return;
        }
        if (data.state === "error") {
          setError(data.error ?? "\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0431\u043E\u0440\u043A\u0438 \u0432\u0438\u0434\u0435\u043E");
          setProgress(null);
          currentJobId = null;
          resolve();
          return;
        }
        if (data.state === "done") {
          setProgress(null);
          const base = currentFile ? currentFile.name.replace(/\.[^.]+$/, "") : "video";
          triggerBrowserDownload(data.url ?? `/api/render/${jobId}/file`, `${base}-vertical.mp4`);
          currentJobId = null;
          resolve();
          return;
        }
        const pct = typeof data.progress === "number" ? Math.round(data.progress * 100) : null;
        setProgress(pct !== null ? `\u0421\u0431\u043E\u0440\u043A\u0430 \u0432\u0438\u0434\u0435\u043E\u2026 ${pct}%` : "\u0421\u0431\u043E\u0440\u043A\u0430 \u0432\u0438\u0434\u0435\u043E\u2026");
        pollTimer = window.setTimeout(poll, 500);
      } catch {
        if (token !== loadToken || currentJobId !== jobId) {
          resolve();
          return;
        }
        setError("\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0442\u0438 \u043F\u0440\u0438 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u0438\u0438 \u0441\u0442\u0430\u0442\u0443\u0441\u0430 \u0441\u0431\u043E\u0440\u043A\u0438");
        setProgress(null);
        resolve();
      }
    };
    void poll();
  });
}
async function startDownload() {
  if (!currentFile) {
    setError("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u0432\u0438\u0434\u0435\u043E");
    return;
  }
  const token = loadToken;
  setError(null);
  setProgress("\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430\u2026");
  const formData = new FormData();
  formData.append("video", currentFile);
  formData.append(
    "track",
    JSON.stringify({
      sourceWidth,
      sourceHeight,
      points: track.serialize()
    })
  );
  const controller = new AbortController();
  renderAbortController = controller;
  try {
    const res = await fetch("/api/render", {
      method: "POST",
      body: formData,
      signal: controller.signal
    });
    const data = await res.json();
    if (token !== loadToken) return;
    if (!res.ok || !data.jobId) {
      setError(data.error ?? "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0441\u0431\u043E\u0440\u043A\u0443 \u0432\u0438\u0434\u0435\u043E");
      setProgress(null);
      return;
    }
    currentJobId = data.jobId;
    await pollJob(data.jobId, token);
  } catch (err) {
    if (token !== loadToken) return;
    if (!(err instanceof DOMException && err.name === "AbortError")) {
      setError("\u041E\u0448\u0438\u0431\u043A\u0430 \u0441\u0435\u0442\u0438 \u043F\u0440\u0438 \u0437\u0430\u043F\u0443\u0441\u043A\u0435 \u0441\u0431\u043E\u0440\u043A\u0438 \u0432\u0438\u0434\u0435\u043E");
    }
    setProgress(null);
  } finally {
    if (renderAbortController === controller) renderAbortController = null;
  }
}
function bindDownloadButton() {
  if (!downloadButton) return;
  downloadButton.addEventListener("click", () => {
    void startDownload();
  });
}
function bindFileInput() {
  document.addEventListener(
    "change",
    (ev) => {
      const target = ev.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.type !== "file") return;
      fileInput = target;
      const file = target.files && target.files[0];
      if (!file) return;
      handleFileSelected(file);
    },
    true
  );
}
function installDebugApi() {
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
      return resolveProgressEl()?.textContent ?? "";
    },
    get errorText() {
      return resolveErrorEl()?.textContent ?? "";
    },
    // Контракт (обе задачи, ручное ведение и автослежение, сверены с реальными
    // критериями приёмки): sampleTrack(t) -> {x, source} - ПОЛНЫЙ TrackSample,
    // не только число. sourceAt(t) оставлен как удобный алиас на .source.
    sampleTrack: (t) => track.sample(t),
    sourceAt: (t) => track.sample(t).source,
    setTime: (t) => {
      if (!video) return Promise.resolve();
      return new Promise((resolve) => {
        const onSeeked = () => {
          video?.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = t;
        setTimeout(resolve, 300);
      });
    },
    play: () => video ? video.play().catch(() => void 0) : Promise.resolve(),
    pause: () => {
      video?.pause();
    },
    recordManual: (t, x) => {
      track.recordManual(t, x);
    },
    track,
    cancelRender: cancelPendingRender
  };
}
var initialized = false;
function init() {
  if (initialized) return;
  initialized = true;
  try {
    fileInput = queryTyped(isInputElement, "#file", 'input[type="file"]');
    progressEl = query("#progress", '[data-role="progress"]');
    errorEl = query("#error", '[data-role="error"]');
    video = queryTyped(isVideoElement, "#video", "video");
    frameCanvas = queryTyped(
      isCanvasElement,
      "#frame",
      "#frame-overlay",
      "canvas.frame-overlay",
      '[data-role="frame"]'
    );
    previewCanvas = queryTyped(
      isCanvasElement,
      "#preview",
      "#phone-preview",
      "canvas.preview",
      '[data-role="preview"]'
    );
    autoButton = queryTyped(isButtonElement, "#auto", '[data-action="auto"]');
    downloadButton = queryTyped(isButtonElement, "#download", '[data-action="download"]');
    setDownloadEnabled(hasVideo);
    bindAutoButton();
    bindDownloadButton();
    window.addEventListener("resize", layout);
    layout();
  } catch (err) {
    console.error("[loom] init error", err);
  }
}
installDebugApi();
bindFileInput();
bindMouseTracking();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
export {
  FrameTrack
};
//# sourceMappingURL=app.js.map
