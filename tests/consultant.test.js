// tests/consultant.test.js - Консультант (§1.8, §17 ТЗ): 7 пунктов от LLM +
// пункт 8 (Расход) от harness, REPORT.md пишется в проект.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestEnv } from './harness/env.js';

const SAMPLE_REPORT = `1. Задача
Сделать одностраничник.

2. Решения
Статичный HTML без фреймворков - проще и быстрее для одной страницы.

3. Что сделано
Закрыто 2 из 2 признаков готовности.

4. Как проверено
Контур 1: 2/2 критерия пройдено. Контур 2: Пилот прошёл сценарий, находок нет.

5. Что хромает
Ничего существенного.

6. Что требует тебя
Ничего.

7. Следующий шаг
Добавить аналитику, если понадобится.`;

test('consultant: собирает отчёт из 7 пунктов LLM + пункт 8 от harness, пишет REPORT.md', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: SAMPLE_REPORT });
  try {
    const { createJournal } = await import('../core/journal.js');
    const { createProject } = await import('../core/projects.js');
    const { runConsultant } = await import('../agents/consultant.js');

    const journal = await createJournal();
    const project = createProject(journal, { title: 'Consultant Demo', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: ['a', 'b'] });
    const productSpec = journal.getProductSpec(project.id);

    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'coder', tokens_in: 10, tokens_out: 5, cache_read: 0, cost_usd: 0.01, duration_ms: 500 });

    const report = await runConsultant({ project, productSpec, journal, runId: 'r1' });

    assert.match(report, /1\. Задача/);
    assert.match(report, /8\. Расход/);
    assert.match(report, /ИТОГО/);

    const reportPath = path.join(project.workspace_dir, 'REPORT.md');
    assert.ok(fs.existsSync(reportPath));
    assert.equal(fs.readFileSync(reportPath, 'utf8'), report);

    journal.close();
  } finally {
    env.cleanup();
  }
});
