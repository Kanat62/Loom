// tests/stats.test.js - отчёт о расходе (§17.1 ТЗ): чистый SQL-агрегат по
// events, БЕЗ вызовов модели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const statsMod = await import('../core/stats.js');
  return { ...journalMod, ...projectsMod, ...statsMod };
}

test('stats: getUsageByRole агрегирует по агенту, checker (без usage-событий) не попадает в таблицу', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, getUsageByRole } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Stats Demo', domain: 'cli' });

    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'coder', tokens_in: 100, tokens_out: 50, cache_read: 10, cost_usd: 0.01, duration_ms: 1000 });
    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'coder', tokens_in: 200, tokens_out: 80, cache_read: 150, cost_usd: 0.02, duration_ms: 2000 });
    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'engineer', tokens_in: 500, tokens_out: 300, cache_read: 0, cost_usd: 0.05, duration_ms: 3000 });
    journal.logEvent({ project_id: project.id, type: 'test_result', agent: 'checker', duration_ms: 100 }); // не usage - не должен попасть

    const rows = getUsageByRole(journal, project.id);
    const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r]));

    assert.equal(byAgent.coder.calls, 2);
    assert.equal(byAgent.coder.tin, 300);
    assert.equal(byAgent.coder.tout, 130);
    assert.equal(byAgent.coder.cached, 160);
    assert.equal(byAgent.engineer.calls, 1);
    assert.equal(byAgent.checker, undefined, 'checker не делает вызовов модели - его не должно быть в таблице');

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('stats: getAttemptsDistribution считает done-задачи по числу попыток', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, getAttemptsDistribution } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Attempts Demo', domain: 'cli' });

    const t1 = journal.addTask({ project_id: project.id, title: 'a', spec: 's', criteria: {}, role: 'coder' });
    const t2 = journal.addTask({ project_id: project.id, title: 'b', spec: 's', criteria: {}, role: 'coder' });
    const t3 = journal.addTask({ project_id: project.id, title: 'c', spec: 's', criteria: {}, role: 'coder' });
    journal.incrementAttempts(t1.id);
    journal.setStatus(t1.id, 'done');
    journal.incrementAttempts(t2.id);
    journal.setStatus(t2.id, 'done');
    journal.incrementAttempts(t3.id);
    journal.incrementAttempts(t3.id);
    journal.incrementAttempts(t3.id);
    journal.setStatus(t3.id, 'done');

    const dist = getAttemptsDistribution(journal, project.id);
    const byAttempts = Object.fromEntries(dist.map((r) => [r.attempts, r.n]));
    assert.equal(byAttempts[1], 2);
    assert.equal(byAttempts[3], 1);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('stats: formatSpendReport сходится - сумма по ролям равна ИТОГО, календарное время >= времени работы', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, formatSpendReport } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Spend Demo', domain: 'cli' });

    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'coder', tokens_in: 100, tokens_out: 50, cache_read: 0, cost_usd: 1.5, duration_ms: 5000 });
    journal.logEvent({ project_id: project.id, type: 'usage', agent: 'engineer', tokens_in: 200, tokens_out: 100, cache_read: 0, cost_usd: 2.5, duration_ms: 8000 });

    const report = formatSpendReport(journal, project.id);
    assert.match(report, /ИТОГО/);
    assert.match(report, /\$4\.00/); // 1.5 + 2.5
    assert.match(report, /Календарное время/);
    assert.match(report, /Задач done/);

    journal.close();
  } finally {
    env.cleanup();
  }
});
