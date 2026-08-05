// tests/coordinator.test.js - лестница попыток, замок пути, auto-commit (§13 гайда).
// Координатор сам без LLM - но здесь он реально дергает agents/coder.js
// (через шлюз -> подставной claude) и agents/checker.js (реальный checkRunner,
// реальный git). Единственное, что подделано - ответ модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  // Импортируем ПОСЛЕ того, как LOOM_HOME/PATH уже выставлены в setupTestEnv,
  // чтобы избежать путаницы - хотя после фикса config.js это уже не обязательно
  // (пути читаются лениво), явный порядок делает тест понятнее.
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const coordinatorMod = await import('../core/coordinator.js');
  return { ...journalMod, ...projectsMod, ...coordinatorMod };
}

function passingCriterion() {
  return { cmd: 'node -e "if(!require(\'fs\').existsSync(\'a.js\')){console.error(\'FAIL: a.js missing\');process.exit(1)}"' };
}

test('coordinator: happy path - coder пишет файл, checker проходит, git коммитит', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }) });
  try {
    const { createJournal, createProject, runLoop } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coordinator Happy', domain: 'cli' });
    const task = journal.addTask({
      project_id: project.id,
      title: 'write a.js',
      spec: 'создай a.js',
      criteria: passingCriterion(),
      role: 'coder',
    });

    const { results } = await runLoop({ journal, projectId: project.id, role: 'coder' });
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'done');

    const after = journal.getTask(task.id, project.id);
    assert.equal(after.status, 'done');
    assert.equal(after.attempts, 1);
    assert.equal(fs.existsSync(path.join(project.workspace_dir, 'a.js')), true);

    const log = execFileSync('git', ['log', '--oneline'], { cwd: project.workspace_dir }).toString();
    assert.match(log, /coder: write a\.js/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('coordinator: провал дважды, затем успех на попытке 3 -> эскалация тира на opus', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [
    JSON.stringify({ files: { 'wrong.js': 'x' } }), // a.js не создан -> checker FAIL (попытка 1, sonnet)
    JSON.stringify({ files: { 'wrong.js': 'x' } }), // a.js не создан -> checker FAIL (попытка 2, sonnet)
    JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }), // a.js создан -> checker OK (попытка 3, opus)
  ].join('|');
  try {
    const { createJournal, createProject, runLoop } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coordinator Escalation', domain: 'cli' });
    const task = journal.addTask({
      project_id: project.id,
      title: 'write a.js v2',
      spec: 'создай a.js',
      criteria: passingCriterion(),
      role: 'coder',
    });

    await runLoop({ journal, projectId: project.id, role: 'coder' });

    const after = journal.getTask(task.id, project.id);
    assert.equal(after.status, 'done');
    assert.equal(after.attempts, 3);

    const log = env.readLog();
    assert.equal(log.length, 3);
    assert.equal(log[0].model, 'sonnet');
    assert.equal(log[1].model, 'sonnet');
    assert.equal(log[2].model, 'opus', 'попытка 3 должна эскалировать тир на Opus (§7 ТЗ)');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('coordinator: MAX_ATTEMPTS исчерпан -> blocked_needs_human с диагнозом', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'ok',
    fakeClaudeResult: JSON.stringify({ files: { 'wrong.js': 'module.exports = 1;\n' } }), // никогда не создаёт a.js
  });
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coordinator Exhausted', domain: 'cli' });
    let task = journal.addTask({
      project_id: project.id,
      title: 'never works',
      spec: 'создай a.js',
      criteria: passingCriterion(),
      role: 'coder',
    });

    let last;
    for (let i = 0; i < 4; i++) {
      task = journal.getTask(task.id, project.id);
      last = await processTask({ journal, task });
    }

    assert.equal(last.verdict, 'blocked_needs_human');
    const final = journal.getTask(task.id, project.id);
    assert.equal(final.status, 'blocked_needs_human');
    assert.equal(final.attempts, 4);
    // Диагност (подставная модель без поля "level") не дал применимого
    // решения -> честный отказ по шаблону §11 ТЗ (6 пунктов).
    assert.match(final.question, /Упёрся:/);
    assert.match(final.question, /Уровень:/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('coordinator: {question} от Исполнителя уходит напрямую в blocked_needs_human', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ question: 'какая должна быть цветовая схема?' }) });
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coordinator Question', domain: 'cli' });
    const task = journal.addTask({
      project_id: project.id,
      title: 'ambiguous task',
      spec: 'сделай что-то неоднозначное',
      criteria: passingCriterion(),
      role: 'coder',
    });

    const result = await processTask({ journal, task });
    assert.equal(result.verdict, 'question');

    const after = journal.getTask(task.id, project.id);
    assert.equal(after.status, 'blocked_needs_human');
    assert.equal(after.attempts, 1, 'question не должен тратить полную лестницу попыток');
    assert.equal(after.question, 'какая должна быть цветовая схема?');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('coordinator: попытка Исполнителя записать вне проекта блокируется замком пути, файл не создаётся', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ files: { '../escape.js': 'x' } }) });
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coordinator PathLock', domain: 'cli' });
    const task = journal.addTask({
      project_id: project.id,
      title: 'malicious path',
      spec: 'test',
      criteria: passingCriterion(),
      role: 'coder',
    });

    const result = await processTask({ journal, task });
    assert.equal(result.verdict, 'retry');
    assert.match(result.report, /песочницы/);

    const escaped = path.join(path.dirname(project.workspace_dir), 'escape.js');
    assert.equal(fs.existsSync(escaped), false);

    const events = journal.listEvents(project.id);
    assert.ok(events.some((e) => e.type === 'status' && JSON.parse(e.payload ?? '{}').kind === 'path_lock_violation'));

    journal.close();
  } finally {
    env.cleanup();
  }
});
