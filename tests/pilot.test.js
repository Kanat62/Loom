// tests/pilot.test.js - Пилот (§1.6, §9 ТЗ): скрипт пишет harness, находки ->
// задачи pilot_fix, деградация без притворства при сбое скрипта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const pilotMod = await import('../agents/pilot.js');
  return { ...journalMod, ...projectsMod, ...pilotMod };
}

function scriptPrinting(json) {
  // Реальный маленький Node-скрипт (не Playwright) - печатает ровно одну JSON-строку.
  return `console.log(${JSON.stringify(JSON.stringify(json))});`;
}

test('pilot: скрипт исполняется, находки парсятся из stdout', async () => {
  const findingsPayload = {
    findings: [
      { title: 'Кнопка не реагирует', what_happened: 'клик не меняет состояние', expected: 'состояние меняется', severity: 'major', criteria: { cmd: 'node -e "console.log(true)"', expect: { equals: 'true' } } },
    ],
    visual: true,
  };
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ script: scriptPrinting(findingsPayload) }) });
  try {
    const { createJournal, createProject, runPilot } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Pilot Demo', domain: 'cli' }); // domain=cli - пропускаем реальный playwright-биноарник
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 2. Как работает\nсценарий', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runPilot({ project, productSpec, journal, runId: 'r1' });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'major');
    assert.equal(result.visual, true);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('pilot: пустой список находок -> доска чиста, ничего не создаётся', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ script: scriptPrinting({ findings: [], visual: true }) }) });
  try {
    const { createJournal, createProject, runPilot, applyPilotFindings } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Pilot Clean', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 2. Как работает\nсценарий', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runPilot({ project, productSpec, journal, runId: 'r1' });
    assert.deepEqual(result.findings, []);
    const created = applyPilotFindings(journal, project, result.findings);
    assert.deepEqual(created, []);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('pilot: скрипт падает без вывода -> честный scriptFailed, НЕ имитация успеха', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ script: "process.exit(1);" }) });
  try {
    const { createJournal, createProject, runPilot } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Pilot Crash', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 2. Как работает\nсценарий', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runPilot({ project, productSpec, journal, runId: 'r1' });
    assert.equal(result.scriptFailed, true);
    assert.equal(result.visual, false);
    assert.deepEqual(result.findings, []);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('pilot: скрипт печатает невалидный JSON -> честный scriptFailed', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ script: "console.log('это не json')" }) });
  try {
    const { createJournal, createProject, runPilot } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Pilot BadJson', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 2. Как работает\nсценарий', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runPilot({ project, productSpec, journal, runId: 'r1' });
    assert.equal(result.scriptFailed, true);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('pilot: steps_done прокидывается из скрипта в результат', async () => {
  const payload = { findings: [], visual: true, steps_done: ['открыл продукт', 'прошёл сценарий'] };
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: JSON.stringify({ script: scriptPrinting(payload) }) });
  try {
    const { createJournal, createProject, runPilot } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Pilot Steps', domain: 'cli' });
    journal.saveProductSpec({ project_id: project.id, spec_md: '## 2. Как работает\nсценарий', readiness: [] });
    const productSpec = journal.getProductSpec(project.id);

    const result = await runPilot({ project, productSpec, journal, runId: 'r1' });
    assert.deepEqual(result.stepsDone, ['открыл продукт', 'прошёл сценарий']);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('requiresVisualBlock: §5 ТЗ v5.2 (шрам 42) - visual:false блокирует ТОЛЬКО для domain=ui', async () => {
  const { requiresVisualBlock } = await import('../agents/pilot.js');
  assert.equal(requiresVisualBlock({ domain: 'ui' }, { visual: false }), true);
  assert.equal(requiresVisualBlock({ domain: 'ui' }, { visual: true }), false);
  assert.equal(requiresVisualBlock({ domain: 'cli' }, { visual: false }), false, 'cli-продукт не проверяется визуально в принципе');
});

test('pilot: applyPilotFindings создаёт задачи type=pilot_fix с критериями находок', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, applyPilotFindings, hasBlockers } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Pilot Findings', domain: 'cli' });

    const findings = [
      { title: 'Видео не скачивается', what_happened: 'кнопка скачать не создаёт файл', expected: 'файл mp4 появляется', severity: 'blocker', criteria: { cmd: 'node -e "console.log(false)"', expect: { equals: 'true' } } },
      { title: 'Мелкая опечатка', what_happened: 'текст с опечаткой', expected: 'без опечатки', severity: 'minor', criteria: { cmd: 'true' } },
    ];
    const created = applyPilotFindings(journal, project, findings);
    assert.equal(created.length, 2);
    assert.equal(created[0].type, 'pilot_fix');
    assert.equal(created[0].role, 'coder');
    assert.deepEqual(created[0].criteria, findings[0].criteria);
    assert.equal(hasBlockers(findings), true);
    assert.equal(hasBlockers([findings[1]]), false);

    journal.close();
  } finally {
    env.cleanup();
  }
});
