#!/usr/bin/env node
/**
 * Генератор тестовых видео-фикстур для локальной разработки и e2e-тестов.
 * Создаёт каталог fixtures/ и кладёт в него:
 *   - wide.mp4  — 1280x720, 25 fps, ровно 6.0 с: статичный пространственно-
 *                 контрастный фон (smptebars) + движущийся маркер (drawbox,
 *                 x зависит от t, едет слева направо), звук sine 440 Гц (aac).
 *   - wide2.mp4 — 1024x576, 25 fps, ровно 4.0 с: другой визуальный паттерн
 *                 (testsrc2) + движущийся маркер другого цвета, звук sine
 *                 880 Гц (aac).
 *
 * Скрипт идемпотентен: повторный запуск перезаписывает файлы (-y).
 * Печатает выполняемые команды. При ошибке ffmpeg (ненулевой код возврата,
 * невозможность запустить бинарник или отсутствие/пустой результирующий
 * файл) завершает процесс ненулевым кодом.
 *
 * Запуск: node scripts/make-fixtures.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const fixturesDir = join(rootDir, 'fixtures');

/** Оборачивает аргумент в кавычки только для читаемого вывода в консоль. */
function quoteForDisplay(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function printCommand(bin, args) {
  const line = [bin, ...args].map(quoteForDisplay).join(' ');
  console.log(`[fixtures] $ ${line}`);
}

/**
 * Запускает ffmpeg без участия системной оболочки (аргументы передаются
 * массивом напрямую в процесс), что исключает проблемы с разбором кавычек
 * разными шеллами на разных платформах. Бросает исключение при любой
 * неудаче: отсутствии бинарника, ненулевом коде возврата или отсутствии /
 * пустоте результирующего файла.
 */
function runFfmpeg(args, outputPath) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static: путь к бинарнику ffmpeg не найден для текущей платформы');
  }
  console.log(`[fixtures] ffmpeg: ${ffmpegPath}`);
  printCommand(ffmpegPath, args);

  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });

  if (result.error) {
    throw new Error(`не удалось запустить ffmpeg: ${result.error.message}`);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`ffmpeg завершился с кодом ${result.status}`);
  }
  if (result.signal) {
    throw new Error(`ffmpeg был прерван сигналом ${result.signal}`);
  }
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new Error(`ожидаемый файл не создан или пуст: ${outputPath}`);
  }
}

function baseArgs() {
  return ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];
}

function makeWide() {
  const outputPath = join(fixturesDir, 'wide.mp4');
  const width = 1280;
  const height = 720;
  const fps = 25;
  const duration = 6;
  const boxW = 160;
  const boxH = 360;
  const boxY = Math.round((height - boxH) / 2);
  const maxX = width - boxW;
  const xExpr = `${maxX}*t/${duration}`;
  const filterComplex =
    `[0:v]drawbox=x='${xExpr}':y=${boxY}:w=${boxW}:h=${boxH}:color=red:thickness=fill,` +
    `drawbox=x='${xExpr}':y=${boxY}:w=${boxW}:h=${boxH}:color=white:thickness=4,` +
    `format=yuv420p[v]`;

  console.log(
    `[fixtures] создаю wide.mp4 (${width}x${height}, ${fps} fps, ${duration.toFixed(1)} с, тон 440 Гц)`
  );

  const args = [
    ...baseArgs(),
    '-f', 'lavfi', '-i', `smptebars=size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`,
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '1:a',
    '-t', String(duration),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ];

  runFfmpeg(args, outputPath);
  console.log(`[fixtures] готово: ${outputPath}`);
}

function makeWide2() {
  const outputPath = join(fixturesDir, 'wide2.mp4');
  const width = 1024;
  const height = 576;
  const fps = 25;
  const duration = 4;
  const boxW = 140;
  const boxH = 300;
  const boxY = Math.round((height - boxH) / 2);
  const maxX = width - boxW;
  const xExpr = `${maxX}*t/${duration}`;
  // Другой визуальный паттерн (testsrc2 вместо smptebars) + маркер другого
  // цвета и другой частоты звука — файлы гарантированно различимы.
  const filterComplex =
    `[0:v]drawbox=x='${xExpr}':y=${boxY}:w=${boxW}:h=${boxH}:color=blue:thickness=fill,` +
    `drawbox=x='${xExpr}':y=${boxY}:w=${boxW}:h=${boxH}:color=yellow:thickness=4,` +
    `format=yuv420p[v]`;

  console.log(
    `[fixtures] создаю wide2.mp4 (${width}x${height}, ${fps} fps, ${duration.toFixed(1)} с, тон 880 Гц)`
  );

  const args = [
    ...baseArgs(),
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=${duration}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${duration}`,
    '-filter_complex', filterComplex,
    '-map', '[v]', '-map', '1:a',
    '-t', String(duration),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  ];

  runFfmpeg(args, outputPath);
  console.log(`[fixtures] готово: ${outputPath}`);
}

function main() {
  if (!existsSync(fixturesDir)) {
    mkdirSync(fixturesDir, { recursive: true });
  }
  console.log(`[fixtures] каталог: ${fixturesDir}`);

  makeWide();
  makeWide2();

  console.log('[fixtures] все фикстуры созданы успешно');
}

try {
  main();
} catch (err) {
  console.error(`[fixtures] ОШИБКА: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
