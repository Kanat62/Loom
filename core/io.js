// core/io.js - один readline на процесс, очередь строк, санитизация ввода.
// §19.9 ТЗ: лимит длины - 4000 символов для содержательного ввода, 500 для
// команд (500 обрезало бриф молча - шрам 16); обрезка ПЕЧАТАЕТ предупреждение.
import readline from 'node:readline';
import { INPUT_LIMIT_CONTENT, INPUT_LIMIT_COMMAND } from './config.js';

// ANSI escape sequences + управляющие символы (кроме таба), кроме \n которых нет
// в однострочном вводе readline.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeInput(raw, limit = INPUT_LIMIT_CONTENT) {
  let text = String(raw ?? '').replace(ANSI_RE, '').replace(CONTROL_RE, '');
  text = text.trim();
  if (text.length > limit) {
    const truncated = text.slice(0, limit);
    process.stdout.write(
      `\n[loom] ввод обрезан до ${limit} символов (было ${text.length}) - предупреждение, не молчаливая потеря.\n`
    );
    return truncated;
  }
  return text;
}

let sharedInterface = null;
const lineQueue = [];
const waiters = [];

function getInterface() {
  if (sharedInterface) return sharedInterface;
  sharedInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  sharedInterface.on('line', (raw) => {
    const waiter = waiters.shift();
    if (waiter) waiter(raw);
    else lineQueue.push(raw);
  });
  return sharedInterface;
}

function nextLine() {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  return new Promise((resolve) => waiters.push(resolve));
}

/**
 * createIO - единая точка чтения строк с терминала для всего процесса.
 * Несколько мест кода могут вызывать ask() последовательно - строки
 * ставятся в очередь и раздаются по порядку, без создания второго readline.
 */
export function createIO() {
  const rl = getInterface();
  return {
    async ask(promptText = '', { limit = INPUT_LIMIT_CONTENT } = {}) {
      if (promptText) process.stdout.write(promptText);
      const raw = await nextLine();
      return sanitizeInput(raw, limit);
    },
    async askCommand(promptText = '') {
      if (promptText) process.stdout.write(promptText);
      const raw = await nextLine();
      return sanitizeInput(raw, INPUT_LIMIT_COMMAND);
    },
    write(text) {
      process.stdout.write(text);
    },
    close() {
      rl.close();
      sharedInterface = null;
    },
  };
}
