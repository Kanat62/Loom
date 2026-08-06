// tests/projects.test.js - §13 ТЗ: мультипроектность. Изоляция двух проектов -
// project_id обязательный фильтр в КАЖДОЙ точке чтения журнала (шрам 35, 38).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  return { ...journalMod, ...projectsMod };
}

test('projects: два проекта - изолированные workspace_dir, изолированный git', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject } = await freshImports();
    const journal = await createJournal();

    const a = createProject(journal, { title: 'Project A', domain: 'cli' });
    const b = createProject(journal, { title: 'Project B', domain: 'cli' });

    assert.notEqual(a.id, b.id);
    assert.notEqual(a.workspace_dir, b.workspace_dir);
    assert.ok(fs.existsSync(path.join(a.workspace_dir, '.git')));
    assert.ok(fs.existsSync(path.join(b.workspace_dir, '.git')));

    fs.writeFileSync(path.join(a.workspace_dir, 'only-in-a.txt'), 'x');
    assert.equal(fs.existsSync(path.join(b.workspace_dir, 'only-in-a.txt')), false);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('projects: listTasks и claimNext строго фильтруются по project_id - задачи не текут между проектами', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject } = await freshImports();
    const journal = await createJournal();

    const a = createProject(journal, { title: 'Isolation A', domain: 'cli' });
    const b = createProject(journal, { title: 'Isolation B', domain: 'cli' });

    const taskA = journal.addTask({ project_id: a.id, title: 'task in A', spec: 's', criteria: {}, role: 'coder' });
    const taskB = journal.addTask({ project_id: b.id, title: 'task in B', spec: 's', criteria: {}, role: 'coder' });

    const listA = journal.listTasks(a.id);
    const listB = journal.listTasks(b.id);
    assert.equal(listA.length, 1);
    assert.equal(listA[0].id, taskA.id);
    assert.equal(listB.length, 1);
    assert.equal(listB[0].id, taskB.id);

    // claimNext(role, projectId) не должен выдать задачу другого проекта.
    const claimedFromA = journal.claimNext('coder', a.id);
    assert.equal(claimedFromA.id, taskA.id);
    const claimedFromAAgain = journal.claimNext('coder', a.id);
    assert.equal(claimedFromAAgain, null, 'вторая задача проекта A не должна найтись - её и не было, task B не должна утечь');

    const claimedFromB = journal.claimNext('coder', b.id);
    assert.equal(claimedFromB.id, taskB.id);

    // getTask(id, project_id) с ЧУЖИМ project_id не должен отдать задачу.
    assert.equal(journal.getTask(taskA.id, b.id), null);
    assert.equal(journal.getTask(taskB.id, a.id), null);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('projects: события (events) фильтруются по project_id', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject } = await freshImports();
    const journal = await createJournal();

    const a = createProject(journal, { title: 'Events A', domain: 'cli' });
    const b = createProject(journal, { title: 'Events B', domain: 'cli' });

    journal.logEvent({ project_id: a.id, type: 'usage', agent: 'coder', cost_usd: 0.01 });
    journal.logEvent({ project_id: b.id, type: 'usage', agent: 'coder', cost_usd: 0.02 });
    journal.logEvent({ project_id: b.id, type: 'usage', agent: 'coder', cost_usd: 0.03 });

    assert.equal(journal.listEvents(a.id).length, 1);
    assert.equal(journal.listEvents(b.id).length, 2);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('projects: "default" запрещён как project_id (§13 ТЗ) - getProject возвращает null', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, getProject } = await freshImports();
    const journal = await createJournal();
    assert.equal(getProject(journal, 'default'), null);
    assert.equal(getProject(journal, ''), null);
    assert.equal(getProject(journal, null), null);
    journal.close();
  } finally {
    env.cleanup();
  }
});

test('projects: context_state (§6 ТЗ) не путается между проектами', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject } = await freshImports();
    const { buildCoderContext } = await import('../core/context.js');
    const journal = await createJournal();

    const a = createProject(journal, { title: 'Context A', domain: 'cli' });
    const b = createProject(journal, { title: 'Context B', domain: 'cli' });

    fs.writeFileSync(path.join(a.workspace_dir, 'a-only.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(b.workspace_dir, 'b-only.js'), 'module.exports = 2;');

    const ctxA = buildCoderContext(journal, a.id, []);
    const ctxB = buildCoderContext(journal, b.id, []);

    assert.match(ctxA, /a-only\.js/);
    assert.doesNotMatch(ctxA, /b-only\.js/);
    assert.match(ctxB, /b-only\.js/);
    assert.doesNotMatch(ctxB, /a-only\.js/);

    journal.close();
  } finally {
    env.cleanup();
  }
});
