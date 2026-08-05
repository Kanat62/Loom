// core/history.js - .history-бэкап перед каждой правкой (§7 ТЗ, шрам 26:
// правка без возможности отката однажды похоронила проект). Копирует
// СУЩЕСТВУЮЩЕЕ содержимое файла в projects/<id>/.history/ до перезаписи.
// Git-коммиты (auto-commit, §7) - отдельный, более грубый уровень отката;
// .history даёт мгновенный локальный откат конкретного файла без похода в git.
import fs from 'node:fs';
import path from 'node:path';
import { resolveSafePath, PathLockViolation } from './pathLock.js';
import { workspaceDir } from './projects.js';

function historyDir(projectId) {
  return path.join(workspaceDir(projectId), '.history');
}

/**
 * backupFile - если файл relPath существует, копирует его текущее содержимое
 * в .history/<relPath>.<timestamp>.bak (структура каталогов сохраняется).
 * Не существует - нечего бэкапить, тихо no-op (не первая правка файла - не
 * потеря, а норма). Тоже проходит через замок пути (§15.1 ТЗ) - нарушение
 * логируется здесь же, а не только в writeFilesSafely, иначе попытка выйти
 * за пределы проекта, пойманная на этапе бэкапа, осталась бы без следа в events.
 */
export function backupFile(projectId, relPath, { logEvent, runId = null, taskId = null } = {}) {
  let target;
  try {
    target = resolveSafePath(projectId, relPath);
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
  if (!fs.existsSync(target)) return null;

  const dest = path.join(historyDir(projectId), relPath) + `.${Date.now()}.bak`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(target, dest);
  return dest;
}

/**
 * backupFilesBeforeWrite - вызывается ДО writeFilesSafely для каждого файла,
 * который Исполнитель собирается перезаписать.
 */
export function backupFilesBeforeWrite(projectId, relPaths, opts = {}) {
  return relPaths.map((relPath) => backupFile(projectId, relPath, opts)).filter(Boolean);
}
