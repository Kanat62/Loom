// tests/engineer.test.js - Инженер (§1.1 ТЗ v5.2): Аналитик+Архитектор+
// Консультант+свод Дизайнера слиты в одну роль. Режимы: Понимание,
// Дизайн-направление, План (+ разведка/spike, core_check), Сдача. Подставной
// `claude` в PATH - без реальных вызовов модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const engineerMod = await import('../agents/engineer.js');
  return { ...journalMod, ...projectsMod, ...engineerMod };
}

// ============================================================================
// Режим: Понимание - regex-фильтр (§3.1 ТЗ v5.2, шрам 15), безопасный дефолт
// ============================================================================

test('findForbiddenQuestion: пропускает нормальные вопросы о результате', async () => {
  const { findForbiddenQuestion } = await import('../agents/engineer.js');
  assert.equal(findForbiddenQuestion(['Как должен выглядеть готовый результат для пользователя?']), null);
  assert.equal(findForbiddenQuestion(['По каким признакам ты поймёшь, что страница готова?']), null);
  assert.equal(findForbiddenQuestion([]), null);
  assert.equal(findForbiddenQuestion(undefined), null);
});

test('findForbiddenQuestion: отклоняет числа с единицами (px/мс/fps/...)', async () => {
  const { findForbiddenQuestion } = await import('../agents/engineer.js');
  assert.ok(findForbiddenQuestion(['Ширина кнопки должна быть 200px или больше?']));
  assert.ok(findForbiddenQuestion(['Задержка анимации 300мс подойдёт?']));
  assert.ok(findForbiddenQuestion(['Видео должно идти на 30fps?']));
});

test('findForbiddenQuestion: отклоняет названия технологий и формулировки выбора реализации', async () => {
  const { findForbiddenQuestion } = await import('../agents/engineer.js');
  assert.ok(findForbiddenQuestion(['Делать фронтенд на React?']));
  assert.ok(findForbiddenQuestion(['Нужна база данных для хранения карточек?']));
  assert.ok(findForbiddenQuestion(['Какой из вариантов хранения предпочесть?']));
  assert.ok(findForbiddenQuestion(['Использовать ли кэширование на клиенте?']));
});

test('findForbiddenQuestion: без \\b - работает на кириллице (§19.11 ТЗ)', async () => {
  const { findForbiddenQuestion } = await import('../agents/engineer.js');
  const hit = findForbiddenQuestion(['Нужен ли отдельный сервер для этого?']);
  assert.ok(hit);
  assert.match(hit.question, /сервер/);
});

test('runUnderstand: сбой шлюза (все модели недоступны) -> безопасный дефолт route=build', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'exit1' });
  try {
    const { runUnderstand, createJournal } = await freshImports();
    const journal = await createJournal();
    const result = await runUnderstand({
      transcript: [{ from: 'human', text: 'хочу сайт' }],
      project: null,
      journal,
      runId: 'r1',
      gatewayOpts: { roundPauseMs: 10 },
    });
    assert.equal(result.route, 'build');
    journal.close();
  } finally {
    env.cleanup();
  }
});

test('runUnderstand: невалидный JSON от модели (после исчерпания ретраев) -> безопасный дефолт route=build', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: 'это не json, а прозаический ответ' });
  try {
    const { runUnderstand, createJournal } = await freshImports();
    const journal = await createJournal();
    const result = await runUnderstand({
      transcript: [{ from: 'human', text: 'хочу сайт' }],
      project: null,
      journal,
      runId: 'r1',
      gatewayOpts: { roundPauseMs: 10 },
    });
    assert.equal(result.route, 'build');
    journal.close();
  } finally {
    env.cleanup();
  }
});

// ============================================================================
// Режим: Дизайн-направление (было designer.js)
// ============================================================================

test('runDesignDirection: без референса -> status=choose_direction с 2-3 вариантами', async () => {
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
    const { createJournal, createProject, runDesignDirection } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'UI Demo', domain: 'ui' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nСайт без референса', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runDesignDirection({ project, productSpec, journal, runId: 'r1' });
    assert.equal(result.status, 'choose_direction');
    assert.equal(result.options.length, 2);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('runDesignDirection: с выбранным направлением -> status=ready, tokens_css + rules сохраняются на диск', async () => {
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
    const { createJournal, createProject, runDesignDirection, saveDesignSystem, loadDesignSystem } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'UI Demo Ready', domain: 'ui' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nСайт', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runDesignDirection({ project, productSpec, journal, runId: 'r1', chosenDirection: 'Чистый минимализм' });
    assert.equal(result.status, 'ready');

    saveDesignSystem(project.id, result);
    const tokensPath = path.join(project.workspace_dir, 'design', 'tokens.css');
    assert.ok(fs.existsSync(tokensPath));
    assert.match(fs.readFileSync(tokensPath, 'utf8'), /--accent: oklch/);

    const forCoder = loadDesignSystem(project.id);
    assert.match(forCoder, /--accent: oklch/, 'Исполнитель должен получить дизайн-систему ВСЕГДА полностью, включая tokens.css');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('loadDesignSystem возвращает null, если дизайн ещё не создавался', async () => {
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

// ============================================================================
// Режим: План (было architect.js) - readiness{text,tier}, core_check, spike
// ============================================================================

function samplePlan({ fictitiousFirstTask = false, riskiestAssumption = null, coreCheckOnT1 = true } = {}) {
  return {
    domain: 'lib',
    packages: [],
    approach: {
      options: [
        { name: 'A', pros: 'x', cons: 'y', cost: 'низкая' },
        { name: 'B', pros: 'x', cons: 'y', cost: 'средняя' },
      ],
      chosen: 'A',
      why: 'проще',
      ...(riskiestAssumption ? { riskiest_assumption: riskiestAssumption } : {}),
    },
    tasks: [
      {
        key: 't1',
        title: 'создать a.js',
        spec: 'создай a.js с module.exports=1',
        touches_files: ['a.js'],
        covers: ['признак 1'],
        core_check: coreCheckOnT1,
        deps: [],
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
        core_check: false,
        deps: ['t1'],
        criteria: { cmd: 'node -e "console.log(require(\'./b.js\')===2)"', expect: { equals: 'true' } },
      },
    ],
    regression_task: { title: 'Регрессия', regression_of: ['t1', 't2'] },
  };
}

function readinessDefault() {
  return [
    { text: 'признак 1', tier: 'core' },
    { text: 'признак 2', tier: 'support' },
  ];
}

test('planProject: дерево задач вставляется, deps резолвятся key->id, регрессия зависит от всех', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan()) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Engineer Plan Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
    const productSpec = journal.getProductSpec(project.id);

    const { tasks, regressionTask, uncoveredReadiness, uncoveredCoreChecks } = await planProject({ project, productSpec, journal });

    assert.equal(tasks.length, 2);
    const t1 = tasks.find((t) => t._key === 't1');
    const t2 = tasks.find((t) => t._key === 't2');
    assert.ok(t1 && t2);
    assert.equal(t1.core_check, true);

    const t2Row = journal.listTasks(project.id).find((t) => t.id === t2.id);
    assert.ok(t2Row);

    const claimable = journal.claimNext('coder', project.id);
    assert.equal(claimable.id, t1.id, 'первой claimable должна быть t1 - t2 blocked_by t1');

    assert.ok(regressionTask);
    const regressionRow = journal.listTasks(project.id).find((t) => t.id === regressionTask.id);
    assert.deepEqual(regressionRow.criteria.regression_of.sort(), [t1.id, t2.id].sort());

    assert.deepEqual(uncoveredReadiness, []);
    assert.deepEqual(uncoveredCoreChecks, [], 'признак 1 (core) покрыт t1 с core_check=true');

    const projectRow = journal.getProject(project.id);
    assert.equal(projectRow.domain, 'lib');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('planProject: core-признак без core_check -> uncoveredCoreChecks непуст (правило 13)', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan({ coreCheckOnT1: false })) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Missing CoreCheck', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
    const productSpec = journal.getProductSpec(project.id);

    const { uncoveredCoreChecks } = await planProject({ project, productSpec, journal });
    assert.deepEqual(uncoveredCoreChecks, ['признак 1']);

    const events = journal.listEvents(project.id);
    const hit = events.find((e) => e.type === 'status' && JSON.parse(e.payload ?? '{}').kind === 'uncovered_core_check');
    assert.ok(hit);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('planProject: непокрытый признак готовности возвращается как uncoveredReadiness', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan()) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Coverage Demo', domain: null });
    journal.saveProductSpec({
      project_id: project.id,
      spec_md: '## 1. Что это\nx',
      readiness: [...readinessDefault(), { text: 'признак 3 (не покрыт никем)', tier: 'support' }],
    });
    const productSpec = journal.getProductSpec(project.id);

    const { uncoveredReadiness } = await planProject({ project, productSpec, journal });
    assert.deepEqual(uncoveredReadiness, ['признак 3 (не покрыт никем)']);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('planProject: разведка (spike) - создаётся первой и блокирует всё дерево (§3.3 ТЗ v5.2)', async () => {
  const riskiest = {
    statement: 'библиотека X умеет распознавать нужный паттерн на реальных данных',
    why_riskiest: 'если нет - весь approach бессмысленен',
    how_to_check: 'node -e "console.log(1)"',
    kill_criteria: 'если stdout не 1 - подход отвергается',
  };
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan({ riskiestAssumption: riskiest })) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Spike Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
    const productSpec = journal.getProductSpec(project.id);

    const { spikeTask, tasks, regressionTask } = await planProject({ project, productSpec, journal });
    assert.ok(spikeTask);
    assert.equal(spikeTask.type, 'spike');

    // Разведка первая claimable - все остальные задачи blocked_by ней.
    const claimable = journal.claimNext('coder', project.id);
    assert.equal(claimable.id, spikeTask.id);

    // Регрессия тоже заблокирована спайком (напрямую или через t1/t2 - в любом случае не claimable).
    const stillBlockedIds = new Set([...tasks.map((t) => t.id), regressionTask.id]);
    assert.ok(stillBlockedIds.size > 0);

    // Закрываем спайк - дерево должно разблокироваться.
    journal.setStatus(spikeTask.id, 'done', { feedback: 'OK: 1' });
    const nextClaimable = journal.claimNext('coder', project.id);
    assert.notEqual(nextClaimable.id, spikeTask.id);
    assert.ok(tasks.some((t) => t.id === nextClaimable.id));

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('planProject: без riskiest_assumption - spike не создаётся, дерево стартует сразу', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify(samplePlan()) });
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'No Spike Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
    const productSpec = journal.getProductSpec(project.id);

    const { spikeTask, tasks } = await planProject({ project, productSpec, journal });
    assert.equal(spikeTask, null);

    const claimable = journal.claimNext('coder', project.id);
    assert.equal(claimable.id, tasks.find((t) => t._key === 't1').id);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('planProject: предпроверка пустышек (§8.9) - фиктивный критерий вызывает регенерацию', async () => {
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
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
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

test('planProject: синтаксически битый критерий (обрыв генерации) -> ОДНА регенерация, вторая попытка проходит precheck', async () => {
  const brokenPlan = {
    ...samplePlan(),
    tasks: [
      { ...samplePlan().tasks[0], criteria: { cmd: 'node -e "(async()=>{console.log(1)"' } },
      samplePlan().tasks[1],
    ],
  };
  const fixedPlan = samplePlan();
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [JSON.stringify(brokenPlan), JSON.stringify(fixedPlan)].join('|');
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Malformed Criteria Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
    const productSpec = journal.getProductSpec(project.id);

    const { tasks } = await planProject({ project, productSpec, journal });
    assert.equal(tasks.length, 2, 'должно получиться дерево из ВТОРОГО (синтаксически валидного) плана');
    assert.equal(env.callCount(), 2, 'ровно одна регенерация - 2 вызова всего');

    const events = journal.listEvents(project.id);
    const hit = events.find((e) => e.type === 'status' && JSON.parse(e.payload ?? '{}').kind === 'malformed_criteria');
    assert.ok(hit, 'обрыв генерации критерия должен залогироваться как факт');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('planProject: npm install провалился -> ОДНА регенерация плана с другими пакетами, вторая попытка успешна', async () => {
  const badPlan = { ...samplePlan(), packages: ['this-package-definitely-does-not-exist-xyz-12345'] };
  const goodPlan = { ...samplePlan(), packages: [] };
  const env = setupTestEnv({ fakeClaudeMode: 'sequence' });
  process.env.FAKE_CLAUDE_SEQUENCE = 'ok,ok';
  process.env.FAKE_CLAUDE_SEQUENCE_RESULTS = [JSON.stringify(badPlan), JSON.stringify(goodPlan)].join('|');
  try {
    const { createJournal, createProject, planProject } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Npm Fail Demo', domain: null });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault() });
    const productSpec = journal.getProductSpec(project.id);

    const { tasks } = await planProject({ project, productSpec, journal });
    assert.equal(tasks.length, 2, 'должно получиться дерево из ВТОРОГО (успешного) плана');
    assert.equal(env.callCount(), 2, 'ровно одна регенерация - 2 вызова всего');

    const events = journal.listEvents(project.id);
    const hit = events.find((e) => e.type === 'status' && JSON.parse(e.payload ?? '{}').kind === 'npm_install_failed');
    assert.ok(hit, 'провал npm install должен залогироваться как факт');
    assert.match(JSON.parse(hit.payload).error, /this-package-definitely-does-not-exist/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('npmInstallGuarded: кидает ошибку, если npm prefix не совпадает с каталогом проекта (шрам 36)', async () => {
  const { npmInstallGuarded } = await import('../agents/engineer.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-npmguard-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-ancestor' }));
  const projectDir = path.join(root, 'projects', 'fake-project');
  fs.mkdirSync(projectDir, { recursive: true });

  await assert.rejects(() => npmInstallGuarded(projectDir, ['some-package']), /npm prefix guard/);

  fs.rmSync(root, { recursive: true, force: true });
});

test('npmInstallGuarded: skip без сети, если packages пуст', async () => {
  const { npmInstallGuarded } = await import('../agents/engineer.js');
  const result = await npmInstallGuarded('/any/dir', []);
  assert.deepEqual(result, { skipped: true });
});

// ============================================================================
// Режим: Сдача (было consultant.js)
// ============================================================================

const SAMPLE_REPORT = `1. Задача
Сделать одностраничник.

2. Ядро замысла
Ради чего продукт существует - одно предложение.

3. Решения
Статичный HTML без фреймворков - проще и быстрее для одной страницы.

4. Что сделано
Закрыто 2 из 2 признаков готовности (1 core, 1 support).

5. Как проверено
Контур 1: 2/2 критерия пройдено, из них core_check: 1. Контур 2: Пилот прошёл сценарий, находок нет.

6. Что НЕ проверено
Ничего существенного не осталось непроверенным.

7. Что хромает и что требует тебя
Ничего.

8. Следующий шаг
Добавить аналитику, если понадобится.`;

test('runReport: собирает отчёт из 8 пунктов LLM + пункт 9 от harness, пишет REPORT.md', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: SAMPLE_REPORT });
  try {
    const { createJournal, createProject, runReport } = await freshImports();

    const journal = await createJournal();
    const project = createProject(journal, { title: 'Report Demo', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault(), core_intent: 'ядро' });
    const productSpec = journal.getProductSpec(project.id);

    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'coder', tokens_in: 10, tokens_out: 5, cache_read: 0, cost_usd: 0.01, duration_ms: 500 });

    const report = await runReport({ project, productSpec, journal, runId: 'r1' });

    assert.match(report, /1\. Задача/);
    assert.match(report, /9\. Расход/);
    assert.match(report, /ИТОГО/);

    const reportPath = path.join(project.workspace_dir, 'REPORT.md');
    assert.ok(fs.existsSync(reportPath));
    assert.equal(fs.readFileSync(reportPath, 'utf8'), report);

    journal.close();
  } finally {
    env.cleanup();
  }
});

// ============================================================================
// Режим: Сверка целого (checkpoint) - §3.2 ТЗ v5.2
// ============================================================================

test('runCheckpoint: логирует событие type=checkpoint независимо от исхода', async () => {
  const env = setupTestEnv({
    fakeClaudeMode: 'ok',
    fakeClaudeResult: JSON.stringify({ on_track: true, core_progress: 'ядро достижимо', drift: null, actions: [] }),
  });
  try {
    const { createJournal, createProject, runCheckpoint } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Checkpoint Demo', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 1. Что это\nx', readiness: readinessDefault(), core_intent: 'ядро' });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runCheckpoint({ project, productSpec, journal, runId: 'r1' });
    assert.equal(result.on_track, true);

    const events = journal.listEvents(project.id);
    const hit = events.find((e) => e.type === 'checkpoint');
    assert.ok(hit);
    assert.equal(JSON.parse(hit.payload).on_track, true);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('applyCheckpointActions: add_task создаёт задачу, retire_task снимает НЕ-done задачу, done не трогает', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, applyCheckpointActions } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Actions Demo', domain: 'cli' });

    const pendingTask = journal.addTask({ project_id: project.id, title: 'снять меня', spec: 'x', criteria: {}, role: 'coder' });
    const doneTask = journal.addTask({ project_id: project.id, title: 'done задача', spec: 'x', criteria: {}, role: 'coder' });
    journal.setStatus(doneTask.id, 'done', { feedback: 'OK' });

    const applied = applyCheckpointActions(journal, project, [
      { type: 'add_task', why: 'недостающая работа', task: { title: 'новая задача', spec: 'сделай', criteria: {}, covers: [], core_check: false } },
      { type: 'retire_task', why: 'больше не нужна', task_id: pendingTask.id },
      { type: 'retire_task', why: 'нельзя трогать done', task_id: doneTask.id },
      { type: 'revise_plan', why: 'заметка', note: 'на будущее' },
    ]);

    assert.equal(applied.filter((a) => a.type === 'add_task').length, 1);
    assert.equal(applied.filter((a) => a.type === 'retire_task').length, 1, 'done-задача не должна попасть в applied');

    const afterPending = journal.getTask(pendingTask.id, project.id);
    assert.equal(afterPending.status, 'retired');
    const afterDone = journal.getTask(doneTask.id, project.id);
    assert.equal(afterDone.status, 'done', 'done-задачу retire_task не имеет права трогать');

    journal.close();
  } finally {
    env.cleanup();
  }
});
