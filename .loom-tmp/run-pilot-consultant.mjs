import crypto from 'node:crypto';
import { createJournal } from '../core/journal.js';
import { getProject, setProjectStatus } from '../core/projects.js';
import { runLoop } from '../core/coordinator.js';
import { runPilot, applyPilotFindings, hasBlockers } from '../agents/pilot.js';
import { runConsultant } from '../agents/consultant.js';
import { loadDesignSystem } from '../agents/designer.js';
import { createIO } from '../core/io.js';

const journal = await createJournal();
const io = createIO();
const project = getProject(journal, 'project-9a4158');
const spec = journal.getProductSpec(project.id);
const designSystem = loadDesignSystem(project.id);

let blockers = false;
const allTasks = journal.listTasks(project.id);
const boardGreen = allTasks.length > 0 && allTasks.every((t) => t.status === 'done');

if (!boardGreen) {
  io.write('\n[loom] Доска не полностью зелёная - Пилот не запускается.\n');
  blockers = true;
} else {
  io.write('\nДоска зелёная. Пилот проходит сценарий продукта...\n');
  const pilotRunId = crypto.randomUUID();
  const pilotResult = await runPilot({ project, productSpec: spec, journal, runId: pilotRunId });
  journal.logEvent({
    run_id: pilotRunId,
    project_id: project.id,
    type: 'pilot',
    agent: 'pilot',
    payload: { findingsCount: pilotResult.findings.length, visual: pilotResult.visual, scriptFailed: pilotResult.scriptFailed ?? false },
  });

  if (pilotResult.scriptFailed) {
    io.write(`[loom] Пилот не смог провести прогон честно: ${pilotResult.error}\n`);
  } else {
    if (!pilotResult.visual) {
      io.write('[loom] Пилот: визуальная часть НЕ проверена (браузер недоступен) - честно помечено, не имитация.\n');
    }
    if (pilotResult.findings.length === 0) {
      io.write('Пилот не нашёл замечаний.\n');
    } else {
      const created = applyPilotFindings(journal, project, pilotResult.findings);
      io.write(`Пилот создал ${created.length} задач:\n`);
      for (const t of created) {
        io.write(`  [${t.severity}] ${t.id} ${t.title}\n`);
      }
      blockers = hasBlockers(pilotResult.findings);
      if (blockers) io.write('\n[loom] ЕСТЬ BLOCKER-находки - сдача заблокирована до их исправления.\n');

      io.write('\nИсправляю находки Пилота...\n');
      const { results: fixResults } = await runLoop({ journal, projectId: project.id, role: 'coder', productSpec: spec, designSystem });
      for (const r of fixResults) {
        io.write(`  ${r.taskId} [${r.title}] -> ${r.verdict}${r.report ? `\n    ${r.report.split('\n')[0]}` : ''}\n`);
      }
    }
  }
}

const finalTasks = journal.listTasks(project.id);
const stillBlocked = finalTasks.some((t) => t.status === 'blocked_needs_human');
blockers = blockers || stillBlocked;

io.write('\nКонсультант готовит отчёт о сдаче...\n');
const consultantRunId = crypto.randomUUID();
const report = await runConsultant({ project, productSpec: spec, journal, runId: consultantRunId });
io.write(`\n${'='.repeat(60)}\n${report}\n${'='.repeat(60)}\n`);

setProjectStatus(journal, project.id, blockers ? 'active' : 'delivered');
io.write(blockers ? '\n[loom] Проект НЕ сдан - есть незакрытые вопросы (см. отчёт выше).\n' : '\n[loom] Проект сдан. Статус: delivered.\n');

await journal.close();
