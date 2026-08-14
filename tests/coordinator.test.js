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

test('coordinator: spike-задача получает SPIKE_MAX_ATTEMPTS=3, не общий MAX_ATTEMPTS=4 (§3.3 ТЗ v5.2)', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'sequence',
  });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok,ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [
    JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt1 fail
    JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt2 fail
    JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt3 fail (opus) -> exhausts SPIKE_MAX_ATTEMPTS=3 -> diagnostician
    JSON.stringify({ level: null, diagnosis_for_human: { stuck_on: 'разведка не подтвердила допущение', measured_facts: 'числа не сошлись', level_exhausted: 'code', boundary: 'x', workaround: 'y', partial_result: 'z' } }), // diagnostician
  ].join('|');
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Spike Attempts', domain: 'cli' });
    let task = journal.addTask({
      project_id: project.id,
      title: 'разведка',
      spec: 'проверь допущение',
      criteria: passingCriterion(),
      role: 'coder',
      type: 'spike',
    });

    let last;
    for (let i = 0; i < 3; i++) {
      task = journal.getTask(task.id, project.id);
      last = await processTask({ journal, task });
    }

    assert.equal(last.verdict, 'blocked_needs_human', 'spike обязана уйти на диагноз уже после 3 попыток, не 4');
    const final = journal.getTask(task.id, project.id);
    assert.equal(final.attempts, 3);
    assert.equal(env.callCount(), 4, '3 попытки coder + 1 diagnostician - не 5, как было бы с общим MAX_ATTEMPTS=4');

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

// ============================================================================
// checkpoint (§3.2 ТЗ v5.2) - сверка целого между задачами, on_track:false
// останавливает конвейер ДО следующей задачи.
// ============================================================================

test('coordinator: runLoopWithCheckpoints - checkpoint после core_check-задачи, on_track:false останавливает конвейер', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [
    JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }), // coder task1 (core_check)
    JSON.stringify({ on_track: false, drift: 'ушли от ядра', actions: [], stop_reason: 'ядро недостижимо выбранным путём' }), // checkpoint
  ].join('|');
  try {
    const { createJournal, createProject, runLoopWithCheckpoints } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Checkpoint Stop', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [{ text: 'признак 1', tier: 'core' }] });

    const task1 = journal.addTask({
      project_id: project.id,
      title: 'task1',
      spec: 'создай a.js',
      criteria: passingCriterion(),
      role: 'coder',
      covers: ['признак 1'],
      core_check: true,
    });
    const task2 = journal.addTask({
      project_id: project.id,
      title: 'task2',
      spec: 'создай b.js',
      criteria: { cmd: 'node -e "process.exit(0)"' },
      role: 'coder',
    });

    const productSpec = journal.getProductSpec(project.id);
    const { stopped, stopReason } = await runLoopWithCheckpoints({ journal, project, productSpec });

    assert.equal(stopped, true);
    assert.equal(stopReason, 'ядро недостижимо выбранным путём');

    const after1 = journal.getTask(task1.id, project.id);
    assert.equal(after1.status, 'done');
    const after2 = journal.getTask(task2.id, project.id);
    assert.equal(after2.status, 'pending', 'вторая задача не должна была запуститься после остановки конвейера checkpoint');

    const events = journal.listEvents(project.id);
    assert.ok(events.some((e) => e.type === 'checkpoint'), 'сверка целого обязана быть зафиксирована в events');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('coordinator: runLoopWithCheckpoints - on_track:true с actions=[add_task] продолжает конвейер и выполняет добавленную задачу', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [
    JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }), // coder task1 (core_check)
    JSON.stringify({
      on_track: true,
      drift: null,
      actions: [{ type: 'add_task', why: 'нашли пробел', task: { title: 'доп. задача', spec: 'создай c.js', criteria: { cmd: 'node -e "process.exit(0)"' }, covers: [], core_check: false } }],
    }), // checkpoint
    JSON.stringify({ files: { 'c.js': 'module.exports = 1;\n' } }), // coder для добавленной задачи
  ].join('|');
  try {
    const { createJournal, createProject, runLoopWithCheckpoints } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Checkpoint AddTask', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [{ text: 'признак 1', tier: 'core' }] });

    journal.addTask({
      project_id: project.id,
      title: 'task1',
      spec: 'создай a.js',
      criteria: passingCriterion(),
      role: 'coder',
      covers: ['признак 1'],
      core_check: true,
    });

    const productSpec = journal.getProductSpec(project.id);
    const { stopped, results } = await runLoopWithCheckpoints({ journal, project, productSpec });

    assert.equal(stopped, false);
    const doneTitles = journal.listTasks(project.id, { status: 'done' }).map((t) => t.title);
    assert.ok(doneTitles.includes('доп. задача'), 'задача, добавленная сверкой целого, должна была выполниться в этом же прогоне');

    const checkpointResult = results.find((r) => r.checkpoint);
    assert.ok(checkpointResult);
    assert.equal(checkpointResult.applied.length, 1);

    journal.close();
  } finally {
    env.cleanup();
  }
});

// ============================================================================
// canDeliver (§4.2/§5/§6.3 ТЗ v5.2) - гейт сдачи без LLM, чистый код.
// ============================================================================

test('canDeliver: core-признак без подтверждённого core_check блокирует сдачу (правило 13, шрам 45)', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, canDeliver } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Deliver Core Gate', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [{ text: 'признак 1', tier: 'core' }] });
    const productSpec = journal.getProductSpec(project.id);

    const task = journal.addTask({ project_id: project.id, title: 't', spec: 'x', criteria: {}, role: 'coder', covers: ['признак 1'], core_check: false });
    journal.setStatus(task.id, 'done', { feedback: 'OK' });

    const verdict = canDeliver({ project: journal.getProject(project.id), productSpec, tasks: journal.listTasks(project.id) });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reasons.join(' '), /core_check/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('canDeliver: core-признак подтверждён core_check-задачей -> ok (нет иных блокеров, domain != ui)', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, canDeliver } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Deliver Core OK', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [{ text: 'признак 1', tier: 'core' }] });
    const productSpec = journal.getProductSpec(project.id);

    const task = journal.addTask({ project_id: project.id, title: 't', spec: 'x', criteria: {}, role: 'coder', covers: ['признак 1'], core_check: true });
    journal.setStatus(task.id, 'done', { feedback: 'OK' });

    const verdict = canDeliver({ project: journal.getProject(project.id), productSpec, tasks: journal.listTasks(project.id) });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.reasons, []);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('canDeliver: задачи blocked_needs_human блокируют сдачу', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, canDeliver } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Deliver Blocked', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const task = journal.addTask({ project_id: project.id, title: 't', spec: 'x', criteria: {}, role: 'coder' });
    journal.setStatus(task.id, 'blocked_needs_human', { question: 'нужно решение' });

    const verdict = canDeliver({ project: journal.getProject(project.id), productSpec, tasks: journal.listTasks(project.id) });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reasons.join(' '), /blocked_needs_human/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('canDeliver: visual:false Пилота при domain=ui блокирует сдачу (шрам 42)', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, canDeliver } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Deliver Visual Gate', domain: 'ui' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const verdict = canDeliver({
      project: journal.getProject(project.id),
      productSpec,
      tasks: journal.listTasks(project.id),
      pilotResult: { visual: false, findings: [] },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reasons.join(' '), /visual/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('canDeliver: связность токенов нарушена при domain=ui блокирует сдачу (правило 12, шрам 40)', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, canDeliver } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Deliver Token Gate', domain: 'ui' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    fs.mkdirSync(path.join(project.workspace_dir, 'design'), { recursive: true });
    fs.writeFileSync(path.join(project.workspace_dir, 'design', 'tokens.css'), ':root { --accent: oklch(60% 0.15 250); }');
    fs.writeFileSync(path.join(project.workspace_dir, 'index.html'), '<style>body{color:var(--made-up-name)}</style>');

    const verdict = canDeliver({
      project: journal.getProject(project.id),
      productSpec,
      tasks: journal.listTasks(project.id),
      pilotResult: { visual: true, findings: [] },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reasons.join(' '), /--made-up-name/);

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
