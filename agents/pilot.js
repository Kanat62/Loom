// agents/pilot.js - Пилот (§1.6, §9 ТЗ). Контур 2: реальный прогон ПОСЛЕ
// того, как вся доска зелёная. Не осмотр интерфейса - эксплуатация продукта
// по сценарию из product_spec ("Как работает"). Один цикл на сдачу.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROMPTS_DIR, CHECK_TIMEOUT_MS } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { runProcess } from '../core/spawnUtil.js';
import { workspaceDir } from '../core/projects.js';
import { npmInstallGuarded } from './architect.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'pilot.md'), 'utf8');

function buildUserPrompt({ productSpec, browserAvailable }) {
  const parts = [`# product_spec (сценарий "Как работает" + "Признаки готовности")\n${productSpec.spec_md}`];
  if (!browserAvailable) {
    parts.push(
      '# ВНИМАНИЕ: браузер Playwright недоступен на этой машине сейчас. Пиши скрипт БЕЗ Playwright - только программные проверки файлов/команд (§8.5 ТЗ: деградация обязательна). Поставь "visual": false в выводе - честно, не притворяйся, что проверил визуально.'
    );
  }
  return parts.join('\n\n---\n\n');
}

/**
 * checkBrowserAvailable - реальная проверка, что бинарник chromium физически
 * скачан (§8.5 ТЗ - деградация обязательна, "нет браузеров" - частый случай
 * на свежей машине, playwright требует отдельного `npx playwright install`).
 */
async function checkBrowserAvailable(cwd) {
  const code =
    "try{const p=require('playwright').chromium.executablePath();console.log(require('fs').existsSync(p)?'ok':'missing')}catch(e){console.log('missing')}";
  const res = await runProcess('node', ['-e', code], { cwd, timeoutMs: 15_000 });
  return res.stdout.trim().endsWith('ok');
}

async function ensurePlaywrightPackage(dir) {
  const pwDir = path.join(dir, 'node_modules', 'playwright');
  if (fs.existsSync(pwDir)) return;
  await npmInstallGuarded(dir, ['playwright']);
}

/**
 * runPilot - один цикл Пилота. Возвращает { findings[], visual, scriptFailed?, error? }.
 * НИКОГДА не бросает на "скрипт упал"/"JSON кривой" - это честный, а не
 * симулированный результат (пустые findings + visual:false + error-описание).
 */
export async function runPilot({ project, productSpec, journal, runId }) {
  const dir = workspaceDir(project.id);
  // Playwright имеет смысл только для визуальных продуктов - не тратим
  // npm install/сеть на cli/lib/data, где браузер в принципе не нужен.
  let browserAvailable = false;
  if (project.domain === 'ui') {
    await ensurePlaywrightPackage(dir);
    browserAvailable = await checkBrowserAvailable(dir);
  }

  const res = await chat(
    'pilot',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ productSpec, browserAvailable }) },
    ],
    { json: true, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );

  const script = res.data?.script;
  if (!script) {
    return { findings: [], visual: false, scriptFailed: true, error: 'Пилот не вернул поле script' };
  }

  const rand = crypto.randomBytes(4).toString('hex');
  const scriptFile = path.join(dir, `.loom-pilot-${rand}.cjs`);
  fs.writeFileSync(scriptFile, script, 'utf8');

  let execRes;
  try {
    execRes = await runProcess('node', [scriptFile], { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS.browser * 2 });
  } finally {
    try {
      fs.unlinkSync(scriptFile);
    } catch {
      /* best-effort */
    }
  }

  const stdout = execRes.stdout.trim();
  if (!stdout) {
    return {
      findings: [],
      visual: false,
      scriptFailed: true,
      error: `Пилот-скрипт не вывел ничего в stdout (exit ${execRes.code}): ${execRes.stderr.slice(0, 500)}`,
    };
  }

  try {
    const parsed = JSON.parse(stdout);
    return { findings: parsed.findings ?? [], visual: parsed.visual ?? browserAvailable };
  } catch {
    return {
      findings: [],
      visual: false,
      scriptFailed: true,
      error: `Пилот-скрипт вернул невалидный JSON: ${stdout.slice(0, 300)}`,
    };
  }
}

/**
 * applyPilotFindings - находки Пилота -> задачи `type=pilot_fix` (§1.6 ТЗ).
 * Не вердикт - список находок, каждая с готовым критерием приёмки.
 */
export function applyPilotFindings(journal, project, findings) {
  return findings.map((f) => {
    const task = journal.addTask({
      project_id: project.id,
      title: f.title,
      spec: `${f.what_happened}\n\nОжидалось: ${f.expected}`,
      criteria: f.criteria ?? {},
      role: 'coder',
      type: 'pilot_fix',
      touches_files: [],
      covers: [],
    });
    return { ...task, severity: f.severity };
  });
}

export function hasBlockers(findings) {
  return findings.some((f) => f.severity === 'blocker');
}
