#!/usr/bin/env node
// bin/talk.js - главная сессия (§0.1 гайда). Человек пишет в ОДНУ сессию,
// Инженер сам различает build/question/tweak (§3.1 ТЗ v5.2 - слитая роль,
// Наставник отложен вместе с памятью, отдельного канала нет).
import crypto from 'node:crypto';
import { createJournal } from '../core/journal.js';
import { createProject, listProjects, getProject, setProjectStatus, setProjectDomain } from '../core/projects.js';
import { runLoopWithCheckpoints, runLoop, canDeliver } from '../core/coordinator.js';
import {
  runUnderstandWithQuestionFilter,
  runDesignDirection,
  saveDesignSystem,
  loadDesignSystem,
  planProject,
  runReport,
} from '../agents/engineer.js';
import { runPilot, applyPilotFindings, hasBlockers, requiresVisualBlock } from '../agents/pilot.js';
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
      io.write(`    - ${t.id} [${t.status}] (${t.type}${t.core_check ? ', core' : ''}, attempts=${t.attempts}) ${t.title}\n`);
    }
  }
}

function help() {
  io.write(
    [
      'Пишите желаемый результат, вопрос о проекте или мелкую правку обычным текстом -',
      'Инженер сам разберёт, что это (build/question/tweak).',
      '',
      'Команды:',
      '  /status, /projects   - список проектов и задач',
      '  /project <id>        - выбрать активный проект',
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
 * proceedToPlan - режим "План" Инженера + прогон дерева задач с checkpoint'ами
 * (§3.2 ТЗ v5.2). Вызывается либо сразу после "утверждаю" (domain != 'ui'),
 * либо после выбора направления дизайна (domain === 'ui').
 */
async function proceedToPlan(project) {
  io.write('Инженер проектирует дерево задач...\n');
  const spec = journal.getProductSpec(project.id);
  const runId = crypto.randomUUID();
  const { plan, tasks, spikeTask, regressionTask, uncoveredReadiness, uncoveredCoreChecks } = await planProject({
    project,
    productSpec: spec,
    journal,
    runId,
  });

  io.write(`\n# Approach\nВыбрано: ${plan.approach?.chosen ?? '(не указано)'}\nПочему: ${plan.approach?.why ?? '(не указано)'}\n`);
  if (spikeTask) {
    io.write(`\n[loom] Рискованное допущение обнаружено - разведзадача ${spikeTask.id} блокирует всё дерево до своего решения.\n`);
  }
  io.write(`\nЗадач: ${tasks.length}${regressionTask ? ' + регрессия' : ''}\n`);
  if (uncoveredReadiness.length > 0) {
    io.write(`\n[loom] ВНИМАНИЕ: признаки готовности без покрытия задачей:\n${uncoveredReadiness.map((r) => `  - ${r}`).join('\n')}\n`);
  }
  if (uncoveredCoreChecks.length > 0) {
    io.write(
      `\n[loom] ВНИМАНИЕ (правило 13): core-признаки без критерия целого (core_check):\n${uncoveredCoreChecks.map((r) => `  - ${r}`).join('\n')}\n`
    );
  }

  io.write('\nВыполняю дерево задач (со сверками целого между задачами)...\n');
  const designSystem = loadDesignSystem(project.id);
  const { results, stopped, stopReason } = await runLoopWithCheckpoints({ journal, project, productSpec: spec, designSystem, runId });
  for (const r of results) {
    if (r.checkpoint) {
      io.write(`  [checkpoint] on_track=${r.on_track} ${r.drift ? `drift: ${r.drift}` : ''} (actions: ${r.applied.length})\n`);
      continue;
    }
    io.write(`  ${r.taskId} [${r.title}] -> ${r.verdict}${r.report ? `\n    ${r.report.split('\n')[0]}` : ''}\n`);
  }

  if (stopped) {
    setProjectStatus(journal, project.id, 'active');
    journal.logEvent({
      run_id: runId,
      project_id: project.id,
      type: 'status',
      agent: 'engineer',
      payload: { kind: 'checkpoint_stopped_pipeline', stopReason },
    });
    io.write(`\n[loom] Конвейер ОСТАНОВЛЕН сверкой целого: ${stopReason}\nПродукт НЕ сдан - нужно решение человека или продолжение доработки.\n`);
    return;
  }

  let pilotResult = null;
  const allTasks = journal.listTasks(project.id);
  const boardGreen = allTasks.length > 0 && allTasks.every((t) => t.status === 'done' || t.status === 'retired');

  if (!boardGreen) {
    io.write('\n[loom] Доска не полностью зелёная - Пилот не запускается (только после того, как всё пройдено).\n');
  } else {
    io.write('\nДоска зелёная. Пилот проходит сценарий продукта...\n');
    const pilotRunId = crypto.randomUUID();
    pilotResult = await runPilot({ project, productSpec: spec, journal, runId: pilotRunId });
    journal.logEvent({
      run_id: pilotRunId,
      project_id: project.id,
      type: 'pilot',
      agent: 'pilot',
      payload: {
        findingsCount: pilotResult.findings.length,
        visual: pilotResult.visual,
        stepsDone: pilotResult.stepsDone ?? [],
        scriptFailed: pilotResult.scriptFailed ?? false,
      },
    });

    if (pilotResult.scriptFailed) {
      io.write(`[loom] Пилот не смог провести прогон честно: ${pilotResult.error}\n`);
    } else {
      if (!pilotResult.visual) {
        io.write('[loom] Пилот: визуальная часть НЕ проверена (браузер недоступен) - честно помечено, не имитация.\n');
      } else if (pilotResult.stepsDone?.length) {
        io.write(`Пилот прошёл шаги: ${pilotResult.stepsDone.join(' -> ')}\n`);
      }
      if (pilotResult.findings.length === 0) {
        io.write('Пилот не нашёл замечаний.\n');
      } else {
        const created = applyPilotFindings(journal, project, pilotResult.findings);
        io.write(`Пилот создал ${created.length} задач:\n`);
        for (const t of created) {
          io.write(`  [${t.severity}] ${t.id} ${t.title}\n`);
        }
        if (hasBlockers(pilotResult.findings)) io.write('\n[loom] ЕСТЬ BLOCKER-находки - сдача заблокирована до их исправления.\n');

        io.write('\nИсправляю находки Пилота...\n');
        const { results: fixResults } = await runLoop({ journal, projectId: project.id, role: 'coder', productSpec: spec, designSystem });
        for (const r of fixResults) {
          io.write(`  ${r.taskId} [${r.title}] -> ${r.verdict}${r.report ? `\n    ${r.report.split('\n')[0]}` : ''}\n`);
        }
      }
    }

    if (requiresVisualBlock(project, pilotResult)) {
      io.write(
        '\n[loom] visual:false для UI-продукта - второй контур недоступен: продукт не проверен глазами.\n' +
          'Установите: `npx playwright install chromium` и запустите доработку снова.\n'
      );
    }
  }

  io.write('\nИнженер готовит отчёт о сдаче...\n');
  const reportRunId = crypto.randomUUID();
  const report = await runReport({ project, productSpec: spec, journal, runId: reportRunId });
  io.write(`\n${'='.repeat(60)}\n${report}\n${'='.repeat(60)}\n`);

  const finalTasks = journal.listTasks(project.id);
  const verdict = canDeliver({ project: journal.getProject(project.id), productSpec: spec, tasks: finalTasks, pilotResult });

  setProjectStatus(journal, project.id, verdict.ok ? 'delivered' : 'active');
  if (verdict.ok) {
    io.write('\n[loom] Проект сдан. Статус: delivered.\n');
  } else {
    io.write(`\n[loom] Проект НЕ сдан:\n${verdict.reasons.map((r) => `  - ${r}`).join('\n')}\n`);
  }
}

async function handleVerdict(line) {
  const productSpec = journal.getProductSpec(active.id);

  if (line === 'утверждаю') {
    journal.approveProductSpec(active.id);
    setProjectStatus(journal, active.id, 'active');

    const projectRow = journal.getProject(active.id); // domain мог быть проставлен Инженером
    if (projectRow.domain === 'ui') {
      io.write('ТЗ утверждено. Инженер подбирает направление дизайна...\n');
      const runId = crypto.randomUUID();
      const spec = journal.getProductSpec(active.id);
      const designResult = await runDesignDirection({ project: active, productSpec: spec, journal, runId });

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

    await proceedToPlan(active);
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
    let result = await runUnderstandWithQuestionFilter({ transcript, project: active, productSpec, editInstruction: editText, journal, runId });

    if (result.route !== 'build' || result.status !== 'ready' || !result.product_spec_md) {
      io.write('Инженер не смог внести правку корректно. Переформулируйте.\n');
      return;
    }

    let violations = findUntouchedViolations(productSpec.spec_md, result.product_spec_md, result.changed_sections);
    if (violations.length > 0) {
      const retry = await runUnderstandWithQuestionFilter({
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
      core_intent: result.core_intent ?? productSpec.core_intent,
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
  const result = await runUnderstandWithQuestionFilter({ transcript, project: active, productSpec, journal, runId });

  if (result.route === 'question') {
    io.write(`${result.answer ?? '(Инженер не дал ответа - переформулируйте вопрос)'}\n`);
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
      io.write('Инженер не дал полную задачу для правки - переформулируйте.\n');
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
      io.write('Инженер не задал вопросов и не выдал готовое ТЗ - переформулируйте запрос.\n');
      resetInterview();
      return;
    }
    transcript.push({ from: 'engineer', text: result.questions.join(' ') });
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
    core_intent: result.core_intent ?? null,
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
    const designResult = await runDesignDirection({ project: active, productSpec: spec, journal, runId, chosenDirection: choice.name });
    saveDesignSystem(active.id, designResult);
    io.write(`Дизайн-система готова: ${designResult.direction ?? choice.name}\n`);
    await proceedToPlan(active);
    resetInterview();
    continue;
  }

  await handleFreeText(line);
}

io.close();
journal.close();
process.exit(0);
