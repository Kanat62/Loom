#!/usr/bin/env node
// bin/resume.js - поднять доску и доработать после перерыва или падения
// (§0.1 гайда). Команда процессу, а не сообщение LOOM - классифицировать
// нечего, Аналитик здесь не участвует.
import { createJournal } from '../core/journal.js';
import { listProjects } from '../core/projects.js';
import { runLoop } from '../core/coordinator.js';

const journal = await createJournal();

const released = journal.releaseStuck();
console.log(`[loom] releaseStuck: возвращено в pending задач: ${released}`);

const projects = listProjects(journal).filter((p) => p.status === 'active' || p.status === 'awaiting_approval');

if (projects.length === 0) {
  console.log('[loom] Нет активных проектов.');
}

for (const project of projects) {
  if (project.status === 'awaiting_approval') {
    console.log(`[loom] Проект "${project.title}" (${project.id}) ждёт решения по product_spec - запустите npm run talk.`);
    continue;
  }

  const pending = journal.listTasks(project.id, { status: 'pending' }).filter((t) => t.role === 'coder');
  if (pending.length === 0) continue;

  console.log(`[loom] Проект "${project.title}" (${project.id}): ${pending.length} задач в очереди, выполняю...`);
  const productSpec = journal.getProductSpec(project.id);
  const { results } = await runLoop({ journal, projectId: project.id, role: 'coder', productSpec });
  for (const r of results) {
    console.log(`  ${r.taskId} [${r.title}] -> ${r.verdict}`);
  }
}

journal.close();
process.exit(0);
