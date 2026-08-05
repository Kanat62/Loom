// agents/checker.js - Проверяющий (§1.5 ТЗ). Контур 1, БЕЗ LLM, детерминированный
// код, отдельный чистый процесс на команду. Его нельзя уговорить.
import { runCriterion } from '../core/checkRunner.js';
import { workspaceDir } from '../core/projects.js';

export async function runChecker({ task, journal, runId }) {
  const cwd = workspaceDir(task.project_id);
  const result = await runCriterion(task.criteria, { cwd, journal, projectId: task.project_id });

  journal.logEvent({
    run_id: runId,
    project_id: task.project_id,
    task_id: task.id,
    type: 'test_result',
    agent: 'checker',
    duration_ms: result.durationMs,
    payload: { pass: result.pass, report: result.report, timedOut: result.timedOut },
  });

  return result;
}
