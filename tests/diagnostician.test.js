// tests/diagnostician.test.js - лестница честности (§1.7, §11 ТЗ): смена
// уровня (code/approach/understanding), измерение как факт, финальный диагноз
// человеку по шаблону из 6 пунктов. Подставной claude - без реальных вызовов модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const coordinatorMod = await import('../core/coordinator.js');
  return { ...journalMod, ...projectsMod, ...coordinatorMod };
}

function passingCriterion() {
  return { cmd: 'node -e "if(!require(\'fs\').existsSync(\'a.js\')){console.error(\'FAIL: a.js missing\');process.exit(1)}"' };
}

function seq(modes, results) {
  process.env.FAKE_CLAUDE_SEQUENCE = modes.join(',');
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = results.join('|');
}

test('diagnostician: уровень code - подсказка помогает, задача решается на попытке 5', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  seq(
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    [
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt1 fail
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt2 fail
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt3 fail (opus)
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt4 fail (opus) -> triggers diagnostician
      JSON.stringify({ level: 'code', reasoning: 'реализация не туда пишет файл', code_hint: 'пиши именно в a.js' }), // diagnostician
      JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }), // attempt5 - succeeds
    ]
  );
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Diag Code', domain: 'cli' });
    let task = journal.addTask({ project_id: project.id, title: 'x', spec: 'создай a.js', criteria: passingCriterion(), role: 'coder' });

    let last;
    for (let i = 0; i < 5; i++) {
      task = journal.getTask(task.id, project.id);
      last = await processTask({ journal, task });
    }

    assert.equal(last.verdict, 'done');
    const final = journal.getTask(task.id, project.id);
    assert.equal(final.status, 'done');
    assert.equal(final.level, 'code');
    assert.equal(env.callCount(), 6);

    const events = journal.listEvents(project.id);
    const verdictEvent = events.find((e) => e.type === 'diagnosis' && JSON.parse(e.payload ?? '{}').kind === 'verdict');
    assert.ok(verdictEvent);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('diagnostician: уровень approach - перепроектирование другим вариантом, свежая лестница попыток', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  seq(
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    [
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ level: 'approach', reasoning: 'подход А не работает', approach_alternative: 'Вариант B' }),
      JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }),
    ]
  );
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Diag Approach', domain: 'cli' });
    journal.setApproach(project.id, { options: [{ name: 'Вариант A' }, { name: 'Вариант B' }], chosen: 'Вариант A' });
    let task = journal.addTask({ project_id: project.id, title: 'x', spec: 'создай a.js вариантом A', criteria: passingCriterion(), role: 'coder' });

    let last;
    for (let i = 0; i < 5; i++) {
      task = journal.getTask(task.id, project.id);
      last = await processTask({ journal, task });
    }

    assert.equal(last.verdict, 'done');
    const final = journal.getTask(task.id, project.id);
    assert.equal(final.level, 'approach');
    assert.match(final.spec, /Вариант B/);
    // attempts сбросились при редиректе (0) и снова дошли до 1 на успешной попытке.
    assert.equal(final.attempts, 1);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('diagnostician: уровень understanding - переформулировка задачи', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  seq(
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    [
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ files: { 'wrong.js': 'x' } }),
      JSON.stringify({ level: 'understanding', reasoning: 'задача была неверно понята', understanding_correction: 'Исправленная задача: создай ровно a.js' }),
      JSON.stringify({ files: { 'a.js': 'module.exports = 1;\n' } }),
    ]
  );
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Diag Understanding', domain: 'cli' });
    let task = journal.addTask({ project_id: project.id, title: 'x', spec: 'смутная формулировка', criteria: passingCriterion(), role: 'coder' });

    let last;
    for (let i = 0; i < 5; i++) {
      task = journal.getTask(task.id, project.id);
      last = await processTask({ journal, task });
    }

    assert.equal(last.verdict, 'done');
    const final = journal.getTask(task.id, project.id);
    assert.equal(final.level, 'understanding');
    assert.equal(final.spec, 'Исправленная задача: создай ровно a.js');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('diagnostician: измерение реально исполняется (факт в events), финальный отказ - шаблон 6 пунктов', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  seq(
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    [
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt1
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt2
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt3 (opus)
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt4 (opus) -> diagnostician
      JSON.stringify({ level: 'code', measurement_request: { cmd: 'node -e "console.log(2+2)"', purpose: 'проверить базовую арифметику среды' } }), // diag call 1
      JSON.stringify({ level: 'code', reasoning: 'после измерения всё ещё code', code_hint: 'попробуй ещё раз' }), // diag call 2 (после измерения)
      JSON.stringify({ files: { 'wrong.js': 'x' } }), // attempt5 - тоже проваливается
      JSON.stringify({
        level: 'code',
        diagnosis_for_human: {
          stuck_on: 'Исполнитель не создаёт a.js',
          measured_facts: 'арифметика среды в порядке (2+2=4), проблема не в окружении',
          level_exhausted: 'code',
          boundary: 'простой ретрай не помогает',
          workaround: 'переформулировать задачу человеку вручную',
          partial_result: 'ничего не работает',
        },
      }), // diag call 3 (previousAttemptFailedAgain)
    ]
  );
  try {
    const { createJournal, createProject, processTask } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Diag Measurement', domain: 'cli' });
    let task = journal.addTask({ project_id: project.id, title: 'x', spec: 'создай a.js', criteria: passingCriterion(), role: 'coder' });

    let last;
    for (let i = 0; i < 5; i++) {
      task = journal.getTask(task.id, project.id);
      last = await processTask({ journal, task });
    }

    assert.equal(last.verdict, 'blocked_needs_human');
    assert.equal(env.callCount(), 8, 'должно быть ровно 8 вызовов модели: 5 coder + 3 diagnostician');

    const final = journal.getTask(task.id, project.id);
    assert.equal(final.status, 'blocked_needs_human');
    assert.match(final.question, /Упёрся: Исполнитель не создаёт a\.js/);
    assert.match(final.question, /арифметика среды в порядке/);
    assert.match(final.question, /Частичный результат: ничего не работает/);

    const events = journal.listEvents(project.id);
    const measurementEvent = events.find((e) => e.type === 'diagnosis' && JSON.parse(e.payload ?? '{}').kind === 'measurement');
    assert.ok(measurementEvent, 'измерение должно быть зафиксировано в events как факт');
    assert.match(JSON.parse(measurementEvent.payload).report, /OK/);

    journal.close();
  } finally {
    env.cleanup();
  }
});
