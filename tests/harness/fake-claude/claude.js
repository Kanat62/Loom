#!/usr/bin/env node
// tests/harness/fake-claude/claude.js - подставной `claude` в PATH (§13 гайда).
// Продакшн-код (gateway.js) идёт полностью настоящим путём: сборка аргументов,
// файл системного промпта, STDIN, разбор конверта. Подставной claude лишь
// имитирует ответ CLI и умеет ломаться по заказу через переменные окружения:
//   FAKE_CLAUDE_MODE = ok | is_error | bad_envelope | exit1 | hang | sequence
//   FAKE_CLAUDE_RESULT           - точный текст envelope.result для режима ok/is_error
//   FAKE_CLAUDE_SEQUENCE         - "mode1,mode2,..." для режима sequence (по счётчику вызовов)
//   FAKE_CLAUDE_SEQUENCE_RESULTS - "result1|result2|..." (разделитель '|', т.к. json может содержать запятые)
//   FAKE_CLAUDE_STATE_FILE       - файл-счётчик вызовов (для sequence и проверки числа попыток)
//   FAKE_CLAUDE_LOG              - файл, куда дописывается JSON-строка на каждый вызов (для проверки аргументов)
import fs from 'node:fs';

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function getArg(name) {
  const eqPrefix = `${name}=`;
  const eqArg = process.argv.find((a) => a.startsWith(eqPrefix));
  if (eqArg !== undefined) return eqArg.slice(eqPrefix.length);
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
  const stateFile = process.env.FAKE_CLAUDE_STATE_FILE;
  const logFile = process.env.FAKE_CLAUDE_LOG;

  const stdin = await readStdin();

  let index = 0;
  if (stateFile) {
    try {
      index = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0;
    } catch {
      index = 0;
    }
    fs.writeFileSync(stateFile, String(index + 1));
  }

  let effectiveMode = mode;
  if (mode === 'sequence') {
    const seq = (process.env.FAKE_CLAUDE_SEQUENCE || 'ok').split(',');
    effectiveMode = seq[Math.min(index, seq.length - 1)];
  }

  const systemFile = getArg('--system-prompt-file');
  const model = getArg('--model');
  const tools = getArg('--tools');
  const strictMcp = process.argv.includes('--strict-mcp-config');
  let systemContent = '';
  try {
    systemContent = systemFile ? fs.readFileSync(systemFile, 'utf8') : '';
  } catch {
    /* logged as empty below */
  }

  if (logFile) {
    const entry = {
      index,
      mode: effectiveMode,
      model,
      tools,
      strictMcp,
      systemFile,
      systemContentLen: systemContent.length,
      stdin,
      argv: process.argv.slice(2),
    };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  }

  if (effectiveMode === 'hang') {
    await new Promise(() => {}); // никогда не резолвится - таймаут вызывающей стороны должен убить процесс
    return;
  }
  if (effectiveMode === 'exit1') {
    process.stderr.write('fake-claude: simulated crash\n');
    process.exit(1);
  }
  if (effectiveMode === 'bad_envelope') {
    process.stdout.write('this is not json {{{');
    process.exit(0);
  }

  // Не фильтруем пустые элементы - позиция в списке ДОЛЖНА совпадать с индексом
  // вызова (пустая строка перед первым '|' - валидный "нет результата на этом шаге").
  const rawResults = process.env.FAKE_CLAUDE_SEQUENCE_RESULTS;
  const resultsList = rawResults !== undefined ? rawResults.split('|') : [];
  const result = (resultsList.length > index ? resultsList[index] : undefined) ?? process.env.FAKE_CLAUDE_RESULT ?? 'OK';
  const isError = effectiveMode === 'is_error';

  const envelope = {
    is_error: isError,
    result,
    total_cost_usd: 0.001,
    duration_ms: 5,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: index > 0 ? 10 : 0,
      cache_creation_input_tokens: 0,
    },
  };
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

main();
