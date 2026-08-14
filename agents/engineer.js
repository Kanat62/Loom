// agents/engineer.js - Инженер (§1.1 ТЗ v5.2): Аналитик + Архитектор +
// Консультант + свод правил Дизайнера слиты в одну голову (шрам 44/45).
// Четыре обязанности, разные "режимы" вызова через один и тот же system-
// промпт (prompts/engineer.md): Понимание, Дизайн-направление, План,
// Сверка целого (checkpoint), Сдача.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { PROMPTS_DIR } from '../core/config.js';
import { chat, GatewayError } from '../core/gateway.js';
import { snapshotWorkspace } from '../core/context.js';
import { runSingleCheck, extractNodeEvalBody } from '../core/checkRunner.js';
import { runProcess } from '../core/spawnUtil.js';
import { workspaceDir, setProjectDomain } from '../core/projects.js';
import { getHeroUIDocs } from '../core/herouiDocs.js';
import { formatSpendReport } from '../core/stats.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'engineer.md'), 'utf8');

function readinessText(r) {
  return typeof r === 'string' ? r : r?.text;
}
function readinessTier(r) {
  return typeof r === 'string' ? 'support' : r?.tier ?? 'support';
}

// ============================================================================
// Режим: Понимание (было agents/analyst.js)
// ============================================================================

// §3.1 ТЗ v5.2 (было §1.1.1) - regex-фильтр технических вопросов, ОБЯЗАТЕЛЕН
// в коде (шрам 15). Без \b (не работает на кириллице, §19.11 ТЗ).
const FORBIDDEN_PATTERNS = [
  { source: 'числа с единицами (px/мс/сек/fps/КБ/МБ/%/°)', re: /\d+\s?(пикс|px|мс|ms|сек|fps|кб|мб|%|°)/i },
  {
    source: 'названия технологий',
    re: /react|node\.?js|sql|api\b|css|http|ffmpeg|база данных|фреймворк|библиотек|алгоритм|формат[ае]?\b|протокол|кодек|сервер|хостинг/i,
  },
  { source: 'формулировка выбора реализации', re: /какой из|использовать ли|нужно ли делать через/i },
];

export function findForbiddenQuestion(questions) {
  for (const q of questions ?? []) {
    for (const { source, re } of FORBIDDEN_PATTERNS) {
      if (re.test(q)) return { question: q, reason: source };
    }
  }
  return null;
}

function buildUnderstandPrompt({ transcript, project, productSpec, editInstruction }) {
  const parts = ['# Режим: Понимание'];
  if (project) {
    parts.push(
      `# Активный проект\nid=${project.id} title="${project.title}" domain=${project.domain ?? '(не определён)'} status=${project.status}`
    );
    if (productSpec?.spec_md) {
      parts.push(`# Существующий product_spec\n${productSpec.spec_md}`);
    }
    parts.push(`# Снимок workspace\n${snapshotWorkspace(project.id)}`);
  } else {
    parts.push('# Активного проекта нет. Это новый build.');
  }
  if (editInstruction) {
    parts.push(
      `# Инструкция по правке product_spec\nЧеловек попросил: "${editInstruction}"\nВнеси ТОЛЬКО это изменение, остальные секции верни дословно как было. Заполни changed_sections.`
    );
  }
  parts.push(`# Переписка с человеком (по порядку)\n${transcript.map((t) => `[${t.from}] ${t.text}`).join('\n')}`);
  return parts.join('\n\n---\n\n');
}

const SAFE_FALLBACK = { route: 'build', status: 'clarifying', questions: [] };

/**
 * runUnderstand - один вызов режима "Понимание". Ошибка парсинга/шлюза ->
 * route='build' безопасным дефолтом (§3.1 ТЗ v5.2: ошибка классификации в
 * сторону build безопасна).
 */
export async function runUnderstand({ transcript, project = null, productSpec = null, editInstruction = null, journal, runId, gatewayOpts = {} }) {
  const userPrompt = buildUnderstandPrompt({ transcript, project, productSpec, editInstruction });
  try {
    const res = await chat(
      'engineer',
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      {
        json: true,
        projectId: project?.id ?? null,
        runId,
        logEvent: (e) => journal.logEvent(e),
        ...gatewayOpts,
      }
    );
    return res.data;
  } catch (err) {
    if (err instanceof GatewayError) {
      journal.logEvent({
        run_id: runId,
        project_id: project?.id ?? null,
        type: 'status',
        agent: 'engineer',
        payload: { kind: 'understand_fallback_to_build', error: err.message },
      });
      return SAFE_FALLBACK;
    }
    throw err;
  }
}

/**
 * runUnderstandWithQuestionFilter - как runUnderstand, но прогоняет questions[]
 * через regex-фильтр и перегенерирует до 2 раз при нарушении.
 */
export async function runUnderstandWithQuestionFilter(args) {
  let transcript = args.transcript;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runUnderstand({ ...args, transcript });
    if (result.route !== 'build' || result.status !== 'clarifying' || !result.questions?.length) {
      return result;
    }
    const hit = findForbiddenQuestion(result.questions);
    if (!hit) return result;

    args.journal.logEvent({
      run_id: args.runId,
      project_id: args.project?.id ?? null,
      type: 'status',
      agent: 'engineer',
      payload: { kind: 'regex_filter_hit', question: hit.question, reason: hit.reason },
    });

    if (attempt === 2) {
      const clean = result.questions.filter((q) => !findForbiddenQuestion([q]));
      return { ...result, questions: clean };
    }

    transcript = [
      ...transcript,
      {
        from: 'system',
        text: `Вопрос "${hit.question}" отклонён фильтром (${hit.reason}) - это технический вопрос. Спрашивай ТОЛЬКО о результате, ничего технического.`,
      },
    ];
  }
}

// ============================================================================
// Режим: Дизайн-направление (было agents/designer.js, свод дизайна в промпте)
// ============================================================================

function buildDesignPrompt({ productSpec, chosenDirection, herouiDocsText }) {
  const parts = ['# Режим: Дизайн-направление', `# product_spec продукта\n${productSpec.spec_md}`];
  if (chosenDirection) {
    parts.push(`# Человек выбрал направление\n"${chosenDirection}" - заверши дизайн-систему для него (status="ready").`);
  }
  parts.push(`# Актуальный индекс документации HeroUI v3 (React)\n${herouiDocsText}`);
  return parts.join('\n\n---\n\n');
}

/**
 * runDesignDirection - вызов режима "Дизайн-направление". Без chosenDirection -
 * либо сам находит референс в product_spec (status=ready сразу), либо
 * предлагает варианты (status=choose_direction). С chosenDirection - фиксирует
 * систему для него.
 */
export async function runDesignDirection({ project, productSpec, journal, runId, chosenDirection = null }) {
  const { text: herouiDocsText } = await getHeroUIDocs();
  const userPrompt = buildDesignPrompt({ productSpec, chosenDirection, herouiDocsText });

  const res = await chat(
    'engineer',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { json: true, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );
  return res.data;
}

/**
 * saveDesignSystem - записывает дизайн-систему в <project>/design/tokens.css
 * и DESIGN.md. Исполнитель получает этот блок ВСЕГДА ПОЛНОСТЬЮ.
 */
export function saveDesignSystem(projectId, result) {
  const dir = path.join(workspaceDir(projectId), 'design');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens.css'), result.tokens_css ?? '', 'utf8');

  const md = [
    `# Дизайн-система\n`,
    `## Направление\n${result.direction ?? ''}\n`,
    `## Обоснование (референс)\n${result.reference_note ?? ''}\n`,
    `## Правила для Исполнителя\n${(result.rules ?? []).map((r) => `- ${r}`).join('\n')}\n`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), md, 'utf8');

  return { tokensPath: path.join(dir, 'tokens.css'), designMdPath: path.join(dir, 'DESIGN.md') };
}

/** loadDesignSystem - блок для Исполнителя (§6.4 ТЗ - всегда полностью, не дельтой). */
export function loadDesignSystem(projectId) {
  const dir = path.join(workspaceDir(projectId), 'design');
  const tokensPath = path.join(dir, 'tokens.css');
  const mdPath = path.join(dir, 'DESIGN.md');
  if (!fs.existsSync(tokensPath) && !fs.existsSync(mdPath)) return null;

  const tokens = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, 'utf8') : '';
  const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  return `${md}\n\n## tokens.css\n\`\`\`css\n${tokens}\n\`\`\``;
}

// ============================================================================
// Режим: План (было agents/architect.js) + разведка (spike) + core_check
// ============================================================================

function buildPlanPrompt({ productSpec, feedback }) {
  const parts = ['# Режим: План', `# product_spec продукта\n${productSpec.spec_md}`];
  if (feedback) parts.push(`# Замечание к прошлой попытке (почини именно это)\n${feedback}`);
  return parts.join('\n\n---\n\n');
}

async function callEngineerPlan({ productSpec, project, journal, runId, feedback }) {
  const res = await chat(
    'engineer',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPlanPrompt({ productSpec, feedback }) },
    ],
    { json: true, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );
  return res.data;
}

/** allCriteriaBearing - задачи дерева + псевдо-задача разведки (если есть), для единой проверки синтаксиса. */
function allCriteriaBearing(plan) {
  const list = [...(plan.tasks ?? [])];
  const risky = plan.approach?.riskiest_assumption;
  if (risky?.how_to_check) {
    list.push({ title: 'Разведка (riskiest_assumption)', criteria: { cmd: risky.how_to_check } });
  }
  return list;
}

/**
 * findMalformedCriteria - защита от обрезанного вывода модели (найдено на
 * экзамене: длинный Playwright-критерий обрывался ровно до конца закрывающих
 * скобок async-IIFE). Синтаксическая проверка дешевле и честнее, чем ждать
 * пустой stdout от критерия, который физически не мог запуститься.
 */
function findMalformedCriteria(tasks) {
  const malformed = [];
  for (const t of tasks) {
    if (!t.criteria?.cmd) continue;
    const body = extractNodeEvalBody(t.criteria.cmd);
    if (body === null) continue;
    try {
      new vm.Script(body);
    } catch (err) {
      malformed.push({ title: t.title, error: err.message });
    }
  }
  return malformed;
}

/** precheckFictitious - §8.9 ТЗ, капкан на пустышки: критерий, уже проходящий ДО работы Исполнителя, фиктивен. */
async function precheckFictitious(tasks, cwd) {
  const fictitious = [];
  for (const t of tasks) {
    if (!t.criteria || t.criteria.regression_of) continue;
    try {
      const result = await runSingleCheck(t.criteria, { cwd });
      if (result.pass) fictitious.push(t.title);
    } catch {
      /* предпроверка сама не должна валить план */
    }
  }
  return fictitious;
}

// §8 правило 11 ТЗ v5.2 (шрам 41): для domain='ui' задачи, покрывающие
// признак готовности, обязаны реально открывать страницу, а не проверять
// исходник статически.
const BROWSER_HINT_RE = /playwright|chromium|puppeteer|getComputedStyle|getBoundingClientRect|pathToFileURL/i;

function findWeakUiCriteria(tasks, domain) {
  if (domain !== 'ui') return [];
  const weak = [];
  for (const t of tasks) {
    if (!t.covers || t.covers.length === 0) continue;
    if (!t.criteria?.cmd) continue;
    if (!BROWSER_HINT_RE.test(t.criteria.cmd)) weak.push(t.title);
  }
  return weak;
}

export function scaffoldPackageJson(dir, projectId) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) return;
  fs.writeFileSync(
    pkgPath,
    `${JSON.stringify({ name: projectId, version: '1.0.0', private: true, type: 'module' }, null, 2)}\n`,
    'utf8'
  );
}

/**
 * npmInstallGuarded - §19.12 ТЗ (шрам 36): npm install ТОЛЬКО в каталоге, где
 * уже есть package.json продукта.
 */
export async function npmInstallGuarded(dir, packages) {
  if (!packages || packages.length === 0) return { skipped: true };

  const prefixRes = await runProcess('npm', ['prefix'], { cwd: dir, timeoutMs: 30_000 });
  if (prefixRes.code !== 0) {
    throw new Error(`npm prefix упал: ${prefixRes.stderr.slice(0, 300)}`);
  }
  const actualPrefix = path.resolve(prefixRes.stdout.trim());
  const expected = path.resolve(dir);
  if (actualPrefix !== expected) {
    throw new Error(
      `npm prefix guard: ожидали "${expected}", получили "${actualPrefix}" - npm install ОТМЕНЁН (шрам 36: иначе npm правит манифест LOOM)`
    );
  }

  const installRes = await runProcess('npm', ['install', ...packages], { cwd: dir, timeoutMs: 300_000 });
  if (installRes.code !== 0) {
    throw new Error(`npm install упал: ${installRes.stderr.slice(0, 500)}`);
  }
  return { skipped: false };
}

/**
 * planProject - полный конвейер режима "План": вызов модели -> scaffold
 * package.json -> npm install (guard) -> предпроверки (malformed/fictitious/
 * weak-ui, по одной регенерации каждая) -> разведзадача (spike), если есть
 * riskiest_assumption, блокирующая всё дерево -> вставка дерева задач ->
 * регрессия последней задачей -> трассировка covers (readiness + core_check).
 */
export async function planProject({ project, productSpec, journal, runId = crypto.randomUUID() }) {
  const dir = workspaceDir(project.id);

  let plan = await callEngineerPlan({ productSpec, project, journal, runId });
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Инженер не вернул валидное дерево задач (пустой или некорректный ответ)');
  }

  let malformed = findMalformedCriteria(allCriteriaBearing(plan));
  if (malformed.length > 0) {
    journal.logEvent({
      run_id: runId,
      project_id: project.id,
      type: 'status',
      agent: 'engineer',
      payload: { kind: 'malformed_criteria', tasks: malformed.map((m) => m.title) },
    });
    plan = await callEngineerPlan({
      productSpec,
      project,
      journal,
      runId,
      feedback: `Критерии этих задач синтаксически НЕВАЛИДНЫ как JS (похоже на обрыв генерации на длинных критериях - проверь, что КАЖДЫЙ node -e критерий полностью закрыт: все скобки/фигурные скобки/кавычки): ${malformed
        .map((m) => `"${m.title}": ${m.error}`)
        .join('; ')}. Перепиши эти критерии полностью и убедись, что они синтаксически завершены.`,
    });
    if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      throw new Error('Инженер не вернул валидное дерево задач после регенерации из-за синтаксически битых критериев');
    }
    malformed = findMalformedCriteria(allCriteriaBearing(plan));
    if (malformed.length > 0) {
      journal.logEvent({
        run_id: runId,
        project_id: project.id,
        type: 'status',
        agent: 'engineer',
        payload: { kind: 'malformed_criteria_persist', tasks: malformed.map((m) => m.title) },
      });
    }
  }

  scaffoldPackageJson(dir, project.id);
  if (plan.domain) setProjectDomain(journal, project.id, plan.domain);
  if (plan.approach) journal.setApproach(project.id, plan.approach);

  if (plan.packages?.length) {
    try {
      await npmInstallGuarded(dir, plan.packages);
    } catch (err) {
      journal.logEvent({
        run_id: runId,
        project_id: project.id,
        type: 'status',
        agent: 'engineer',
        payload: { kind: 'npm_install_failed', packages: plan.packages, error: err.message.slice(0, 1000) },
      });
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
      fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });

      plan = await callEngineerPlan({
        productSpec,
        project,
        journal,
        runId,
        feedback: `Установка пакетов провалилась на этой машине - НАСТОЯЩАЯ ошибка npm install (не выдумывай другую причину):\n${err.message.slice(0, 800)}\n\nПакеты ${JSON.stringify(plan.packages)} не подходят (типичная причина - нужна нативная сборка C++/Visual Studio, которой на машине нет). Выбери ДРУГОЙ подход/пакеты, не требующие нативной компиляции.`,
      });
      if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        throw new Error('Инженер не вернул валидное дерево задач после регенерации из-за провала npm install');
      }
      if (plan.domain) setProjectDomain(journal, project.id, plan.domain);
      if (plan.approach) journal.setApproach(project.id, plan.approach);
      if (plan.packages?.length) {
        await npmInstallGuarded(dir, plan.packages);
      }
    }
  }

  let fictitious = await precheckFictitious(plan.tasks, dir);
  if (fictitious.length > 0) {
    journal.logEvent({
      run_id: runId,
      project_id: project.id,
      type: 'status',
      agent: 'engineer',
      payload: { kind: 'fictitious_criteria', tasks: fictitious },
    });
    plan = await callEngineerPlan({
      productSpec,
      project,
      journal,
      runId,
      feedback: `Критерии этих задач уже проходят на пустом workspace ДО работы Исполнителя - они фиктивны (§8.9 ТЗ): ${fictitious.join(', ')}. Перепиши их так, чтобы они проверяли ЕЩЁ НЕ СДЕЛАННУЮ работу.`,
    });
    fictitious = await precheckFictitious(plan.tasks, dir);
    if (fictitious.length > 0) {
      journal.logEvent({
        run_id: runId,
        project_id: project.id,
        type: 'status',
        agent: 'engineer',
        payload: { kind: 'fictitious_criteria_persist', tasks: fictitious },
      });
    }
  }

  let weakUi = findWeakUiCriteria(plan.tasks, plan.domain);
  if (weakUi.length > 0) {
    journal.logEvent({
      run_id: runId,
      project_id: project.id,
      type: 'status',
      agent: 'engineer',
      payload: { kind: 'weak_ui_criteria', tasks: weakUi },
    });
    plan = await callEngineerPlan({
      productSpec,
      project,
      journal,
      runId,
      feedback: `Критерии этих задач покрывают признак готовности, но НЕ открывают страницу в браузере (правило 11, §8 ТЗ v5.2) - проверка исходника/разметки статически НЕ считается проверкой UI: ${weakUi.join(
        ', '
      )}. Перепиши их через Playwright (getComputedStyle/getBoundingClientRect/DOM), не регулярками по HTML.`,
    });
    weakUi = findWeakUiCriteria(plan.tasks, plan.domain);
    if (weakUi.length > 0) {
      journal.logEvent({
        run_id: runId,
        project_id: project.id,
        type: 'status',
        agent: 'engineer',
        payload: { kind: 'weak_ui_criteria_persist', tasks: weakUi },
      });
    }
  }

  // §3.3 ТЗ v5.2 - разведка: создаётся ПЕРВОЙ, блокирует всё дерево.
  let spikeTask = null;
  const risky = plan.approach?.riskiest_assumption;
  if (risky?.how_to_check) {
    spikeTask = journal.addTask({
      project_id: project.id,
      title: `Разведка: ${risky.statement ?? 'проверка рискованного допущения'}`,
      spec: `${risky.statement ?? ''}\n\nПочему рискованно: ${risky.why_riskiest ?? ''}\n\nКритерий отказа (для сверки целого после исполнения): ${risky.kill_criteria ?? '(не указан)'}`,
      criteria: { cmd: risky.how_to_check },
      role: 'coder',
      type: 'spike',
      touches_files: [],
      covers: [],
    });
  }

  const keyToId = {};
  const insertedTasks = [];
  for (const t of plan.tasks) {
    const task = journal.addTask({
      project_id: project.id,
      title: t.title,
      spec: t.spec,
      criteria: t.criteria,
      role: 'coder',
      type: 'build',
      touches_files: t.touches_files ?? [],
      covers: t.covers ?? [],
      core_check: !!t.core_check,
    });
    if (t.key) keyToId[t.key] = task.id;
    insertedTasks.push({ ...task, _key: t.key, _deps: t.deps ?? [] });
  }
  for (const t of insertedTasks) {
    for (const depKey of t._deps) {
      const depId = keyToId[depKey];
      if (depId) journal.addTaskDep(t.id, depId);
    }
    if (spikeTask) journal.addTaskDep(t.id, spikeTask.id);
  }

  let regressionTask = null;
  if (plan.regression_task) {
    const regressionOfIds = (plan.regression_task.regression_of ?? []).map((k) => keyToId[k]).filter(Boolean);
    if (regressionOfIds.length > 0) {
      regressionTask = journal.addTask({
        project_id: project.id,
        title: plan.regression_task.title || 'Регрессия',
        spec: 'Повторный прогон критериев предыдущих задач - без нового кода проверки (§8.10 ТЗ).',
        criteria: { regression_of: regressionOfIds },
        role: 'coder',
        type: 'regression',
        touches_files: [],
        covers: [],
      });
      for (const id of regressionOfIds) {
        journal.addTaskDep(regressionTask.id, id);
      }
      if (spikeTask) journal.addTaskDep(regressionTask.id, spikeTask.id);
    }
  }

  const readinessItems = productSpec.readiness ?? [];
  const coveredSet = new Set(insertedTasks.flatMap((t) => t.covers ?? []));
  const uncoveredReadiness = readinessItems.map(readinessText).filter((text) => !coveredSet.has(text));

  const coreCheckedSet = new Set(insertedTasks.filter((t) => t.core_check).flatMap((t) => t.covers ?? []));
  const uncoveredCoreChecks = readinessItems
    .filter((r) => readinessTier(r) === 'core')
    .map(readinessText)
    .filter((text) => !coreCheckedSet.has(text));

  if (uncoveredCoreChecks.length > 0) {
    journal.logEvent({
      run_id: runId,
      project_id: project.id,
      type: 'status',
      agent: 'engineer',
      payload: { kind: 'uncovered_core_check', readiness: uncoveredCoreChecks },
    });
  }

  return { plan, tasks: insertedTasks, spikeTask, regressionTask, uncoveredReadiness, uncoveredCoreChecks };
}

// ============================================================================
// Режим: Сверка целого (checkpoint) - §3.2 ТЗ v5.2, новый механизм
// ============================================================================

function buildCheckpointPrompt({ productSpec, tasks, approach }) {
  const parts = [
    '# Режим: Сверка целого',
    `# Ядро замысла (core_intent)\n${productSpec?.core_intent ?? '(не указано)'}`,
    `# product_spec\n${productSpec?.spec_md ?? '(нет)'}`,
  ];
  if (approach) parts.push(`# Approach\n${JSON.stringify(approach, null, 2)}`);
  const board = tasks
    .map((t) => {
      const line = `- [${t.status}] (${t.type}${t.core_check ? ', core_check' : ''}) ${t.title} - covers: ${JSON.stringify(t.covers)}`;
      return t.feedback ? `${line}\n  отчёт Проверяющего: ${String(t.feedback).slice(0, 300)}` : line;
    })
    .join('\n');
  parts.push(`# Доска задач\n${board}`);
  return parts.join('\n\n---\n\n');
}

/**
 * runCheckpoint - один вызов режима "Сверка целого". Логирует событие
 * type='checkpoint' независимо от исхода - по журналу должно быть видно,
 * что система смотрела на целое, и сколько раз (§3.2 ТЗ v5.2).
 */
export async function runCheckpoint({ project, productSpec, journal, runId }) {
  const tasks = journal.listTasks(project.id);
  const approach = journal.getApproach(project.id);

  const res = await chat(
    'engineer',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildCheckpointPrompt({ productSpec, tasks, approach }) },
    ],
    { json: true, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );

  const data = res.data ?? {};
  journal.logEvent({
    run_id: runId,
    project_id: project.id,
    type: 'checkpoint',
    agent: 'engineer',
    payload: {
      on_track: data.on_track ?? null,
      core_progress: data.core_progress ?? null,
      drift: data.drift ?? null,
      stop_reason: data.stop_reason ?? null,
      actions_count: (data.actions ?? []).length,
    },
  });
  return data;
}

/**
 * applyCheckpointActions - §3.2 ТЗ v5.2: план не высечен в камне. add_task
 * вставляет недостающую работу, retire_task снимает бессмысленную (НЕ трогая
 * уже done), revise_criteria переписывает слабый критерий, revise_plan -
 * заметка без немедленного действия.
 */
export function applyCheckpointActions(journal, project, actions = []) {
  const applied = [];
  for (const action of actions ?? []) {
    if (action.type === 'add_task' && action.task?.title && action.task?.spec) {
      const task = journal.addTask({
        project_id: project.id,
        title: action.task.title,
        spec: action.task.spec,
        criteria: action.task.criteria ?? {},
        role: 'coder',
        type: 'build',
        touches_files: action.task.touches_files ?? [],
        covers: action.task.covers ?? [],
        core_check: !!action.task.core_check,
      });
      applied.push({ type: 'add_task', taskId: task.id, why: action.why ?? null });
      continue;
    }
    if (action.type === 'retire_task' && action.task_id) {
      const task = journal.getTask(action.task_id, project.id);
      if (task && task.status !== 'done') {
        journal.setStatus(action.task_id, 'retired', { feedback: `Снята Инженером на сверке целого: ${action.why ?? '(без обоснования)'}` });
        applied.push({ type: 'retire_task', taskId: action.task_id, why: action.why ?? null });
      }
      continue;
    }
    if (action.type === 'revise_criteria' && action.task_id && action.criteria) {
      const task = journal.getTask(action.task_id, project.id);
      if (task && task.status !== 'done') {
        journal.raw.prepare(`UPDATE tasks SET criteria = ? WHERE id = ?`).run(JSON.stringify(action.criteria), action.task_id);
        applied.push({ type: 'revise_criteria', taskId: action.task_id, why: action.why ?? null });
      }
      continue;
    }
    if (action.type === 'revise_plan') {
      applied.push({ type: 'revise_plan', note: action.note ?? null, why: action.why ?? null });
    }
  }
  return applied;
}

// ============================================================================
// Режим: Сдача (было agents/consultant.js)
// ============================================================================

function buildReportPrompt({ productSpec, tasks, approach, pilotEvents, checkpointEvents }) {
  const parts = [
    '# Режим: Сдача',
    `# product_spec\n${productSpec?.spec_md ?? '(нет)'}`,
    `# Ядро замысла (core_intent)\n${productSpec?.core_intent ?? '(не указано)'}`,
  ];
  if (approach) {
    parts.push(`# Approach (варианты, выбор, обоснование, разведка)\n${JSON.stringify(approach, null, 2)}`);
  }
  const tasksText = tasks
    .map((t) => {
      const line = `- [${t.status}] (${t.type}${t.core_check ? ', core_check' : ''}) ${t.title} - covers: ${JSON.stringify(t.covers)}`;
      return t.question ? `${line}\n  диагноз/вопрос: ${t.question}` : line;
    })
    .join('\n');
  parts.push(`# Дерево задач\n${tasksText}`);

  if (checkpointEvents.length) {
    const cpText = checkpointEvents.map((e) => JSON.stringify(JSON.parse(e.payload ?? '{}'))).join('\n');
    parts.push(`# Сверки целого (checkpoint), всего ${checkpointEvents.length}\n${cpText}`);
  } else {
    parts.push('# Сверки целого (checkpoint)\nНи одной сверки не произошло за время сборки.');
  }

  if (pilotEvents.length) {
    const pilotText = pilotEvents.map((e) => JSON.stringify(JSON.parse(e.payload ?? '{}'))).join('\n');
    parts.push(`# Отчёт Пилота (контур 2)\n${pilotText}`);
  } else {
    parts.push('# Отчёт Пилота (контур 2)\nПилот не запускался (доска не была полностью зелёной на момент сдачи).');
  }
  return parts.join('\n\n---\n\n');
}

/**
 * runReport - формирует полный отчёт (8 пунктов от LLM + пункт 9 "Расход" от
 * harness, чистый SQL, §17.1 ТЗ). Пишет REPORT.md в корень проекта.
 */
export async function runReport({ project, productSpec, journal, runId }) {
  const tasks = journal.listTasks(project.id);
  const approach = journal.getApproach(project.id);
  const pilotEvents = journal.listEvents(project.id).filter((e) => e.type === 'pilot');
  const checkpointEvents = journal.listEvents(project.id).filter((e) => e.type === 'checkpoint');

  const res = await chat(
    'engineer',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildReportPrompt({ productSpec, tasks, approach, pilotEvents, checkpointEvents }) },
    ],
    { json: false, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );

  const spendReport = formatSpendReport(journal, project.id);
  const report = `${res.text.trim()}\n\n9. Расход\n${spendReport}\n`;

  fs.writeFileSync(path.join(workspaceDir(project.id), 'REPORT.md'), report, 'utf8');

  return report;
}
