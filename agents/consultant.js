// agents/consultant.js - Консультант (§1.8, §17 ТЗ): сдача. Формирует отчёт
// из product_spec, доски задач, approach Архитектора, отчётов обоих контуров.
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { formatSpendReport } from '../core/stats.js';
import { workspaceDir } from '../core/projects.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'consultant.md'), 'utf8');

function buildUserPrompt({ productSpec, tasks, approach, pilotEvents }) {
  const parts = [`# product_spec\n${productSpec?.spec_md ?? '(нет)'}`];
  if (approach) {
    parts.push(`# Approach Архитектора (варианты, выбор, обоснование)\n${JSON.stringify(approach, null, 2)}`);
  }
  const tasksText = tasks
    .map((t) => {
      const line = `- [${t.status}] (${t.type}) ${t.title} - covers: ${JSON.stringify(t.covers)}`;
      return t.question ? `${line}\n  диагноз/вопрос: ${t.question}` : line;
    })
    .join('\n');
  parts.push(`# Дерево задач\n${tasksText}`);
  if (pilotEvents.length) {
    const pilotText = pilotEvents.map((e) => JSON.stringify(JSON.parse(e.payload ?? '{}'))).join('\n');
    parts.push(`# Отчёт Пилота (контур 2)\n${pilotText}`);
  } else {
    parts.push('# Отчёт Пилота (контур 2)\nПилот не запускался (доска не была полностью зелёной на момент сдачи).');
  }
  return parts.join('\n\n---\n\n');
}

/**
 * runConsultant - формирует полный отчёт (7 пунктов от LLM + пункт 8 "Расход"
 * от harness, чистый SQL, §17.1 ТЗ). Пишет REPORT.md в корень проекта -
 * часть поставки.
 */
export async function runConsultant({ project, productSpec, journal, runId }) {
  const tasks = journal.listTasks(project.id);
  const approach = journal.getApproach(project.id);
  const pilotEvents = journal.listEvents(project.id).filter((e) => e.type === 'pilot');

  const res = await chat(
    'consultant',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ productSpec, tasks, approach, pilotEvents }) },
    ],
    { json: false, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );

  const spendReport = formatSpendReport(journal, project.id);
  const report = `${res.text.trim()}\n\n8. Расход\n${spendReport}\n`;

  fs.writeFileSync(path.join(workspaceDir(project.id), 'REPORT.md'), report, 'utf8');

  return report;
}
