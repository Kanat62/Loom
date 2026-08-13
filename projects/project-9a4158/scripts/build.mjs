import * as esbuild from 'esbuild';
import { mkdirSync, writeFileSync, existsSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Сборка проекта.
 *
 * Контракт вывода: при успехе процесс НЕ пишет в stdout ни одного символа —
 * ни собственных сообщений, ни сводок esbuild (поэтому logLevel: 'silent').
 * Любая диагностика уходит только в stderr и только вместе с ненулевым кодом выхода.
 */

const REQUIRED_OUTPUTS = [
  'public/app.js',
  'public/index.html',
  'dist/server.js',
  'dist/core/track.cjs',
  'dist/core/speaker.cjs',
];

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function fail(message) {
  process.stderr.write(`[build] ${message}\n`);
  process.exit(1);
}

/**
 * Копирует токены дизайн-системы рядом с index.html, чтобы относительная
 * ссылка design/tokens.css работала и через сервер, и при открытии файла.
 */
function copyDesignTokens() {
  const src = path.join('design', 'tokens.css');
  if (!existsSync(src)) return false;
  ensureDir(path.join('public', 'design'));
  copyFileSync(src, path.join('public', 'design', 'tokens.css'));
  return true;
}

function missingOutputs() {
  return REQUIRED_OUTPUTS.filter((file) => !existsSync(file) || statSync(file).size === 0);
}

async function run() {
  ensureDir('public');
  ensureDir('dist');
  ensureDir('dist/core');

  // Корневой package.json объявляет "type": "module" (нужно клиентскому ESM-бандлу).
  // Серверный и core-бандлы собираются в формате CJS (require/__dirname),
  // поэтому в dist/ кладём свой package.json с "type": "commonjs".
  writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

  const common = {
    bundle: true,
    sourcemap: true,
    logLevel: 'silent',
  };

  // Клиентский бандл: браузерный ESM.
  await esbuild.build({
    ...common,
    entryPoints: ['src/client/main.ts'],
    outfile: 'public/app.js',
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
  });

  const nodeBundle = {
    ...common,
    format: 'cjs',
    platform: 'node',
    target: ['node22'],
    packages: 'external',
  };

  // Серверный бандл.
  await esbuild.build({
    ...nodeBundle,
    entryPoints: ['src/server/index.ts'],
    outfile: 'dist/server.js',
  });

  // Core-модули: используются сервером при сборке итогового видео.
  await esbuild.build({
    ...nodeBundle,
    entryPoints: ['src/core/track.ts'],
    outfile: 'dist/core/track.cjs',
  });

  await esbuild.build({
    ...nodeBundle,
    entryPoints: ['src/core/speaker.ts'],
    outfile: 'dist/core/speaker.cjs',
  });

  if (!copyDesignTokens()) {
    fail('design/tokens.css не найден — страница осталась бы без токенов дизайн-системы');
  }

  const missing = missingOutputs();
  if (missing.length > 0) {
    fail('отсутствуют артефакты: ' + missing.join(', '));
  }
}

run().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  fail(message);
});
