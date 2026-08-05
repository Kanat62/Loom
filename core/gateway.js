// core/gateway.js - шлюз моделей (§5 ТЗ). ЕДИНСТВЕННАЯ точка вызовов LLM.
// Контракт: chat(role, messages, {json?, projectId?, taskId?, runId?}) -> текст | объект.
// Провайдер v1: headless Claude Code как "голый API" (§5.1). HTTP-ветка (прямые
// API) присутствует ниже выключенной - включается конфигом, без правки логики.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './spawnUtil.js';
import {
  ROLES,
  MODEL_TIER_NAMES,
  MODEL_TIMEOUT_MS,
  GATEWAY_ROUNDS,
  GATEWAY_ROUND_PAUSE_MS,
  getTmpDir,
  CLAUDE_BIN,
} from './config.js';

// §5.1 ТЗ: HTTP-ветка (прямые API) - выключена в v1, путь к независимости от
// подписки (v2). Переключатель конфигом, ветка кода не удаляется.
const HTTP_PROVIDER_ENABLED = false;

export class GatewayError extends Error {
  constructor(message, { role, attempts } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.role = role;
    this.attempts = attempts;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureTmpDir() {
  fs.mkdirSync(getTmpDir(), { recursive: true });
}

/**
 * System-промпт - ТОЛЬКО файлом (§5.1, §19.6 - Windows режет CLI-аргумент по
 * первому \n, шрам 28). Имя файла = sha256 содержимого -> побайтовая
 * идентичность -> работает кэш промптов claude-cli между вызовами.
 */
function writeSystemPromptFile(systemText) {
  ensureTmpDir();
  const hash = crypto.createHash('sha256').update(systemText, 'utf8').digest('hex');
  const file = path.join(getTmpDir(), `sys-${hash}.txt`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, systemText, 'utf8');
  }
  return file;
}

function ensureMcpEmptyConfig() {
  ensureTmpDir();
  const file = path.join(getTmpDir(), 'mcp.empty.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
  }
  return file;
}

function ensureHeadlessSettings() {
  ensureTmpDir();
  const file = path.join(getTmpDir(), 'settings.headless.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({}, null, 2), 'utf8');
  }
  return file;
}

function parseTier(tierSpec) {
  const [provider, model] = tierSpec.split(':');
  return { provider, model };
}

/**
 * Точная команда вызова claude-cli (§5.1 ТЗ):
 *   claude -p --model <tier> --output-format json
 *          --system-prompt-file <.loom-tmp/sys-<sha256>.txt>
 *          --tools "" --strict-mcp-config --mcp-config <mcp.empty.json>
 *          --settings <settings.headless.json>
 * user-промпт - ТОЛЬКО через STDIN. --bare НЕ используется (шрам 29: требует
 * API-ключ, игнорирует подписку) - изоляция достигается ручной тройкой выше.
 */
async function callClaudeCli({ model, systemText, userText, timeoutMs }) {
  const systemFile = writeSystemPromptFile(systemText);
  const mcpFile = ensureMcpEmptyConfig();
  const settingsFile = ensureHeadlessSettings();
  const modelName = MODEL_TIER_NAMES[model] ?? model;

  const args = [
    '-p',
    '--model',
    modelName,
    '--output-format',
    'json',
    '--system-prompt-file',
    systemFile,
    // Внимание (не в реестре шрамов ТЗ, найдено при сборке): `--tools` со
    // значением-пустой-строкой как ОТДЕЛЬНЫЙ элемент массива args ('--tools', '')
    // ломается на Windows конкретно в связке node child_process.spawn(shell:true)
    // -> cmd.exe: внутреннее экранирование Node не оборачивает пустую строку в
    // кавычки, cmd.exe тихо схлопывает два пробела и токен исчезает целиком -
    // `--strict-mcp-config` подставляется как ЗНАЧЕНИЕ `--tools`, а флаг
    // strict-mcp-config пропадает. Форма `--tools=` (один непустой токен,
    // синтаксис commander.js) даёт тот же эффект (пустой список инструментов)
    // и переживает shell:true невредимой. Проверено предметно на .cmd-шиме.
    '--tools=',
    '--strict-mcp-config',
    '--mcp-config',
    mcpFile,
    '--settings',
    settingsFile,
  ];

  const res = await runProcess(CLAUDE_BIN, args, { input: userText, timeoutMs });
  return res;
}

async function callHttpProvider() {
  throw new GatewayError('HTTP provider отключен в v1 (§5.1 ТЗ)');
}

function isTechnicalFailure(res) {
  if (res.spawnError) return true;
  if (res.timedOut) return true;
  if (res.code !== 0) return true;
  return false;
}

function parseEnvelope(stdout) {
  try {
    return { ok: true, envelope: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function tryParseJsonResult(text) {
  // Модель иногда оборачивает JSON в ```json ... ``` - снимаем ограждение перед парсингом.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return { ok: true, value: JSON.parse(candidate.trim()) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * chat(role, messages, opts) -> текст | распарсенный объект.
 * messages: [{role:'system', content}, {role:'user', content}, ...]
 *   - ровно одно system-сообщение (system-промпт для claude-cli, только файлом);
 *   - все user-сообщения конкатенируются в один STDIN-блок.
 * opts: { json=false, projectId, taskId, runId, minTierIndex=0, logEvent }
 *   logEvent - функция journal.logEvent (внедряется вызывающей стороной, чтобы
 *   gateway не зависел напрямую от журнала).
 */
export async function chat(role, messages, opts = {}) {
  const {
    json = false,
    projectId = null,
    taskId = null,
    runId = null,
    minTierIndex = 0,
    logEvent = null,
    timeoutMs = MODEL_TIMEOUT_MS,
    rounds = GATEWAY_ROUNDS,
    roundPauseMs = GATEWAY_ROUND_PAUSE_MS,
  } = opts;

  const chain = ROLES[role];
  if (!chain) throw new GatewayError(`неизвестная роль: ${role}`, { role });

  const systemMsg = messages.find((m) => m.role === 'system');
  if (!systemMsg) throw new GatewayError('messages должен содержать ровно одно system-сообщение', { role });
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');

  const tiers = chain.slice(minTierIndex);
  if (tiers.length === 0) {
    throw new GatewayError(`minTierIndex вне диапазона цепочки роли ${role}`, { role });
  }

  let lastError = null;
  let totalAttempts = 0;

  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      await sleep(roundPauseMs);
    }

    for (const tierSpec of tiers) {
      const { provider, model } = parseTier(tierSpec);
      totalAttempts++;

      let userForAttempt = userText;
      // Одна повторная попытка на кривой JSON, с напоминанием (§5 ТЗ), прежде
      // чем переходить к следующей модели в цепочке.
      for (let jsonRetry = 0; jsonRetry < 2; jsonRetry++) {
        const start = Date.now();
        const res =
          provider === 'claude-cli'
            ? await callClaudeCli({ model, systemText: systemMsg.content, userText: userForAttempt, timeoutMs })
            : await callHttpProvider();
        const durationMs = Date.now() - start;

        if (isTechnicalFailure(res)) {
          lastError = new GatewayError(
            `техническая ошибка провайдера ${provider}:${model}: ${res.spawnError?.message ?? res.stderr.slice(0, 200) ?? `exit ${res.code}`}${res.timedOut ? ' (timeout)' : ''}`,
            { role, attempts: totalAttempts }
          );
          logEvent?.({
            run_id: runId,
            project_id: projectId,
            task_id: taskId,
            type: 'status',
            agent: role,
            duration_ms: durationMs,
            payload: { kind: 'technical_failure', provider, model, code: res.code, timedOut: res.timedOut, stderr: res.stderr.slice(0, 200) },
          });
          break; // не ретраим JSON на технической ошибке - сразу следующая модель
        }

        const parsed = parseEnvelope(res.stdout);
        if (!parsed.ok) {
          lastError = new GatewayError(`не удалось разобрать конверт claude-cli: ${parsed.error.message}`, { role, attempts: totalAttempts });
          logEvent?.({
            run_id: runId,
            project_id: projectId,
            task_id: taskId,
            type: 'status',
            agent: role,
            duration_ms: durationMs,
            payload: { kind: 'envelope_parse_failure', raw200: res.stdout.slice(0, 200) },
          });
          break;
        }

        const envelope = parsed.envelope;
        const usage = envelope.usage ?? {};

        logEvent?.({
          run_id: runId,
          project_id: projectId,
          task_id: taskId,
          type: 'usage',
          agent: role,
          duration_ms: envelope.duration_ms ?? durationMs,
          tokens_in: usage.input_tokens ?? null,
          tokens_out: usage.output_tokens ?? null,
          cache_read: usage.cache_read_input_tokens ?? null,
          cost_usd: envelope.total_cost_usd ?? null,
          payload: { kind: 'model_call', provider, model, is_error: envelope.is_error },
        });

        if (envelope.is_error) {
          lastError = new GatewayError(`модель вернула is_error: ${String(envelope.result).slice(0, 200)}`, { role, attempts: totalAttempts });
          break; // ответила с ошибкой по существу - следующая модель, не ретрай JSON
        }

        const resultText = envelope.result ?? '';

        if (!json) {
          return { text: resultText, envelope, provider, model };
        }

        const parsedJson = tryParseJsonResult(resultText);
        if (parsedJson.ok) {
          return { data: parsedJson.value, text: resultText, envelope, provider, model };
        }

        // Кривой JSON = сбой модели (шрам 11): лог 200 символов сырого ответа,
        // ретрай с напоминанием, затем следующая модель.
        logEvent?.({
          run_id: runId,
          project_id: projectId,
          task_id: taskId,
          type: 'status',
          agent: role,
          duration_ms: durationMs,
          payload: { kind: 'bad_json', raw200: resultText.slice(0, 200) },
        });
        lastError = new GatewayError(`модель вернула невалидный JSON: ${resultText.slice(0, 200)}`, { role, attempts: totalAttempts });

        if (jsonRetry === 0) {
          userForAttempt = `${userText}\n\n[ПОВТОР] Твой предыдущий ответ не был валидным JSON. Ответь СТРОГО валидным JSON, без пояснений и markdown-ограждений.`;
          continue; // тот же тир, с напоминанием
        }
      }
    }
  }

  throw lastError ?? new GatewayError(`все модели в цепочке роли ${role} недоступны`, { role, attempts: totalAttempts });
}

export const _internal = {
  writeSystemPromptFile,
  ensureMcpEmptyConfig,
  ensureHeadlessSettings,
  parseTier,
  isTechnicalFailure,
  parseEnvelope,
  tryParseJsonResult,
};
