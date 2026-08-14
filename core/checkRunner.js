// core/checkRunner.js - исполнение критериев приёмки (§8 ТЗ). Контур 1
// (Проверяющий) - без LLM, его нельзя уговорить. Отчёты до 1000 символов,
// правило говорящего провала (§8.4): печатаем условие и фактические значения.
//
// Критерий: {cmd, expect?, timeout_ms?} | {regression_of:[taskIds]}.
// `expect` (декларативно, сравнение делает ХАРНЕСС, не текст команды - тем
// самым "говорящий провал" форматируется единообразно для любой команды):
//   не задан        -> pass = exit code 0
//   {min:N}         -> stdout распарсен как число, число >= N (правило минимумов, §8.3)
//   {max:N}         -> число <= N
//   {equals:V}      -> обрезанный stdout === String(V)
//   {contains:S}    -> stdout содержит подстроку S
//
// §8.7 ТЗ: все JS-критерии - через временный .cjs-файл ВНУТРИ workspace,
// никогда shell-строкой (шрам 7: `$$` в bash ломает `$$eval` до запуска Node;
// tmpdir не годится - require не дорезолвится до node_modules проекта).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProcess } from './spawnUtil.js';
import { CHECK_TIMEOUT_MS } from './config.js';

const REPORT_LIMIT = 1000;

// Извлекает тело `node -e "..."` / `node --eval '...'` для выноса в .cjs.
const NODE_EVAL_RE = /^\s*node\s+(?:-e|--eval)\s+(["'])([\s\S]*)\1\s*$/;

export function extractNodeEvalBody(cmd) {
  const m = cmd.match(NODE_EVAL_RE);
  if (!m) return null;
  const [, quote, rawBody] = m;
  if (quote === '"') {
    // Экранирование по конвенции prompts/engineer.md: \" -> ", \\ -> \.
    // ВАЖНО (реальный баг, найден на экзамене §22 - сложный Playwright-критерий
    // с вложенными кавычками/регэкспами молча ломался): два ПОСЛЕДОВАТЕЛЬНЫХ
    // .replace() небезопасны - результат первой замены может случайно создать
    // или разрушить паттерн для второй (напр. "\\\"" - экранированный бэкслеш
    // перед экранированной кавычкой - первый проход `\"`->`"` неверно matчит
    // второй бэкслеш из пары `\\` как если бы он экранировал кавычку). Один
    // проход, атомарно решающий "что именно заэкранировано" за один matч -
    // единственный корректный способ для этой схемы экранирования.
    return rawBody.replace(/\\(\\|")/g, '$1');
  }
  return rawBody;
}

export function classifyTimeout(cmd, explicitMs) {
  if (explicitMs) return Math.min(explicitMs, CHECK_TIMEOUT_MS.max);
  const lower = cmd.toLowerCase();
  if (/playwright|chromium|puppeteer/.test(lower)) return CHECK_TIMEOUT_MS.browser;
  if (/ffmpeg|ffprobe/.test(lower)) return CHECK_TIMEOUT_MS.ffmpeg;
  return CHECK_TIMEOUT_MS.node;
}

function truncate(text, limit = REPORT_LIMIT) {
  const clean = String(text ?? '').trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

function evaluateExpect(expect, res) {
  const stdout = res.stdout.trim();
  if (!expect) {
    if (res.code === 0) return { pass: true };
    return {
      pass: false,
      reason: `exit_code=${res.code} expected=0`,
    };
  }
  if ('min' in expect) {
    const value = Number.parseFloat(stdout);
    const pass = Number.isFinite(value) && value >= expect.min;
    return { pass, reason: `value=${stdout || '<empty>'} expected>=${expect.min}` };
  }
  if ('max' in expect) {
    const value = Number.parseFloat(stdout);
    const pass = Number.isFinite(value) && value <= expect.max;
    return { pass, reason: `value=${stdout || '<empty>'} expected<=${expect.max}` };
  }
  if ('equals' in expect) {
    const pass = stdout === String(expect.equals);
    return { pass, reason: `value=${stdout || '<empty>'} expected=${expect.equals}` };
  }
  if ('contains' in expect) {
    const pass = stdout.includes(expect.contains);
    return { pass, reason: `value=${truncate(stdout, 200) || '<empty>'} expected to contain "${expect.contains}"` };
  }
  return { pass: res.code === 0, reason: `exit_code=${res.code} expected=0` };
}

/**
 * runSingleCheck - исполняет один {cmd, expect?, timeout_ms?} критерий.
 * §8.9 ТЗ (капкан на пустышки) реализуется вызывающей стороной (engineer.js /
 * coordinator.js), не здесь - checkRunner просто исполняет, что дали.
 */
export async function runSingleCheck({ cmd, expect, timeout_ms }, { cwd }) {
  const timeoutMs = classifyTimeout(cmd, timeout_ms);
  const jsBody = extractNodeEvalBody(cmd);
  let tempFile = null;
  let execCmd = cmd;

  if (jsBody !== null) {
    const rand = crypto.randomBytes(4).toString('hex');
    tempFile = path.join(cwd, `.loom-check-${rand}.cjs`);
    fs.writeFileSync(tempFile, jsBody, 'utf8');
    execCmd = `node "${tempFile}"`;
  }

  let res;
  try {
    res = await runProcess(execCmd, [], { cwd, timeoutMs, shell: true });
  } finally {
    if (tempFile) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        /* лучшая попытка - не блокируем отчёт */
      }
    }
  }

  if (res.timedOut) {
    return {
      pass: false,
      report: truncate(`FAIL: timeout_ms=${timeoutMs} exceeded, cmd="${cmd}"`),
      durationMs: res.durationMs,
      timedOut: true,
    };
  }

  const { pass, reason } = evaluateExpect(expect, res);
  if (pass) {
    return { pass: true, report: truncate(`OK: ${reason ?? `exit_code=${res.code}`}`), durationMs: res.durationMs, timedOut: false };
  }

  const tail = truncate([res.stdout, res.stderr].filter(Boolean).join('\n---STDERR---\n'), 600);
  return {
    pass: false,
    report: truncate(`FAIL: ${reason}\n${tail}`),
    durationMs: res.durationMs,
    timedOut: false,
  };
}

/**
 * runRegression - §8.10 ТЗ: ТОЛЬКО повторный прогон уже существующих критериев
 * done-задач (склейка id), не генерация нового кода проверки.
 */
export async function runRegression({ regression_of }, { cwd, journal, projectId }) {
  const reports = [];
  let allPass = true;
  for (const taskId of regression_of) {
    const task = journal.getTask(taskId, projectId);
    if (!task) {
      allPass = false;
      reports.push(`FAIL: regression ссылается на несуществующую задачу ${taskId}`);
      continue;
    }
    if (!task.criteria || task.criteria.regression_of) {
      allPass = false;
      reports.push(`FAIL: задача ${taskId} не имеет прогоняемого критерия (вложенная регрессия запрещена)`);
      continue;
    }
    const result = await runSingleCheck(task.criteria, { cwd });
    if (!result.pass) allPass = false;
    reports.push(`[${task.title}] ${result.report}`);
  }
  return {
    pass: allPass,
    report: truncate(reports.join('\n')),
    durationMs: null,
    timedOut: false,
  };
}

/**
 * runCriterion - единая точка входа: {cmd,...} | {regression_of:[...]}.
 */
export async function runCriterion(criterion, ctx) {
  if (!criterion) {
    return { pass: false, report: 'FAIL: задача не имеет критерия приёмки (брак архитектора)', durationMs: 0, timedOut: false };
  }
  if (criterion.regression_of) {
    return runRegression(criterion, ctx);
  }
  return runSingleCheck(criterion, ctx);
}
