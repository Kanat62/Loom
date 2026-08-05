// core/pathLock.js - замок пути (§15.1 ТЗ). Запись только внутри
// projects/<id>/. Попытка выйти (../) блокируется и ЛОГИРУЕТСЯ в events.
// Файлы пишет harness, не модель (Исполнитель возвращает JSON, harness
// валидирует пути и пишет).
import fs from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './projects.js';

export class PathLockViolation extends Error {
  constructor(message, { relPath, resolved } = {}) {
    super(message);
    this.name = 'PathLockViolation';
    this.relPath = relPath;
    this.resolved = resolved;
  }
}

/**
 * resolveSafePath - разрешает относительный путь ВНУТРИ песочницы проекта.
 * Бросает PathLockViolation при попытке выйти за пределы workspaceDir.
 */
export function resolveSafePath(projectId, relPath) {
  const base = path.resolve(workspaceDir(projectId));
  const target = path.resolve(base, relPath);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(baseWithSep)) {
    throw new PathLockViolation(`попытка записи вне песочницы проекта: "${relPath}" -> "${target}"`, {
      relPath,
      resolved: target,
    });
  }
  return target;
}

/**
 * writeFilesSafely - записывает { relPath: content } под projects/<id>/.
 * Два прохода: сперва разрешаем ВСЕ пути (чтобы одна нарушенная запись не
 * привела к частичной записи остальных), затем пишем. Нарушение логируется
 * через переданный logEvent (обычно journal.logEvent) и пробрасывается выше -
 * решение, что делать с задачей (провал/blocked), принимает coordinator.
 */
export function writeFilesSafely(projectId, files, { logEvent, runId = null, taskId = null } = {}) {
  const resolved = [];
  for (const relPath of Object.keys(files)) {
    try {
      resolved.push([resolveSafePath(projectId, relPath), relPath]);
    } catch (err) {
      if (err instanceof PathLockViolation) {
        logEvent?.({
          run_id: runId,
          project_id: projectId,
          task_id: taskId,
          type: 'status',
          agent: 'harness',
          payload: { kind: 'path_lock_violation', relPath: err.relPath, resolved: err.resolved },
        });
      }
      throw err;
    }
  }

  const written = [];
  for (const [targetPath, relPath] of resolved) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, files[relPath], 'utf8');
    written.push(relPath);
  }
  return written;
}
