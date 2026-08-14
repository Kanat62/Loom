// agents/coder.js - Исполнитель (§1.4 ТЗ). Видит: одну задачу + цель проекта +
// дизайн-систему (если есть) + снимок/дельту файлов (§6) + последний отчёт
// Проверяющего. НЕ видит весь план - защита от goal drift (§15).
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { buildCoderContext } from '../core/context.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'coder.md'), 'utf8');

function buildUserPrompt({ task, productSpec, designSystem, journal }) {
  const parts = [
    `# Цель проекта (product_spec)\n${productSpec?.spec_md ?? '(нет product_spec - изолированный запуск фазы 1)'}`,
  ];
  if (designSystem) {
    parts.push(`# Дизайн-система (используй ТОЛЬКО эти токены)\n${designSystem}`);
  }
  parts.push(`# Задача\n## ${task.title}\n\n${task.spec}`);
  parts.push(`# Затрагиваемые файлы\n${JSON.stringify(task.touches_files)}`);
  if (task.feedback) {
    parts.push(`# Последний отчёт Проверяющего (почини именно это)\n${task.feedback}`);
  }
  parts.push(buildCoderContext(journal, task.project_id, task.touches_files));
  return parts.join('\n\n---\n\n');
}

/**
 * runCoder - один вызов Исполнителя. Возвращает { files } | { question }.
 * minTierIndex - эскалация тира по лестнице попыток (§7 ТЗ), решает coordinator.
 */
export async function runCoder({ task, productSpec, designSystem, journal, runId, minTierIndex = 0 }) {
  const userPrompt = buildUserPrompt({ task, productSpec, designSystem, journal });

  const res = await chat(
    'coder',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    {
      json: true,
      projectId: task.project_id,
      taskId: task.id,
      runId,
      minTierIndex,
      logEvent: (e) => journal.logEvent(e),
    }
  );

  return res.data;
}
