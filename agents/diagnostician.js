// agents/diagnostician.js - Диагност (§1.7, §11 ТЗ): лестница честности.
// Отдельная роль, специально НЕ та, что писала код - свежий взгляд.
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { runSingleCheck } from '../core/checkRunner.js';
import { workspaceDir } from '../core/projects.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'diagnostician.md'), 'utf8');

function buildUserPrompt({ task, productSpec, approach, measurementResult, previousAttemptFailedAgain }) {
  const parts = [
    `# Задача, которая провалилась\n## ${task.title}\n\n${task.spec}`,
    `# Критерий приёмки\n${JSON.stringify(task.criteria)}`,
    `# Последний отчёт Проверяющего\n${task.feedback ?? '(нет)'}`,
    `# product_spec\n${productSpec?.spec_md ?? '(нет)'}`,
  ];
  if (approach) {
    parts.push(`# Approach, рассмотренный Архитектором\n${JSON.stringify(approach, null, 2)}`);
  }
  if (measurementResult) {
    parts.push(`# Результат заказанного тобой измерения\n${measurementResult}`);
  }
  if (previousAttemptFailedAgain) {
    parts.push(
      '# ВАЖНО\n`previousAttemptFailedAgain: true` - твоё предыдущее решение (уровень/подсказка) уже было применено, и задача снова провалилась. Уровни исчерпаны - обязательно заполни diagnosis_for_human.'
    );
  }
  return parts.join('\n\n---\n\n');
}

async function callDiagnostician(ctx) {
  const res = await chat(
    'diagnostician',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(ctx) },
    ],
    {
      json: true,
      projectId: ctx.task.project_id,
      taskId: ctx.task.id,
      runId: ctx.runId,
      logEvent: (e) => ctx.journal.logEvent(e),
    }
  );
  return res.data;
}

/**
 * runDiagnosticianLadder - один вызов лестницы честности (§11 ТЗ):
 * определяет уровень, при необходимости заказывает РОВНО ОДНО измерение
 * (реально исполняется через checkRunner, факт пишется в events), возвращает
 * финальное решение. previousAttemptFailedAgain=true - это ВТОРОЙ заход
 * (решение уровня уже было применено и снова не сработало) - в этом случае
 * измерение не заказывается повторно, ожидается diagnosis_for_human.
 */
export async function runDiagnosticianLadder({ task, productSpec, approach, journal, runId, previousAttemptFailedAgain = false }) {
  let diag = await callDiagnostician({ task, productSpec, approach, journal, runId, previousAttemptFailedAgain });

  if (diag.measurement_request?.cmd && !previousAttemptFailedAgain) {
    const cwd = workspaceDir(task.project_id);
    const result = await runSingleCheck({ cmd: diag.measurement_request.cmd }, { cwd });
    journal.logEvent({
      run_id: runId,
      project_id: task.project_id,
      task_id: task.id,
      type: 'diagnosis',
      agent: 'diagnostician',
      payload: {
        kind: 'measurement',
        purpose: diag.measurement_request.purpose,
        cmd: diag.measurement_request.cmd,
        report: result.report,
      },
    });
    diag = await callDiagnostician({ task, productSpec, approach, journal, runId, measurementResult: result.report, previousAttemptFailedAgain });
  }

  journal.logEvent({
    run_id: runId,
    project_id: task.project_id,
    task_id: task.id,
    type: 'diagnosis',
    agent: 'diagnostician',
    payload: { kind: 'verdict', level: diag.level, reasoning: diag.reasoning },
  });
  if (diag.level) journal.setLevel(task.id, diag.level);

  return diag;
}
