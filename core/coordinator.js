// core/coordinator.js - Координатор (§2 ТЗ): детерминированный код БЕЗ LLM.
// Только процесс: захват -> исполнение роли -> вердикт -> следующий шаг.
// Ни одного вызова модели здесь напрямую - вызовы идут через agents/*.js,
// которые сами обращаются к шлюзу.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { runCoder } from '../agents/coder.js';
import { runChecker } from '../agents/checker.js';
import { runDiagnosticianLadder } from '../agents/diagnostician.js';
import { runCheckpoint, applyCheckpointActions } from '../agents/engineer.js';
import { writeFilesSafely, PathLockViolation } from './pathLock.js';
import { backupFilesBeforeWrite } from './history.js';
import { workspaceDir } from './projects.js';
import { checkTokenConnectivity } from './tokenCheck.js';
import { MAX_ATTEMPTS, SPIKE_MAX_ATTEMPTS, CHECKPOINT_EVERY_N_DONE } from './config.js';

/**
 * gitCommit - auto-commit safety net (§7 ТЗ, шрам 4). В headless-архитектуре
 * v5 Исполнитель НЕ имеет инструментов вообще (--tools= в шлюзе) - он не может
 * закоммитить сам ни при каких обстоятельствах. Поэтому коммит после КАЖДОЙ
 * записи файлов делает harness безусловно, а не "если Исполнитель забыл".
 * cwd жёстко = каталог проекта (gitGuard, §15.1.4) - никогда ROOT LOOM.
 */
function gitCommit(projectId, message) {
  const dir = workspaceDir(projectId);
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString();
    if (!status.trim()) return null; // нечего коммитить (напр. проверка ничего не изменила)
    execFileSync(
      'git',
      ['-c', 'user.email=loom@local', '-c', 'user.name=LOOM', 'commit', '-m', message],
      { cwd: dir, stdio: 'ignore' }
    );
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
  } catch {
    return null; // git-сбой не должен валить прогон - это safety net, не критичный путь
  }
}

/**
 * tierIndexForAttempt - §7 ТЗ, лестница попыток: 1-2 - обычный тир,
 * 3+ - эскалация на модель сильнее (следующий индекс в ROLES[role]).
 */
function tierIndexForAttempt(attemptNumber) {
  return attemptNumber >= 3 ? 1 : 0;
}

/**
 * maxAttemptsForTask - §3.3 ТЗ v5.2: разведка (spike) получает МЕНЬШЕ попыток
 * (3, не 4) - неуложившаяся разведка уже сама по себе результат (числа
 * получены, теория не подтвердилась быстро), упорствовать до общего
 * MAX_ATTEMPTS бессмысленно.
 */
function maxAttemptsForTask(task) {
  return task.type === 'spike' ? SPIKE_MAX_ATTEMPTS : MAX_ATTEMPTS;
}

/**
 * processRegressionTask - §8.10 ТЗ: регрессия - ТОЛЬКО повторный прогон уже
 * существующих критериев, никакого кода не пишется. Coder не вызывается
 * вовсе; провал не уходит в лестницу попыток (нечего чинить кодом - что-то
 * из УЖЕ СДЕЛАННОГО перестало работать, это решение тимлида, не ретрай).
 */
async function processRegressionTask({ journal, task, runId }) {
  const checkResult = await runChecker({ task, journal, runId });
  if (checkResult.pass) {
    journal.setStatus(task.id, 'done', { feedback: checkResult.report });
    return { verdict: 'done', report: checkResult.report };
  }
  journal.setStatus(task.id, 'blocked_needs_human', {
    feedback: checkResult.report,
    question: `Регрессия провалилась: ранее сделанная задача перестала проходить свой критерий.\n${checkResult.report}`,
  });
  return { verdict: 'blocked_needs_human', report: checkResult.report };
}

export async function processTask({ journal, task, productSpec = null, designSystem = null, runId = crypto.randomUUID() }) {
  if (task.criteria?.regression_of) {
    return processRegressionTask({ journal, task, runId });
  }

  const attemptNumber = task.attempts + 1;
  journal.incrementAttempts(task.id);

  let coderResult;
  try {
    coderResult = await runCoder({
      task,
      productSpec,
      designSystem,
      journal,
      runId,
      minTierIndex: tierIndexForAttempt(attemptNumber),
    });
  } catch (err) {
    return requeueOrBlock(journal, task, attemptNumber, `FAIL: шлюз моделей недоступен для coder: ${err.message}`, { productSpec, runId });
  }

  if (!coderResult || typeof coderResult !== 'object') {
    return requeueOrBlock(journal, task, attemptNumber, 'FAIL: Исполнитель не вернул корректный JSON-объект', { productSpec, runId });
  }

  if (typeof coderResult.question === 'string' && coderResult.question.trim()) {
    // §1.4 ТЗ: question - исключение, уходит в blocked_needs_human напрямую, не в лестницу попыток.
    journal.setStatus(task.id, 'blocked_needs_human', { question: coderResult.question, feedback: task.feedback });
    return { verdict: 'question', question: coderResult.question };
  }

  const files = coderResult.files;
  if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
    return requeueOrBlock(journal, task, attemptNumber, 'FAIL: Исполнитель вернул пустой набор files', { productSpec, runId });
  }

  try {
    const logEvent = (e) => journal.logEvent(e);
    backupFilesBeforeWrite(task.project_id, Object.keys(files), { logEvent, runId, taskId: task.id });
    writeFilesSafely(task.project_id, files, { logEvent, runId, taskId: task.id });
  } catch (err) {
    if (err instanceof PathLockViolation) {
      return requeueOrBlock(journal, task, attemptNumber, `FAIL: попытка записи вне песочницы проекта - ${err.message}`, { productSpec, runId });
    }
    throw err;
  }

  gitCommit(task.project_id, `coder: ${task.title} (попытка ${attemptNumber})`);

  const checkResult = await runChecker({ task, journal, runId });
  gitCommit(task.project_id, `checker: ${task.title} - ${checkResult.pass ? 'pass' : 'fail'}`);

  if (checkResult.pass) {
    journal.setStatus(task.id, 'done', { feedback: checkResult.report });
    return { verdict: 'done', report: checkResult.report };
  }

  return requeueOrBlock(journal, task, attemptNumber, checkResult.report, { productSpec, runId });
}

function formatDiagnosisForHuman(d = {}, fallbackLevel) {
  return [
    `Упёрся: ${d.stuck_on ?? '(не указано)'}`,
    `Проверено фактами: ${d.measured_facts ?? '(не указано)'}`,
    `Уровень: ${d.level_exhausted ?? fallbackLevel} - исчерпан`,
    `Граница: ${d.boundary ?? '(не указано)'}`,
    `Вижу обходной путь: ${d.workaround ?? '(не указано)'}`,
    `Частичный результат: ${d.partial_result ?? '(не указано)'}`,
  ].join('\n');
}

/**
 * requeueOrBlock - §7 ТЗ: MAX_ATTEMPTS=4 на уровень. Исчерпаны -> Диагност
 * (§1.7, §11 ТЗ) решает, менять ли уровень (code/approach/understanding) или
 * отдавать диагноз человеку. Ровно ОДИН цикл смены уровня на задачу (шрам 17:
 * "упорные" попытки не должны становиться бесконечными) - сигнал "уже
 * консультировались с Диагностом" читается из состояния задачи, отдельного
 * счётчика не заводим:
 *   - code: attempts НЕ сбрасываются -> вторая эксхаустия (attemptNumber >
 *     MAX_ATTEMPTS) однозначно значит "подсказка Диагноста не помогла";
 *   - approach/understanding: attempts сбрасываются в 0, но task.level
 *     перестаёт быть 'code' -> вторая эксхаустия однозначно опознаётся по level.
 */
async function requeueOrBlock(journal, task, attemptNumber, report, { productSpec = null, runId } = {}) {
  journal.setStatus(task.id, 'failed', { feedback: report });
  const maxAttempts = maxAttemptsForTask(task);

  if (attemptNumber < maxAttempts) {
    journal.requeueTask(task.id);
    return { verdict: 'retry', report };
  }

  const alreadyDiagnosed = attemptNumber > maxAttempts || (task.level && task.level !== 'code');
  const approach = journal.getApproach(task.project_id);
  const freshTask = journal.getTask(task.id, task.project_id);

  const diag = await runDiagnosticianLadder({
    task: freshTask,
    productSpec,
    approach,
    journal,
    runId,
    previousAttemptFailedAgain: alreadyDiagnosed,
  });

  if (alreadyDiagnosed || !diag.level) {
    const question = formatDiagnosisForHuman(diag.diagnosis_for_human, freshTask.level ?? 'code');
    journal.setStatus(task.id, 'blocked_needs_human', { feedback: report, question });
    return { verdict: 'blocked_needs_human', report, diagnosis: question };
  }

  if (diag.level === 'code') {
    journal.setLevel(task.id, 'code');
    journal.setStatus(task.id, 'failed', { feedback: `${report}\n\n[Диагност] ${diag.code_hint ?? diag.reasoning ?? ''}` });
    journal.requeueTask(task.id); // attempts НЕ сбрасываются - следующая попытка уже за порогом MAX_ATTEMPTS
    return { verdict: 'retry', report };
  }

  if (diag.level === 'approach' && diag.approach_alternative) {
    journal.setLevel(task.id, 'approach');
    const newSpec = `${task.spec}\n\n[Диагност: смена подхода] Перепроектировано на вариант "${diag.approach_alternative}". ${diag.reasoning ?? ''}`;
    journal.raw.prepare(`UPDATE tasks SET spec = ?, attempts = 0, status = 'pending', claimed_by = NULL WHERE id = ?`).run(newSpec, task.id);
    return { verdict: 'retry', report };
  }

  if (diag.level === 'understanding' && diag.understanding_correction) {
    journal.setLevel(task.id, 'understanding');
    journal.raw
      .prepare(`UPDATE tasks SET spec = ?, attempts = 0, status = 'pending', claimed_by = NULL WHERE id = ?`)
      .run(diag.understanding_correction, task.id);
    return { verdict: 'retry', report };
  }

  journal.setStatus(task.id, 'blocked_needs_human', {
    feedback: report,
    question: `Диагност не смог определить применимое решение уровня. reasoning: ${diag.reasoning ?? '(нет)'}`,
  });
  return { verdict: 'blocked_needs_human', report };
}

/**
 * runLoop - releaseStuck() при КАЖДОМ входе (§4.3 ТЗ, шрам 25), затем
 * claimNext -> processTask до опустошения доски роли в проекте.
 */
export async function runLoop({ journal, projectId, role = 'coder', productSpec = null, designSystem = null, maxIterations = 1000 }) {
  const released = journal.releaseStuck();
  const runId = crypto.randomUUID();
  const results = [];
  for (let i = 0; i < maxIterations; i++) {
    const task = journal.claimNext(role, projectId);
    if (!task) break;
    const result = await processTask({ journal, task, productSpec, designSystem, runId });
    results.push({ taskId: task.id, title: task.title, ...result });
  }
  return { released, runId, results };
}

/**
 * runLoopWithCheckpoints - §3.2 ТЗ v5.2: как runLoop, но между задачами
 * периодически вызывает Инженера на сверку целого (checkpoint) - после каждой
 * CHECKPOINT_EVERY_N_DONE закрытой задачи, ОБЯЗАТЕЛЬНО после любой закрытой
 * core_check-задачи, ОБЯЗАТЕЛЬНО после blocked_needs_human. on_track:false
 * останавливает конвейер и применяет actions ДО продолжения (шрам 45 -
 * раньше на целое не смотрел никто между началом и концом дерева).
 */
export async function runLoopWithCheckpoints({ journal, project, productSpec, designSystem = null, runId = crypto.randomUUID(), maxIterations = 1000 }) {
  const released = journal.releaseStuck();
  const results = [];
  let doneSinceCheckpoint = 0;
  let stopped = false;
  let stopReason = null;

  for (let i = 0; i < maxIterations; i++) {
    const task = journal.claimNext('coder', project.id);
    if (!task) break;
    const result = await processTask({ journal, task, productSpec, designSystem, runId });
    results.push({ taskId: task.id, title: task.title, ...result });

    let needsCheckpoint = false;
    if (result.verdict === 'blocked_needs_human') {
      needsCheckpoint = true;
    } else if (result.verdict === 'done') {
      doneSinceCheckpoint++;
      if (task.core_check) needsCheckpoint = true;
      if (doneSinceCheckpoint >= CHECKPOINT_EVERY_N_DONE) {
        needsCheckpoint = true;
        doneSinceCheckpoint = 0;
      }
    }

    if (needsCheckpoint) {
      const checkpoint = await runCheckpoint({ project, productSpec, journal, runId });
      const applied = applyCheckpointActions(journal, project, checkpoint.actions);
      results.push({ checkpoint: true, on_track: checkpoint.on_track ?? null, drift: checkpoint.drift ?? null, applied });

      if (checkpoint.on_track === false) {
        stopped = true;
        stopReason = checkpoint.stop_reason ?? 'checkpoint: on_track=false';
        break;
      }
    }
  }

  return { released, runId, results, stopped, stopReason };
}

/**
 * uncoveredCoreItems - §8 правило 13 ТЗ v5.2 (шрам 45): core-признак закрыт
 * ТОЛЬКО done-задачей с core_check=true, покрывающей его дословно - обычный
 * купочный критерий core-признак не закрывает, даже если формально стоит в
 * covers.
 */
function uncoveredCoreItems(productSpec, tasks) {
  const readiness = productSpec?.readiness ?? [];
  const coreTexts = readiness
    .filter((r) => typeof r !== 'string' && r?.tier === 'core')
    .map((r) => r.text);
  if (coreTexts.length === 0) return [];
  const confirmedByCheck = new Set(tasks.filter((t) => t.status === 'done' && t.core_check).flatMap((t) => t.covers ?? []));
  return coreTexts.filter((text) => !confirmedByCheck.has(text));
}

/**
 * canDeliver - §4.2/§5/§6.3 ТЗ v5.2: харнесс, не слова отчёта, решает, можно
 * ли выдать статус delivered. Блокирует: неподтверждённый core-признак
 * (правило 13, шрам 45), задачи blocked_needs_human, visual:false Пилота при
 * domain='ui' (шрам 42), нарушенная связность токенов дизайн-системы
 * (правило 12, шрам 40/41).
 */
export function canDeliver({ project, productSpec, tasks, pilotResult = null }) {
  const reasons = [];

  const uncoveredCore = uncoveredCoreItems(productSpec, tasks);
  if (uncoveredCore.length > 0) {
    reasons.push(`core-признаки без подтверждённого core_check критерия: ${uncoveredCore.join('; ')}`);
  }

  if (tasks.some((t) => t.status === 'blocked_needs_human')) {
    reasons.push('есть задачи blocked_needs_human');
  }

  if (project.domain === 'ui') {
    if (pilotResult && !pilotResult.visual) {
      reasons.push('Пилот вернул visual:false для UI-продукта - второй контур не пройден (§5 ТЗ v5.2)');
    }
    const tokenResult = checkTokenConnectivity(workspaceDir(project.id));
    if (!tokenResult.pass) {
      reasons.push(`связность токенов дизайн-системы нарушена: ${tokenResult.report}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
