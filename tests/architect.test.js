// tests/architect.test.js - Архитектор: approach, дерево задач с key->id
// резолвом deps, регрессия, трассировка covers, предпроверка пустышек (§8.9),
// guard npm install (шрам 36). Подставной `claude` в PATH - без реальных вызовов модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const architectMod = await import('../agents/architect.js');
  return { ...journalMod, ...projectsMod, ...architectMod };
}

function samplePlan({ fictitiousFirstTask = false } = {}) {
  return {
    domain: 'lib',
    packages: [],
    approach: { options: [{ name: 'A', pros: 'x', cons: 'y', cost: 'низкая' }, { name: 'B', pros: 'x', cons: 'y', cost: 'средняя' }], chosen: 'A', why: 'проще' },
    tasks: [
      {
        key: 't1',
        title: 'создать a.js',
        spec: 'создай a.js с module.exports=1',
        touches_files: ['a.js'],
        covers: ['признак 1'],
        deps: [],
        // Если fictitiousFirstTask - критерий проверяет, что 1===1 (всегда true, фиктивно).
        criteria: fictitiousFirstTask
          ? { cmd: 'node -e "console.log(1===1)"', expect: { equals: 'true' } }
          : { cmd: 'node -e "console.log(require(\'./a.js\')===1)"', expect: { equals: 'true' } },
      },
      {
        key: 't2',
        title: 'создать b.js, зависит от a.js',
        spec: 'создай b.js, использующий a.js',
        touches_files: ['b.js'],
        covers: ['признак 2'],
        deps: ['t1'],
        criteria: { cmd: 'node -e "console.log(require(\'./b.js\')===2)"', expect: { equals: 'true' } },
      },
    ],
    regression_task: { title: 'Регрессия', regression_of: ['t1', 't2'] },
  };
}

test('architect: дерево задач вставляется, deps резолвятся key->id, регрессия зависит от всех', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan()) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Architect Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: ['признак 1', 'признак 2'] });
    const productSpec = journal.getProductSpec(project.id);

    const { tasks, regressionTask, uncoveredReadiness } = await planProject({ project, productSpec, journal });

    assert.equal(tasks.length, 2);
    const t1 = tasks.find((t) => t._key === 't1');
    const t2 = tasks.find((t) => t._key === 't2');
    assert.ok(t1 && t2);

    const allTasks = journal.listTasks(project.id);
    const t2Row = allTasks.find((t) => t.id === t2.id);
    assert.ok(t2Row);

    // t2 должна быть заблокирована t1 (deps резолвнуты в реальные id).
    const blocked = journal.claimNext('coder', project.id);
    assert.equal(blocked.id, t1.id, 'первой claimable должна быть t1 - t2 blocked_by t1');

    assert.ok(regressionTask);
    const regressionRow = allTasks.find((t) => t.id === regressionTask.id);
    assert.deepEqual(regressionRow.criteria.regression_of.sort(), [t1.id, t2.id].sort());

    assert.deepEqual(uncoveredReadiness, []);

    // Проверка domain проставлен в projects.
    const projectRow = journal.getProject(project.id);
    assert.equal(projectRow.domain, 'lib');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('architect: непокрытый признак готовности возвращается как uncoveredReadiness', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan()) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coverage Demo', domain: null });
    journal.saveProductSpec({
      project_id: project.id,
      spec_md: '## 1. Что это\nx',
      readiness: ['признак 1', 'признак 2', 'признак 3 (не покрыт никем)'],
    });
    const productSpec = journal.getProductSpec(project.id);

    const { uncoveredReadiness } = await planProject({ project, productSpec, journal });
    assert.deepEqual(uncoveredReadiness, ['признак 3 (не покрыт никем)']);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('architect: предпроверка пустышек (§8.9) - фиктивный критерий вызывает регенерацию', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [
    JSON.stringify(samplePlan({ fictitiousFirstTask: true })),
    JSON.stringify(samplePlan({ fictitiousFirstTask: false })),
  ].join('|');
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Fictitious Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: ['признак 1', 'признак 2'] });
    const productSpec = journal.getProductSpec(project.id);

    await planProject({ project, productSpec, journal });

    assert.equal(env.callCount(), 2, 'фиктивный критерий на первом ответе должен вызвать ровно одну регенерацию');

    const events = journal.listEvents(project.id);
    const hit = events.find((e) => e.type === 'status' && JSON.parse(e.payload ?? '{}').kind === 'fictitious_criteria');
    assert.ok(hit, 'должно быть залогировано срабатывание капкана на пустышки');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('architect: npm install провалился -> ОДНА регенерация плана с другими пакетами, вторая попытка успешна', async () => {
  const badPlan = { ...samplePlan(), packages: ['this-package-definitely-does-not-exist-xyz-12345'] };
  const goodPlan = { ...samplePlan(), packages: [] };
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [JSON.stringify(badPlan), JSON.stringify(goodPlan)].join('|');
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Npm Fail Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: ['признак 1', 'признак 2'] });
    const productSpec = journal.getProductSpec(project.id);

    const { tasks } = await planProject({ project, productSpec, journal });
    assert.equal(tasks.length, 2, 'должно получиться дерево из ВТОРОГО (успешного) плана');
    assert.equal(env.callCount(), 2, 'ровно одна регенерация - 2 вызова архитектора всего');

    const events = journal.listEvents(project.id);
    const hit = events.find((e) => e.type === 'status' && JSON.parse(e.payload ?? '{}').kind === 'npm_install_failed');
    assert.ok(hit, 'провал npm install должен залогироваться как факт');
    assert.match(JSON.parse(hit.payload).error, /this-package-definitely-does-not-exist/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('architect: npmInstallGuarded кидает ошибку, если npm prefix не совпадает с каталогом проекта (шрам 36)', async () => {
  const { npmInstallGuarded } = await import('../agents/architect.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-npmguard-'));
  // Ancestor package.json - имитирует "npm поднимается вверх и находит манифест LOOM".
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-ancestor' }));
  const projectDir = path.join(root, 'projects', 'fake-project');
  fs.mkdirSync(projectDir, { recursive: true });
  // НЕ создаём package.json внутри projectDir - именно это должно вызвать guard.

  await assert.rejects(() => npmInstallGuarded(projectDir, ['some-package']), /npm prefix guard/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('architect: npmInstallGuarded - skip без сети, если packages пуст', async () => {
  const { npmInstallGuarded } = await import('../agents/architect.js');
  const result = await npmInstallGuarded('/any/dir', []);
  assert.deepEqual(result, { skipped: true });
});
