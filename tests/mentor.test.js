// tests/mentor.test.js - Наставник (§1.9, §12 ТЗ): коррекция применяется к
// проекту (не в память), lesson_draft требует явного подтверждения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const mentorMod = await import('../agents/mentor.js');
  return { ...journalMod, ...projectsMod, ...mentorMod };
}

test('mentor: Режим A - коррекция product_spec применяется, урок НЕ пишется в память без подтверждения', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'ok',
    fakeClaudeResult: JSON.stringify({
      reply: 'Понял, поправляю product_spec.',
      correction: { apply_to: 'product_spec', product_spec_patch: '## 1. Что это\nИсправленный текст' },
    }),
  });
  try {
    const { createJournal, createProject, runMentor, applyCorrection } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Mentor Demo', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nСтарый текст', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runMentor({ mode: 'A', humanMessage: 'ты не так понял цель', project, productSpec, journal, runId: 'r1' });
    assert.equal(result.reply, 'Понял, поправляю product_spec.');
    assert.equal(result.lesson_draft, undefined);

    const applied = applyCorrection(journal, project, result.correction);
    assert.equal(applied.applied, true);
    assert.equal(applied.target, 'product_spec');

    const updated = journal.getProductSpec(project.id);
    assert.match(updated.spec_md, /Исправленный текст/);

    // Ничего не должно было попасть в lessons - Режим A по умолчанию не пишет в память.
    assert.deepEqual(journal.listAllLessons(), []);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('mentor: Режим A с "запомни" - lesson_draft формируется, но записывается только после явного подтверждения человеком', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'ok',
    fakeClaudeResult: JSON.stringify({
      reply: 'Запомню.',
      correction: { apply_to: 'none' },
      lesson_draft: { scope: 'global', text: 'всегда проверяй npm prefix перед install', origin: 'proj-x: шрам 36' },
    }),
  });
  try {
    const { createJournal, createProject, runMentor } = await freshImports();
    const { confirmAndSaveLesson } = await import('../core/lessons.js');
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Mentor Remember', domain: 'cli' });

    const result = await runMentor({
      mode: 'A',
      humanMessage: 'и запомни на будущее: всегда проверяй npm prefix',
      project,
      remember: true,
      journal,
      runId: 'r1',
    });
    assert.ok(result.lesson_draft);

    // До подтверждения - в БД ничего нет.
    assert.deepEqual(journal.listAllLessons(), []);

    // Человек подтверждает.
    const saved = confirmAndSaveLesson(journal, result.lesson_draft);
    assert.equal(saved.saved, true);
    assert.equal(journal.listAllLessons().length, 1);
    assert.equal(journal.listAllLessons()[0].confirmed_by, 'human');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('mentor: applyCorrection(apply_to=task) переформулирует задачу и возвращает её в pending', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, applyCorrection } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Mentor Task Fix', domain: 'cli' });
    const task = journal.addTask({ project_id: project.id, title: 't', spec: 'старая формулировка', criteria: {}, role: 'coder' });
    journal.setStatus(task.id, 'blocked_needs_human', { question: 'x' });

    const applied = applyCorrection(journal, project, { apply_to: 'task', task_id: task.id, task_spec_patch: 'новая формулировка' });
    assert.equal(applied.applied, true);

    const after = journal.getTask(task.id, project.id);
    assert.equal(after.spec, 'новая формулировка');
    assert.equal(after.status, 'pending');

    journal.close();
  } finally {
    env.cleanup();
  }
});
