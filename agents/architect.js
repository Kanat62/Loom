// agents/architect.js - Архитектор (§1.3 ТЗ): думает, потом режет.
// Две задачи в этом порядке: approach (варианты + выбор), затем дерево задач
// с критериями приёмки (§8 - свод в prompts/architect.md ДОСЛОВНО).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROMPTS_DIR } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { runSingleCheck } from '../core/checkRunner.js';
import { runProcess } from '../core/spawnUtil.js';
import { workspaceDir, setProjectDomain } from '../core/projects.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'architect.md'), 'utf8');

function buildUserPrompt({ productSpec, feedback }) {
  const parts = [`# product_spec продукта\n${productSpec.spec_md}`];
  if (feedback) parts.push(`# Замечание к прошлой попытке (почини именно это)\n${feedback}`);
  return parts.join('\n\n---\n\n');
}

async function callArchitect({ productSpec, project, journal, runId, feedback }) {
  const res = await chat(
    'architect',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ productSpec, feedback }) },
    ],
    { json: true, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );
  return res.data;
}

/**
 * precheckFictitious - §8.9 ТЗ, капкан на пустышки: критерий, который уже
 * проходит ДО работы Исполнителя, фиктивен.
 */
async function precheckFictitious(tasks, cwd) {
  const fictitious = [];
  for (const t of tasks) {
    if (!t.criteria || t.criteria.regression_of) continue;
    try {
      const result = await runSingleCheck(t.criteria, { cwd });
      if (result.pass) fictitious.push(t.title);
    } catch {
      // Предпроверка сама не должна валить план - просто не считаем фиктивным.
    }
  }
  return fictitious;
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
 * уже есть package.json продукта. Guard: `npm prefix` обязан совпасть с
 * целевым каталогом, иначе npm поднимается вверх и правит манифест LOOM.
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
 * planProject - полный конвейер Архитектора: вызов модели -> scaffold
 * package.json -> npm install (guard) -> предпроверка критериев (1 регенерация
 * при пустышках) -> вставка дерева задач в журнал (2 прохода: сперва без
 * deps, затем резолв key->id) -> регрессия последней задачей -> трассировка covers.
 */
export async function planProject({ project, productSpec, journal, runId = crypto.randomUUID() }) {
  const dir = workspaceDir(project.id);

  let plan = await callArchitect({ productSpec, project, journal, runId });
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Архитектор не вернул валидное дерево задач (пустой или некорректный ответ)');
  }

  scaffoldPackageJson(dir, project.id);
  if (plan.domain) setProjectDomain(journal, project.id, plan.domain);
  if (plan.approach) journal.setApproach(project.id, plan.approach);

  if (plan.packages?.length) {
    try {
      await npmInstallGuarded(dir, plan.packages);
    } catch (err) {
      // §18 ТЗ (правило 4 уровней) - это Harness-уровень: у Архитектора нет
      // способа заранее знать, что пакет требует нативной сборки (Visual
      // Studio/node-gyp), которой нет на машине. Одна регенерация с фактом
      // ошибки - тот же паттерн, что предпроверка пустышек (§8.9), применённый
      // к новому классу провала, найденному на практике (экзамен §22 ТЗ).
      journal.logEvent({
        run_id: runId,
        project_id: project.id,
        type: 'status',
        agent: 'architect',
        payload: { kind: 'npm_install_failed', packages: plan.packages, error: err.message.slice(0, 1000) },
      });
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
      fs.rmSync(path.join(dir, 'package-lock.json'), { force: true });

      plan = await callArchitect({
        productSpec,
        project,
        journal,
        runId,
        feedback: `Установка пакетов провалилась на этой машине - НАСТОЯЩАЯ ошибка npm install (не выдумывай другую причину):\n${err.message.slice(0, 800)}\n\nПакеты ${JSON.stringify(plan.packages)} не подходят (типичная причина - нужна нативная сборка C++/Visual Studio, которой на машине нет). Выбери ДРУГОЙ подход/пакеты, не требующие нативной компиляции - например, чистый JS/WASM бэкенд, либо перенеси эту логику в браузер (клиентский код), если это вообще возможно по product_spec.`,
      });
      if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        throw new Error('Архитектор не вернул валидное дерево задач после регенерации из-за провала npm install');
      }
      if (plan.domain) setProjectDomain(journal, project.id, plan.domain);
      if (plan.approach) journal.setApproach(project.id, plan.approach);
      if (plan.packages?.length) {
        await npmInstallGuarded(dir, plan.packages); // вторая попытка - если снова упадёт, честно бросаем (одна регенерация, не бесконечно, шрам 17)
      }
    }
  }

  let fictitious = await precheckFictitious(plan.tasks, dir);
  if (fictitious.length > 0) {
    journal.logEvent({
      run_id: runId,
      project_id: project.id,
      type: 'status',
      agent: 'architect',
      payload: { kind: 'fictitious_criteria', tasks: fictitious },
    });
    plan = await callArchitect({
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
        agent: 'architect',
        payload: { kind: 'fictitious_criteria_persist', tasks: fictitious },
      });
    }
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
    });
    if (t.key) keyToId[t.key] = task.id;
    insertedTasks.push({ ...task, _key: t.key, _deps: t.deps ?? [] });
  }
  for (const t of insertedTasks) {
    for (const depKey of t._deps) {
      const depId = keyToId[depKey];
      if (depId) journal.addTaskDep(t.id, depId);
    }
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
    }
  }

  const readiness = productSpec.readiness ?? [];
  const coveredSet = new Set(insertedTasks.flatMap((t) => t.covers ?? []));
  const uncoveredReadiness = readiness.filter((r) => !coveredSet.has(r));

  return { plan, tasks: insertedTasks, regressionTask, uncoveredReadiness };
}
