// tests/harness/env.js - изоляция состояния для тестов (§13 гайда).
// LOOM_HOME даёт тесту свой мир (своя БД, свои projects/), НЕ булев MOCK-флаг.
// Подставной `claude` подкладывается в начало PATH, чтобы spawn('claude')
// в core/gateway.js резолвился в него первым - продакшн-код при этом не знает,
// что он вызван из теста.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE_DIR = path.join(__dirname, 'fake-claude');

const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH';

export function setupTestEnv({ fakeClaudeMode = 'ok', fakeClaudeResult } = {}) {
  const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'));
  const stateFile = path.join(loomHome, 'fake-claude-state.txt');
  const logFile = path.join(loomHome, 'fake-claude-log.jsonl');
  fs.writeFileSync(stateFile, '0');
  fs.writeFileSync(logFile, '');

  const originalPath = process.env[PATH_KEY];
  const originalLoomHome = process.env.LOOM_HOME;

  process.env[PATH_KEY] = `${FAKE_CLAUDE_DIR}${path.delimiter}${originalPath}`;
  process.env.LOOM_HOME = loomHome;
  process.env.FAKE_CLAUDE_MODE = fakeClaudeMode;
  process.env.FAKE_CLAUDE_STATE_FILE = stateFile;
  process.env.FAKE_CLAUDE_LOG = logFile;
  if (fakeClaudeResult !== undefined) process.env.FAKE_CLAUDE_RESULT = fakeClaudeResult;

  return {
    loomHome,
    stateFile,
    logFile,
    readLog() {
      return fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    callCount() {
      return this.readLog().length;
    },
    cleanup() {
      process.env[PATH_KEY] = originalPath;
      if (originalLoomHome === undefined) delete process.env.LOOM_HOME;
      else process.env.LOOM_HOME = originalLoomHome;
      delete process.env.FAKE_CLAUDE_MODE;
      delete process.env.FAKE_CLAUDE_STATE_FILE;
      delete process.env.FAKE_CLAUDE_LOG;
      delete process.env.FAKE_CLAUDE_RESULT;
      delete process.env.FAKE_CLAUDE_SEQUENCE;
      delete process.env.FAKE_CLAUDE_SEQUENCE_RESULTS;
      // Windows иногда держит journal.db-wal/-shm какое-то время после close()
      // (антивирус/файловая система) - несколько попыток с паузой, не падаем в тесте.
      // Это гигиена тестового окружения, не свойство продакшн-кода.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.rmSync(loomHome, { recursive: true, force: true });
          return;
        } catch (err) {
          if (attempt === 9) {
            // Не валим тест из-за файловой гигиены ОС - просто предупреждаем.
            process.stderr.write(`[loom test harness] не удалось удалить ${loomHome}: ${err.message}\n`);
            return;
          }
          const until = Date.now() + 300;
          while (Date.now() < until) {
            /* короткая синхронная пауза перед повтором */
          }
        }
      }
    },
  };
}
