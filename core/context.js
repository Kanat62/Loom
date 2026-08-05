// core/context.js - Context Engineering (§6 ТЗ). "Глаза" Исполнителя:
//   1. Дельта, не снимок: ход 2 - полный snapshot, ходы 3+ - только
//      added/removed/changed относительно того, что видел прошлый вызов.
//   2. Фильтр мусора: `.min.*`, файлы > 50КБ, бинарники -> заглушка (шрам 30).
//   3. Релевантность: полный текст - только touches_files задачи; остальным -
//      имя + первые 30 строк.
//   4. Дизайн-система доставляется ВСЕГДА полностью - это делает agents/coder.js
//      отдельно от снимка workspace, не в этом модуле.
//
// Счётчик "ходов" - число вызовов Исполнителя ПО ПРОЕКТУ (не по задаче): вызов
// N+1 сравнивается с тем, что физически лежало на диске на момент вызова N
// (карта sha256-хешей файлов, персистентная в journal.projects.context_state -
// переживает падение процесса, как и всё остальное состояние LOOM).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { workspaceDir } from './projects.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.history', '.loom-tmp', 'dist', 'build']);
const MAX_FULL_FILE_BYTES = 50 * 1024; // §6.2 ТЗ
const BINARY_EXT_RE = /\.(png|jpg|jpeg|gif|webp|ico|mp4|mov|webm|mp3|wav|zip|woff2?|ttf|otf|pdf)$/i;
const MINIFIED_RE = /\.min\.[jc]sx?$/i;
const RELEVANCE_HEAD_LINES = 30;

function listFilesRecursive(rootDir) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.push(full);
    }
  }
  walk(rootDir);
  return results;
}

export function isGarbage(relPath, sizeBytes) {
  if (MINIFIED_RE.test(relPath)) return true;
  if (BINARY_EXT_RE.test(relPath)) return true;
  if (sizeBytes > MAX_FULL_FILE_BYTES) return true;
  return false;
}

function readFileSafe(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toRel(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/**
 * scanWorkspace - читает текущее состояние диска один раз: и хеши (для
 * дельты), и содержимое (для рендера) в одном проходе.
 * Возвращает Map<relPath, {hash, content|null, garbage, sizeBytes}>.
 */
function scanWorkspace(projectId) {
  const root = workspaceDir(projectId);
  const files = listFilesRecursive(root);
  const entries = new Map();
  for (const absPath of files) {
    const relPath = toRel(root, absPath);
    const stat = fs.statSync(absPath);
    if (isGarbage(relPath, stat.size)) {
      entries.set(relPath, { hash: `garbage:${stat.size}`, content: null, garbage: true, sizeBytes: stat.size });
      continue;
    }
    const content = readFileSafe(absPath);
    if (content === null) {
      entries.set(relPath, { hash: 'unreadable', content: null, garbage: false, unreadable: true });
      continue;
    }
    entries.set(relPath, { hash: sha256(content), content, garbage: false });
  }
  return entries;
}

/**
 * diffFileMaps - §6.1 ТЗ: added/removed/changed относительно прошлого хода.
 */
export function diffFileMaps(prevHashes, current) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [relPath, entry] of current) {
    if (!(relPath in prevHashes)) added.push(relPath);
    else if (prevHashes[relPath] !== entry.hash) changed.push(relPath);
  }
  for (const relPath of Object.keys(prevHashes)) {
    if (!current.has(relPath)) removed.push(relPath);
  }
  added.sort();
  changed.sort();
  removed.sort();
  return { added, removed, changed };
}

/**
 * renderEntry - §6.3 ТЗ: полный текст только touches_files, остальным -
 * имя + первые 30 строк.
 */
function renderEntry(relPath, entry, isTouched) {
  if (entry.garbage) {
    return `--- ${relPath} ---\n[библиотека/бинарник, ${Math.round(entry.sizeBytes / 1024)}КБ - не читается]`;
  }
  if (entry.unreadable) {
    return `--- ${relPath} ---\n[не удалось прочитать как текст]`;
  }
  if (isTouched) {
    return `--- ${relPath} (полностью, затрагивается задачей) ---\n${entry.content}`;
  }
  const lines = entry.content.split('\n');
  const head = lines.slice(0, RELEVANCE_HEAD_LINES).join('\n');
  const suffix = lines.length > RELEVANCE_HEAD_LINES ? `\n... (ещё ${lines.length - RELEVANCE_HEAD_LINES} строк, файл не в touches_files - показаны первые ${RELEVANCE_HEAD_LINES})` : '';
  return `--- ${relPath} (первые ${RELEVANCE_HEAD_LINES} строк) ---\n${head}${suffix}`;
}

/**
 * buildCoderContext - главная точка входа. Считает текущий ход по проекту,
 * решает snapshot/delta, применяет релевантность, обновляет context_state
 * в журнале. touchesFiles - relPath[] из задачи (§6.3 - им положен полный текст).
 */
export function buildCoderContext(journal, projectId, touchesFiles = []) {
  const touched = new Set(touchesFiles);
  const state = journal.getContextState(projectId);
  const callCount = (state.callCount ?? 0) + 1;
  const current = scanWorkspace(projectId);

  let text;
  if (callCount <= 2 || Object.keys(state.fileMap ?? {}).length === 0) {
    // Ход 1-2 (или ещё ни разу не было валидного снимка) - полный snapshot.
    if (current.size === 0) {
      text = '(workspace пуст - это первая задача проекта)';
    } else {
      const parts = [...current.keys()].sort().map((relPath) => renderEntry(relPath, current.get(relPath), touched.has(relPath)));
      text = `# Полный снимок workspace (ход ${callCount})\n\n${parts.join('\n\n')}`;
    }
  } else {
    const { added, removed, changed } = diffFileMaps(state.fileMap ?? {}, current);
    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      text = `# Дельта с прошлого хода (ход ${callCount}): изменений нет - workspace тот же, что видел прошлый вызов.`;
    } else {
      const parts = [`# Дельта с прошлого хода (ход ${callCount})`];
      if (removed.length) parts.push(`Удалены: ${removed.join(', ')}`);
      for (const relPath of added) {
        parts.push(`[ДОБАВЛЕН] ${renderEntry(relPath, current.get(relPath), touched.has(relPath))}`);
      }
      for (const relPath of changed) {
        parts.push(`[ИЗМЕНЁН] ${renderEntry(relPath, current.get(relPath), touched.has(relPath))}`);
      }
      text = parts.join('\n\n');
    }
  }

  const fileMap = {};
  for (const [relPath, entry] of current) fileMap[relPath] = entry.hash;
  journal.setContextState(projectId, { callCount, fileMap });

  return text;
}

/** snapshotWorkspace - совместимость: полный дамп без учёта ходов/relevance (используется вне coder-контура, если понадобится). */
export function snapshotWorkspace(projectId) {
  const current = scanWorkspace(projectId);
  if (current.size === 0) return '(workspace пуст)';
  return [...current.keys()].sort().map((relPath) => renderEntry(relPath, current.get(relPath), true)).join('\n\n');
}
