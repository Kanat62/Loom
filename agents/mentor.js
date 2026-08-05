// agents/mentor.js - Наставник (§1.9, §12 ТЗ). Единственная роль ВНЕ
// проекта - говорит про сам LOOM, а не про продукт.
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { snapshotWorkspace } from '../core/context.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'mentor.md'), 'utf8');

function buildUserPrompt({ mode, humanMessage, project, productSpec, remember }) {
  const parts = [`# Режим\n${mode === 'A' ? 'A - вмешательство во время работы' : 'B - разбор после сдачи'}`];
  if (project) {
    parts.push(`# Проект\nid=${project.id} title="${project.title}" status=${project.status}`);
    if (productSpec?.spec_md) parts.push(`# product_spec текущего проекта\n${productSpec.spec_md}`);
    parts.push(`# Снимок workspace\n${snapshotWorkspace(project.id)}`);
  } else {
    parts.push('# Проект\n(нет активного проекта - разговор общего характера про LOOM)');
  }
  parts.push(`# Сообщение тимлида\n${humanMessage}`);
  if (mode === 'A' && remember) {
    parts.push('# ВАЖНО\nЧеловек явно попросил "запомнить на будущее" - сформулируй lesson_draft, не только correction.');
  }
  return parts.join('\n\n---\n\n');
}

/**
 * runMentor - один вызов Наставника. mode: 'A' (во время) | 'B' (после сдачи).
 * Возвращает { reply, correction?, lesson_draft? }.
 */
export async function runMentor({ mode, humanMessage, project = null, productSpec = null, remember = false, journal, runId }) {
  const userPrompt = buildUserPrompt({ mode, humanMessage, project, productSpec, remember });

  const res = await chat(
    'mentor',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { json: true, projectId: project?.id ?? null, runId, logEvent: (e) => journal.logEvent(e) }
  );
  return res.data;
}

/**
 * applyCorrection - Режим A: применяет коррекцию Наставника к текущему
 * проекту. НЕ пишет в постоянную память (§12.1 ТЗ) - это правка здесь и
 * сейчас, не урок.
 */
export function applyCorrection(journal, project, correction) {
  if (!correction || correction.apply_to === 'none') return { applied: false };

  if (correction.apply_to === 'product_spec' && correction.product_spec_patch) {
    const spec = journal.getProductSpec(project.id);
    journal.saveProductSpec({
      project_id: project.id,
      spec_md: correction.product_spec_patch,
      readiness: spec?.readiness ?? [],
      engineering_defaults: spec?.engineering_defaults ?? [],
    });
    return { applied: true, target: 'product_spec' };
  }

  if (correction.apply_to === 'task' && correction.task_id && correction.task_spec_patch) {
    journal.raw
      .prepare(`UPDATE tasks SET spec = ?, status = 'pending', claimed_by = NULL WHERE id = ? AND project_id = ?`)
      .run(correction.task_spec_patch, correction.task_id, project.id);
    return { applied: true, target: 'task', taskId: correction.task_id };
  }

  return { applied: false };
}
