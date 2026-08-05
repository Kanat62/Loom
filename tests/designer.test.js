// tests/designer.test.js - Дизайнер (§1.2 ТЗ): choose_direction/ready,
// сохранение дизайн-системы, always-full доставка Исполнителю.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const designerMod = await import('../agents/designer.js');
  return { ...journalMod, ...projectsMod, ...designerMod };
}

test('designer: без референса -> status=choose_direction с 2-3 вариантами', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'ok',
    fakeClaudeResult: JSON.stringify({
      status: 'choose_direction',
      options: [
        { name: 'Кинематографичное тёмное', description: 'глубокие тени, контраст' },
        { name: 'Чистый минимализм', description: 'много воздуха, один акцент' },
      ],
    }),
  });
  try {
    const { createJournal, createProject, runDesigner } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'UI Demo', domain: 'ui' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nСайт без референса', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runDesigner({ project, productSpec, journal, runId: 'r1' });
    assert.equal(result.status, 'choose_direction');
    assert.equal(result.options.length, 2);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('designer: с выбранным направлением -> status=ready, tokens_css + rules сохраняются на диск', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'ok',
    fakeClaudeResult: JSON.stringify({
      status: 'ready',
      direction: 'Чистый минимализм - много воздуха, один акцент',
      tokens_css: ':root { --surface: oklch(98% 0 0); --accent: oklch(60% 0.15 250); }',
      rules: ['используй только токены', 'один акцентный цвет'],
      reference_note: 'выбор человека из предложенных вариантов',
    }),
  });
  try {
    const { createJournal, createProject, runDesigner, saveDesignSystem, loadDesignSystem } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'UI Demo Ready', domain: 'ui' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nСайт', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runDesigner({ project, productSpec, journal, runId: 'r1', chosenDirection: 'Чистый минимализм' });
    assert.equal(result.status, 'ready');

    saveDesignSystem(project.id, result);
    const tokensPath = path.join(project.workspace_dir, 'design', 'tokens.css');
    const designMdPath = path.join(project.workspace_dir, 'design', 'DESIGN.md');
    assert.ok(fs.existsSync(tokensPath));
    assert.ok(fs.existsSync(designMdPath));
    assert.match(fs.readFileSync(tokensPath, 'utf8'), /--accent: oklch/);

    const forCoder = loadDesignSystem(project.id);
    assert.match(forCoder, /Чистый минимализм/);
    assert.match(forCoder, /--accent: oklch/, 'Исполнитель должен получить дизайн-систему ВСЕГДА полностью, включая tokens.css');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('designer: loadDesignSystem возвращает null, если дизайн ещё не создавался', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, loadDesignSystem } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'No Design Yet', domain: 'cli' });
    assert.equal(loadDesignSystem(project.id), null);
    journal.close();
  } finally {
    env.cleanup();
  }
});
