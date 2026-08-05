// core/herouiDocs.js - актуальная документация HeroUI по факту, не по памяти
// (§6.7 ТЗ, шрам 24, но про UI-библиотеку). Модель обучалась на старом срезе
// и путает API HeroUI v3 (Tailwind v4, OKLCH, compound-компоненты, .Root-
// суффиксы) - Дизайнер и Исполнитель получают этот блок в user-контекст.
//
// Деградация ОБЯЗАТЕЛЬНА: сеть недоступна -> честная пометка, НИКОГДА не
// притворяемся, что документация загружена, когда это не так (§8.5 ТЗ,
// тот же принцип "не симулировать проверку", применённый к документации).
import fs from 'node:fs';
import path from 'node:path';
import { getTmpDir, HEROUI_VERSION } from './config.js';

const HEROUI_LLMS_URL = 'https://www.heroui.com/react/llms.txt';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24ч - актуальность важнее частоты обновления

function cacheFile() {
  return path.join(getTmpDir(), `heroui-docs-${HEROUI_VERSION}.txt`);
}

function readCache() {
  const file = cacheFile();
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    return { text, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

function writeCache(text) {
  fs.mkdirSync(getTmpDir(), { recursive: true });
  fs.writeFileSync(cacheFile(), text, 'utf8');
}

async function fetchLive() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(HEROUI_LLMS_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * getHeroUIDocs - актуальный индекс документации HeroUI React (компоненты +
 * ссылки). Кэш на диске (24ч) - не бьём сеть на каждый вызов Дизайнера/
 * Исполнителя. Деградация: сеть недоступна и кэш пуст/стух -> честная строка
 * "документация недоступна", НЕ фабрикуем содержимое.
 */
export async function getHeroUIDocs() {
  const cached = readCache();
  if (cached && cached.ageMs < CACHE_TTL_MS) {
    return { text: cached.text, source: 'cache', live: false };
  }

  try {
    const text = await fetchLive();
    writeCache(text);
    return { text, source: 'live', live: true };
  } catch (err) {
    if (cached) {
      return { text: cached.text, source: 'stale-cache', live: false, error: err.message };
    }
    return {
      text: `[HeroUI ${HEROUI_VERSION} документация недоступна: сеть не отвечает (${err.message}). Не сочиняй API компонентов из головы - используй только базовые, широко известные паттерны HTML/CSS, либо явно отметь предположение как предположение.]`,
      source: 'unavailable',
      live: false,
      error: err.message,
    };
  }
}
