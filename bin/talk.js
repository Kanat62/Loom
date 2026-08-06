#!/usr/bin/env node
// bin/talk.js - главная сессия (§0.1 гайда). Человек пишет в ОДНУ сессию,
// Аналитик сам различает build/question/tweak/mentor (§1.1 ТЗ) - отдельной
// команды "задать вопрос" не существует.
import crypto from 'node:crypto';
import { createJournal } from '../core/journal.js';
import { createProject, listProjects, getProject, setProjectStatus, setProjectDomain } from '../core/projects.js';
import { runLoop } from '../core/coordinator.js';
import { runAnalystWithQuestionFilter } from '../agents/analyst.js';
import { planProject } from '../agents/architect.js';
import { runDesigner, saveDesignSystem, loadDesignSystem } from '../agents/designer.js';
import { runPilot, applyPilotFindings, hasBlockers } from '../agents/pilot.js';
import { runConsultant } from '../agents/consultant.js';
import { runMentor, applyCorrection } from '../agents/mentor.js';
import { confirmAndSaveLesson } from '../core/lessons.js';
import { findUntouchedViolations } from '../core/productSpec.js';
import { createIO } from '../core/io.js';

const journal = await createJournal();
const io = createIO();

let active = null;
let mode = 'idle'; // idle | interviewing | awaiting_verdict | awaiting_design_direction
let transcript = [];
let pendingDesignOptions = [];

function printStatus() {
  const projects = listProjects(journal);
  if (projects.length === 0) {
    io.write('Проектов нет. Просто опишите желаемый результат.\n');
    return;
  }
  for (const p of projects) {
    const marker = active && active.id === p.id ? '*' : ' ';
    io.write(`${marker} ${p.id}  [${p.status}] ${p.title}\n`);
    for (const t of journal.listTasks(p.id)) {
      io.write(`    - ${t.id} [${t.status}] (attempts=${t.attempts}) ${t.title}\n`);
    }
  }
}

function help() {
  io.write(
    [
      'Пишите желаемый результат, вопрос о проекте или мелкую правку обычным текстом -',
      'Аналитик сам разберёт, что это (build/question/tweak/mentor).',
      '',
      'Команды:',
      '  /status, /projects   - список проектов и задач',
      '  /project <id>        - выбрать активный проект',
      '  /mentor              - канал Наставника (Фаза 9)',
      '  /help                - эта справка',
      '  /exit                - выход',
      '',
    ].join('\n')
  );
}

function resetInterview() {
  mode = 'idle';
  transcript = [];
}

help();
printStatus();

const released = journal.releaseStuck();
if (released > 0) {
  io.write(`[loom] releaseStuck: возвращено в pending задач: ${released}\n`);
}

const pendingApproval = listProjects(journal).find((p) => p.status === 'awaiting_approval');
if (pendingApproval) {
  active = pendingApproval;
  const spec = journal.getProductSpec(active.id);
  io.write(
    `\n[loom] Проект "${active.title}" (${active.id}) ждёт вашего решения по product_spec:\n\n${spec.spec_md}\n\nОтветьте: утверждаю / правка: <текст> / отмена\n`
  );
  mode = 'awaiting_verdict';
}

function resolveDirectionChoice(line, options) {
  const trimmed = line.trim();
  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1];
  }
  const lower = trimmed.toLowerCase();
  return options.find((o) => o.name.toLowerCase().includes(lower) || lower.includes(o.name.toLowerCase())) ?? null;
}

/**
 * proceedToArchitect - Архитектор + прогон дерева задач. Вызывается либо
 * сразу после "утверждаю" (domain != 'ui'), либо после выбора направления
 * Дизайнером (domain === 'ui').
 */
async function proceedToArchitect(project) {
  io.write('Архитектор проектирует дерево задач...\n');
  const spec = journal.getProductSpec(project.id);
  const runId = crypto.randomUUID();
  const { plan, tasks, regressionTask, uncoveredReadiness } = await planProject({ project, productSpec: spec, journal, runId });

  io.write(`\n# Approach\nВыбрано: ${plan.approach?.chosen ?? '(не указано)'}\nПочему: ${plan.approach?.why ?? '(не указано)'}\n`);
  io.write(`\nЗадач: ${tasks.length}${regressionTask ? ' + регрессия' : ''}\n`);
  if (uncoveredReadiness.length > 0) {
    io.write(`\n[loom] ВНИМАНИЕ: признаки готовности без покрытия задачей:\n${uncoveredReadiness.map((r) => `  - ${r}`).join('\n')}\n`);
  }

  io.write('\nВыполняю дерево задач...\n');
  const designSystem = loadDesignSystem(project.id);
  const { results } = await runLoop({ journal, projectId: project.id, role: 'coder', productSpec: spec, designSystem });
  for (const r of results) {
    io.write(`  ${r.taskId} [${r.title}] -> ${r.verdict}${r.report ? `\n    ${r.report.split('\n')[0]}` : ''}\n`);
  }

  let blockers = false;
  const allTasks = journal.listTasks(project.id);
  const boardGreen = allTasks.length > 0 && allTasks.every((t) => t.status === 'done');

  if (!boardGreen) {
    io.write('\n[loom] Доска не полностью зелёная - Пилот не запускается (§9 ТЗ: только после того, как всё пройдено).\n');
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
}

async function handleVerdict(line) {
  const productSpec = journal.getProductSpec(active.id);

  if (line === 'утверждаю') {
    journal.approveProductSpec(active.id);
    setProjectStatus(journal, active.id, 'active');

    const projectRow = journal.getProject(active.id); // domain мог быть проставлен Аналитиком
    if (projectRow.domain === 'ui') {
      io.write('ТЗ утверждено. Дизайнер подбирает направление...\n');
      const runId = crypto.randomUUID();
      const spec = journal.getProductSpec(active.id);
      const designResult = await runDesigner({ project: active, productSpec: spec, journal, runId });

      if (designResult.status === 'choose_direction' && designResult.options?.length) {
        pendingDesignOptions = designResult.options;
        io.write(
          `\nВыберите направление дизайна (единственный дизайн-вопрос):\n${designResult.options
            .map((o, i) => `${i + 1}. ${o.name} - ${o.description}`)
            .join('\n')}\n`
        );
        mode = 'awaiting_design_direction';
        return;
      }

      saveDesignSystem(active.id, designResult);
      io.write(`Дизайн-система готова: ${designResult.direction ?? '(без названия)'} (${designResult.reference_note ?? ''})\n`);
    }

    await proceedToArchitect(active);
    resetInterview();
    return;
  }

  if (line === 'отмена') {
    setProjectStatus(journal, active.id, 'cancelled');
    io.write(`Проект ${active.id} отменён.\n`);
    active = null;
    resetInterview();
    return;
  }

  if (line.startsWith('правка:')) {
    const editText = line.slice('правка:'.length).trim();
    const runId = crypto.randomUUID();
    let result = await runAnalystWithQuestionFilter({ transcript, project: active, productSpec, editInstruction: editText, journal, runId });

    if (result.route !== 'build' || result.status !== 'ready' || !result.product_spec_md) {
      io.write('Аналитик не смог внести правку корректно. Переформулируйте.\n');
      return;
    }

    let violations = findUntouchedViolations(productSpec.spec_md, result.product_spec_md, result.changed_sections);
    if (violations.length > 0) {
      // §1.1 ТЗ: расхождение -> ОДНА повторная попытка -> честный отказ.
      const retry = await runAnalystWithQuestionFilter({
        transcript,
        project: active,
        productSpec,
        editInstruction: `${editText}\n\n[ВАЖНО] В прошлый раз ты тихо изменил секции ${violations.join(', ')}, хотя тебя об этом не просили. Верни их ДОСЛОВНО как было, поменяй только заявленное.`,
        journal,
        runId,
      });
      const violations2 = findUntouchedViolations(productSpec.spec_md, retry.product_spec_md ?? '', retry.changed_sections);
      if (!retry.product_spec_md || violations2.length > 0) {
        io.write(
          'Честный отказ: не удалось внести точечную правку без изменения остальных секций дважды подряд. Сформулируйте иначе или отмените (`отмена`).\n'
        );
        return;
      }
      result = retry;
    }

    journal.saveProductSpec({
      project_id: active.id,
      spec_md: result.product_spec_md,
      readiness: result.readiness,
      engineering_defaults: result.engineering_defaults,
    });
    io.write(`\nОбновлённое ТЗ:\n\n${result.product_spec_md}\n\nОтветьте: утверждаю / правка: <текст> / отмена\n`);
    return;
  }

  io.write('Ответьте: утверждаю / правка: <текст> / отмена\n');
}

async function handleFreeText(line) {
  transcript.push({ from: 'human', text: line });
  const runId = crypto.randomUUID();
  const productSpec = active ? journal.getProductSpec(active.id) : null;
  const result = await runAnalystWithQuestionFilter({ transcript, project: active, productSpec, journal, runId });

  if (result.route === 'question') {
    io.write(`${result.answer ?? '(Аналитик не дал ответа - переформулируйте вопрос)'}\n`);
    resetInterview();
    return;
  }

  if (result.route === 'mentor') {
    io.write('Это про сам LOOM - канал Наставника появится в Фазе 9. Пока используйте `npm run mentor` позже.\n');
    resetInterview();
    return;
  }

  if (result.route === 'tweak') {
    if (!active) {
      io.write('Для правки нужен активный проект: /project <id>\n');
      resetInterview();
      return;
    }
    const t = result.task;
    if (!t?.title || !t?.spec || !t?.criteria) {
      io.write('Аналитик не дал полную задачу для правки - переформулируйте.\n');
      resetInterview();
      return;
    }
    const task = journal.addTask({
      project_id: active.id,
      title: t.title,
      spec: t.spec,
      criteria: t.criteria,
      role: 'coder',
      type: 'tweak',
      touches_files: t.touches_files ?? [],
    });
    io.write(`Задача создана: ${task.id}. Выполняю...\n`);
    const productSpecForRun = journal.getProductSpec(active.id);
    const { results } = await runLoop({ journal, projectId: active.id, role: 'coder', productSpec: productSpecForRun });
    for (const r of results) {
      io.write(`  ${r.taskId} -> ${r.verdict}${r.report ? `\n    ${r.report.split('\n')[0]}` : ''}\n`);
      if (r.verdict === 'question') io.write(`  Вопрос от Исполнителя: ${r.question}\n`);
    }
    resetInterview();
    return;
  }

  // route === 'build'
  if (result.status === 'clarifying') {
    if (!result.questions?.length) {
      io.write('Аналитик не задал вопросов и не выдал готовое ТЗ - переформулируйте запрос.\n');
      resetInterview();
      return;
    }
    transcript.push({ from: 'analyst', text: result.questions.join(' ') });
    io.write(`${result.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`);
    mode = 'interviewing';
    return;
  }

  // status === 'ready'
  if (!active) {
    active = createProject(journal, { title: result.project_title || 'Новый проект', domain: result.domain ?? null });
  } else if (result.domain) {
    setProjectDomain(journal, active.id, result.domain);
    active = journal.getProject(active.id);
  }
  journal.saveProductSpec({
    project_id: active.id,
    spec_md: result.product_spec_md,
    readiness: result.readiness,
    engineering_defaults: result.engineering_defaults,
  });
  setProjectStatus(journal, active.id, 'awaiting_approval');
  io.write(`\nПроект ${active.id}\n\n${result.product_spec_md}\n\nОтветьте: утверждаю / правка: <текст> / отмена\n`);
  mode = 'awaiting_verdict';
  transcript = [];
}

let running = true;
while (running) {
  const line = await io.ask('\nloom> ');
  if (!line) continue;

  if (line === '/exit') {
    running = false;
    continue;
  }
  if (line === '/status' || line === '/projects') {
    printStatus();
    continue;
  }
  if (line === '/help') {
    help();
    continue;
  }
  if (line === '/mentor') {
    // §12.1 ТЗ, Режим A: инициатива всегда человека. Координатор в v1
    // синхронный (без параллельных runLoop) - "пауза после текущей задачи"
    // реализована как "разговор происходит между вызовами runLoop", не как
    // прерывание процесса в момент вызова модели (задокументировано в DECISIONS.md).
    const msg = await io.ask('Что не так? (пусто - отмена): ');
    if (!msg) {
      continue;
    }
    const remember = /запомни/i.test(msg);
    const runId = crypto.randomUUID();
    const productSpec = active ? journal.getProductSpec(active.id) : null;
    const result = await runMentor({ mode: 'A', humanMessage: msg, project: active, productSpec, remember, journal, runId });
    io.write(`\nнаставник> ${result.reply ?? '(нет ответа)'}\n`);

    if (active && result.correction) {
      const applied = applyCorrection(journal, active, result.correction);
      if (applied.applied) {
        io.write(`Применено: ${applied.target}${applied.taskId ? ` (${applied.taskId})` : ''}.\n`);
      }
    }

    if (result.lesson_draft) {
      const { scope, text, origin } = result.lesson_draft;
      io.write(`\nПредлагаемый урок:\n  scope: ${scope}\n  text: ${text}\n  origin: ${origin}\n`);
      const verdict = await io.ask('Подтвердить и записать в постоянную память? (да/нет): ');
      if (verdict.trim().toLowerCase() === 'да') {
        const saved = confirmAndSaveLesson(journal, { scope, text, origin });
        io.write(saved.saved ? 'Урок записан.\n' : `Урок НЕ записан: ${saved.reason}.\n`);
      } else {
        io.write('Урок не записан.\n');
      }
    }
    continue;
  }
  if (line.startsWith('/project ')) {
    const id = line.slice('/project '.length).trim();
    const p = getProject(journal, id);
    if (!p) {
      io.write(`Проект не найден: ${id}\n`);
      continue;
    }
    active = p;
    resetInterview();
    io.write(`Активный проект: ${active.id}\n`);
    continue;
  }

  if (mode === 'awaiting_verdict') {
    await handleVerdict(line);
    continue;
  }

  if (mode === 'awaiting_design_direction') {
    const choice = resolveDirectionChoice(line, pendingDesignOptions);
    if (!choice) {
      io.write('Не разобрал выбор - введите номер или название направления из списка.\n');
      continue;
    }
    const runId = crypto.randomUUID();
    const spec = journal.getProductSpec(active.id);
    const designResult = await runDesigner({ project: active, productSpec: spec, journal, runId, chosenDirection: choice.name });
    saveDesignSystem(active.id, designResult);
    io.write(`Дизайн-система готова: ${designResult.direction ?? choice.name}\n`);
    await proceedToArchitect(active);
    resetInterview();
    continue;
  }

  await handleFreeText(line);
}

io.close();
journal.close();
process.exit(0);
