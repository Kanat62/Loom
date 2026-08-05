// tests/journal.test.js - Фаза 0 DoD: создание проекта/задачи, гонка захвата,
// releaseStuck. Использует LOOM_HOME для изоляции состояния теста (§13 harness).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournal } from '../core/journal.js';

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-journal-test-'));
  return path.join(dir, 'journal.db');
}

test('createProject + addTask works end to end', async () => {
  const journal = await createJournal(tmpDbPath());
  const project = journal.createProject({
    id: 'demo-abc123',
    title: 'Demo project',
    workspace_dir: '/tmp/demo-abc123',
    domain: 'cli',
  });
  assert.equal(project.status, 'active');

  const task = journal.addTask({
    project_id: project.id,
    title: 'export sum',
    spec: 'sum.ts экспортирует sum(a,b)',
    criteria: { cmd: 'node -e "1"', expect: 0 },
    role: 'coder',
    type: 'build',
    touches_files: ['sum.ts'],
    covers: ['sum works'],
  });
  assert.equal(task.status, 'pending');
  assert.equal(task.project_id, project.id);

  const claimed = journal.claimNext('coder', project.id);
  assert.equal(claimed.id, task.id);
  assert.equal(claimed.status, 'claimed');

  journal.close();
});

test('claimNext never hands out the same task twice under concurrent race', async () => {
  const dbPath = tmpDbPath();
  const journal = await createJournal(dbPath);
  const project = journal.createProject({
    id: 'race-abc123',
    title: 'Race project',
    workspace_dir: '/tmp/race-abc123',
    domain: 'cli',
  });
  const task = journal.addTask({
    project_id: project.id,
    title: 'only one winner',
    spec: 'test',
    criteria: { cmd: 'true' },
    role: 'coder',
  });

  // Симулируем два "параллельных процесса", открывая второе соединение с той же БД.
  const journal2 = await createJournal(dbPath);

  const results = await Promise.all([
    Promise.resolve().then(() => journal.claimNext('coder', project.id)),
    Promise.resolve().then(() => journal2.claimNext('coder', project.id)),
  ]);

  const winners = results.filter((r) => r && r.id === task.id);
  assert.equal(winners.length, 1, 'exactly one caller must win the claim');

  journal.close();
  journal2.close();
});

test('releaseStuck returns claimed tasks to pending', async () => {
  const journal = await createJournal(tmpDbPath());
  const project = journal.createProject({
    id: 'stuck-abc123',
    title: 'Stuck project',
    workspace_dir: '/tmp/stuck-abc123',
    domain: 'cli',
  });
  const task = journal.addTask({
    project_id: project.id,
    title: 't',
    spec: 's',
    criteria: {},
    role: 'coder',
  });
  journal.claimNext('coder', project.id);
  assert.equal(journal.getTask(task.id, project.id).status, 'claimed');

  const changed = journal.releaseStuck();
  assert.equal(changed, 1);
  const after = journal.getTask(task.id, project.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.claimed_by, null);

  journal.close();
});

test('task_deps blocks claimNext until dependency is done', async () => {
  const journal = await createJournal(tmpDbPath());
  const project = journal.createProject({
    id: 'deps-abc123',
    title: 'Deps project',
    workspace_dir: '/tmp/deps-abc123',
    domain: 'cli',
  });
  const first = journal.addTask({
    project_id: project.id,
    title: 'first',
    spec: 's',
    criteria: {},
    role: 'coder',
  });
  const second = journal.addTask({
    project_id: project.id,
    title: 'second',
    spec: 's',
    criteria: {},
    role: 'coder',
    deps: [first.id],
  });

  // Only "first" should be claimable while it isn't done yet.
  const claim1 = journal.claimNext('coder', project.id);
  assert.equal(claim1.id, first.id);
  const claim2 = journal.claimNext('coder', project.id);
  assert.equal(claim2, null, 'second must stay blocked until first is done');

  journal.setStatus(first.id, 'done');
  const claim3 = journal.claimNext('coder', project.id);
  assert.equal(claim3.id, second.id);

  journal.close();
});

test('feedback is UPDATE, not concatenation (§6.5 ТЗ) - только последний отчёт', async () => {
  const journal = await createJournal(tmpDbPath());
  const project = journal.createProject({
    id: 'feedback-abc123',
    title: 'Feedback project',
    workspace_dir: '/tmp/feedback-abc123',
    domain: 'cli',
  });
  const task = journal.addTask({
    project_id: project.id,
    title: 't',
    spec: 's',
    criteria: {},
    role: 'coder',
  });

  journal.setStatus(task.id, 'failed', { feedback: 'FAIL: attempt 1 - value=1 expected=2' });
  journal.setStatus(task.id, 'failed', { feedback: 'FAIL: attempt 2 - value=3 expected=2' });

  const after = journal.getTask(task.id, project.id);
  assert.equal(after.feedback, 'FAIL: attempt 2 - value=3 expected=2');
  assert.doesNotMatch(after.feedback, /attempt 1/, 'старый отчёт не должен накапливаться');

  journal.close();
});
