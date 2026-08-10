// tests/checkRunner.test.js - §8 ТЗ, критерии приёмки: .cjs-вынос (шрам 7),
// таймаут по классу (§8.8), правило говорящего провала (§8.4), правило
// минимумов (§8.3), контракт регрессии (§8.10). Реальное исполнение
// процессов - не подставная модель (checkRunner вообще не вызывает модель).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSingleCheck, runRegression, runCriterion, classifyTimeout, extractNodeEvalBody } from '../core/checkRunner.js';
import { createJournal } from '../core/journal.js';

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-checkrunner-'));
}

test('checkRunner: node -e выносится в .cjs внутри workspace (не остаётся файлов после), exit 0 = pass', async () => {
  const cwd = tmpWorkspace();
  try {
    const before = fs.readdirSync(cwd).length;
    const result = await runSingleCheck({ cmd: 'node -e "console.log(1+1)"' }, { cwd });
    assert.equal(result.pass, true);
    assert.match(result.report, /OK/);
    const after = fs.readdirSync(cwd).length;
    assert.equal(after, before, '.loom-check-*.cjs должен быть удалён после исполнения');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: require() внутри .cjs резолвится относительно workspace (не tmpdir) - шрам 7', async () => {
  const cwd = tmpWorkspace();
  try {
    fs.mkdirSync(path.join(cwd, 'node_modules', 'fake-lib'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', 'fake-lib', 'index.js'), 'module.exports = 42;');
    fs.writeFileSync(path.join(cwd, 'node_modules', 'fake-lib', 'package.json'), JSON.stringify({ name: 'fake-lib', main: 'index.js' }));

    const result = await runSingleCheck({ cmd: 'node -e "console.log(require(\'fake-lib\'))"', expect: { equals: '42' } }, { cwd });
    assert.equal(result.pass, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: exit код 1 без expect -> FAIL с говорящим отчётом (не голый "FAIL")', async () => {
  const cwd = tmpWorkspace();
  try {
    const result = await runSingleCheck({ cmd: 'node -e "console.error(\'FAIL: value=1 expected=2\');process.exit(1)"' }, { cwd });
    assert.equal(result.pass, false);
    assert.match(result.report, /FAIL:/);
    assert.match(result.report, /value=1 expected=2/, 'отчёт должен содержать фактические значения, не голое FAIL');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: expect.min - правило минимумов (§8.3), не точное число', async () => {
  const cwd = tmpWorkspace();
  try {
    const passResult = await runSingleCheck({ cmd: 'node -e "console.log(5)"', expect: { min: 3 } }, { cwd });
    assert.equal(passResult.pass, true, '5 >= 3 - должно пройти');

    const failResult = await runSingleCheck({ cmd: 'node -e "console.log(2)"', expect: { min: 3 } }, { cwd });
    assert.equal(failResult.pass, false);
    assert.match(failResult.report, /expected>=3/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: expect.contains и expect.equals', async () => {
  const cwd = tmpWorkspace();
  try {
    const containsResult = await runSingleCheck({ cmd: 'node -e "console.log(\'hello world\')"', expect: { contains: 'world' } }, { cwd });
    assert.equal(containsResult.pass, true);

    const equalsResult = await runSingleCheck({ cmd: 'node -e "console.log(\'true\')"', expect: { equals: 'true' } }, { cwd });
    assert.equal(equalsResult.pass, true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: таймаут по классу (§8.8) - node по умолчанию 10000, playwright 60000, ffmpeg 120000, потолок 180000', () => {
  assert.equal(classifyTimeout('node -e "1"'), 10_000);
  assert.equal(classifyTimeout('node -e "require(\'playwright\')"'), 60_000);
  assert.equal(classifyTimeout('ffmpeg -i in.mp4 out.mp4'), 120_000);
  assert.equal(classifyTimeout('node -e "1"', 999_999), 180_000, 'явный timeout_ms не может превысить потолок');
  assert.equal(classifyTimeout('node -e "1"', 5000), 5000);
});

test('checkRunner: реальный таймаут убивает зависший процесс', async () => {
  const cwd = tmpWorkspace();
  try {
    const result = await runSingleCheck({ cmd: 'node -e "setTimeout(()=>{}, 30000)"', timeout_ms: 300 }, { cwd });
    assert.equal(result.pass, false);
    assert.equal(result.timedOut, true);
    assert.match(result.report, /timeout_ms=300/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: контракт регрессии (§8.10) - повторяет существующие критерии done-задач, все должны пройти', async () => {
  const cwd = tmpWorkspace();
  try {
    const journal = await createJournal(path.join(cwd, 'journal.db'));
    const project = journal.createProject({ id: 'regr-test', title: 'Regr', workspace_dir: cwd, domain: 'cli' });
    const t1 = journal.addTask({
      project_id: project.id,
      title: 't1',
      spec: 's',
      criteria: { cmd: 'node -e "console.log(1)"', expect: { equals: '1' } },
      role: 'coder',
    });
    journal.setStatus(t1.id, 'done');
    const t2 = journal.addTask({
      project_id: project.id,
      title: 't2',
      spec: 's',
      criteria: { cmd: 'node -e "console.log(2)"', expect: { equals: '2' } },
      role: 'coder',
    });
    journal.setStatus(t2.id, 'done');

    const result = await runRegression({ regression_of: [t1.id, t2.id] }, { cwd, journal, projectId: project.id });
    assert.equal(result.pass, true);
    assert.match(result.report, /t1/);
    assert.match(result.report, /t2/);

    journal.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: регрессия - если один из критериев теперь падает, весь прогон fail, вложенная регрессия запрещена', async () => {
  const cwd = tmpWorkspace();
  try {
    const journal = await createJournal(path.join(cwd, 'journal.db'));
    const project = journal.createProject({ id: 'regr-fail', title: 'Regr Fail', workspace_dir: cwd, domain: 'cli' });
    const t1 = journal.addTask({
      project_id: project.id,
      title: 'now broken',
      spec: 's',
      criteria: { cmd: 'node -e "console.error(\'FAIL: broke\');process.exit(1)"' },
      role: 'coder',
    });
    journal.setStatus(t1.id, 'done');

    const nestedRegression = journal.addTask({
      project_id: project.id,
      title: 'nested regression',
      spec: 's',
      criteria: { regression_of: [t1.id] },
      role: 'coder',
      type: 'regression',
    });
    journal.setStatus(nestedRegression.id, 'done');

    const result = await runRegression({ regression_of: [t1.id, nestedRegression.id] }, { cwd, journal, projectId: project.id });
    assert.equal(result.pass, false);
    assert.match(result.report, /вложенная регрессия запрещена/);

    journal.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('checkRunner: отсутствующий критерий - брак архитектора, честный FAIL', async () => {
  const result = await runCriterion(null, { cwd: process.cwd() });
  assert.equal(result.pass, false);
  assert.match(result.report, /брак архитектора/);
});
