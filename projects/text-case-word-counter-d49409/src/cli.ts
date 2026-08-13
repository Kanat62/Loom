#!/usr/bin/env node
/**
 * CLI-слой утилиты.
 *
 * Тонкая обёртка над чистыми функциями из ./core: разбирает аргументы
 * командной строки, выбирает режим и печатает результат в stdout.
 *
 * Использование:
 *   node dist/cli.js --upper "hello world"   -> HELLO WORLD
 *   node dist/cli.js --count "hello world"   -> 2
 *   node dist/cli.js "hello world"           -> HELLO WORLD\n2
 */

import { toUpper, countWords } from './core';

/** Режим работы утилиты. */
export type Mode = 'upper' | 'count' | 'both';

/** Результат разбора аргументов командной строки. */
export interface ParsedArgs {
  /** Выбранный режим вывода. */
  mode: Mode;
  /** Обрабатываемая строка (склеенные через пробел позиционные аргументы). */
  text: string;
}

/**
 * Минимально необходимая часть окружения Node.js.
 *
 * Описана локально и достаётся через глобальный объект, чтобы модуль
 * компилировался независимо от наличия деклараций @types/node и не вступал
 * в конфликт с ними (никаких `declare const process`).
 */
export interface ProcessLike {
  argv: string[];
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  exitCode?: number;
}

/** Флаги режима «верхний регистр». */
const UPPER_FLAGS: string[] = ['--upper', '-u'];

/** Флаги режима «подсчёт слов». */
const COUNT_FLAGS: string[] = ['--count', '-c'];

/**
 * Возвращает глобальный объект среды выполнения без обращения к именам,
 * которые могут быть по-разному объявлены в разных наборах библиотек типов.
 *
 * @returns глобальный объект или пустой объект, если получить его не удалось
 */
function getGlobalScope(): { process?: ProcessLike } {
  try {
    const scope = Function('return this')();
    return (scope ? scope : {}) as { process?: ProcessLike };
  } catch (error) {
    return {};
  }
}

/**
 * Возвращает объект процесса Node.js, если код исполняется в Node.
 *
 * @returns объект процесса или undefined
 */
export function getProcess(): ProcessLike | undefined {
  const scope = getGlobalScope();
  const candidate = scope.process;

  if (!candidate || !candidate.argv) {
    return undefined;
  }

  return candidate;
}

/**
 * Проверяет вхождение значения в список.
 *
 * @param list список допустимых значений
 * @param value искомое значение
 * @returns true, если значение найдено
 */
function contains(list: string[], value: string): boolean {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === value) {
      return true;
    }
  }
  return false;
}

/**
 * Определяет, является ли аргумент флагом (начинается с `-` и не пуст).
 *
 * @param arg аргумент командной строки
 * @returns true, если аргумент — флаг
 */
function isFlag(arg: string): boolean {
  return arg.length > 1 && arg.charAt(0) === '-';
}

/**
 * Разбирает список аргументов (без `node` и пути к скрипту).
 *
 * Первый распознанный флаг режима определяет режим; нераспознанные флаги
 * игнорируются, чтобы утилита не падала при обычном использовании. Все
 * остальные аргументы трактуются как части обрабатываемой строки и
 * склеиваются через пробел.
 *
 * @param argv аргументы командной строки
 * @returns режим и обрабатываемая строка
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const source: string[] = argv ? argv : [];
  const parts: string[] = [];
  let mode: Mode = 'both';
  let modeSelected = false;

  for (let i = 0; i < source.length; i += 1) {
    const arg: string = String(source[i]);

    if (isFlag(arg)) {
      if (!modeSelected && contains(UPPER_FLAGS, arg)) {
        mode = 'upper';
        modeSelected = true;
      } else if (!modeSelected && contains(COUNT_FLAGS, arg)) {
        mode = 'count';
        modeSelected = true;
      }
      continue;
    }

    parts.push(arg);
  }

  return { mode: mode, text: parts.join(' ') };
}

/**
 * Формирует строки вывода для заданного режима.
 *
 * @param parsed результат разбора аргументов
 * @returns массив строк, каждая печатается отдельной строкой
 */
export function formatOutput(parsed: ParsedArgs): string[] {
  const text: string = parsed.text;

  if (parsed.mode === 'upper') {
    return [toUpper(text)];
  }

  if (parsed.mode === 'count') {
    return [String(countWords(text))];
  }

  return [toUpper(text), String(countWords(text))];
}

/**
 * Точка входа CLI.
 *
 * @param argv аргументы командной строки без `node` и пути к скрипту
 * @param proc объект процесса для вывода (по умолчанию — текущий процесс)
 * @returns код возврата процесса (0 при успехе)
 */
export function run(argv: string[], proc?: ProcessLike): number {
  const target: ProcessLike | undefined = proc ? proc : getProcess();

  try {
    const lines: string[] = formatOutput(parseArgs(argv));

    if (target && target.stdout) {
      for (let i = 0; i < lines.length; i += 1) {
        target.stdout.write(String(lines[i]) + '\n');
      }
    }

    return 0;
  } catch (error) {
    const message: string = error instanceof Error ? error.message : String(error);

    if (target && target.stderr) {
      target.stderr.write('Ошибка: ' + message + '\n');
    }

    return 1;
  }
}

/**
 * Определяет, запущен ли файл напрямую (`node dist/cli.js ...`),
 * а не импортирован как модуль.
 *
 * @param entryPath путь к запущенному скрипту (`process.argv[1]`)
 * @returns true, если запущен именно этот CLI-файл
 */
export function isDirectRun(entryPath: string | undefined): boolean {
  if (!entryPath) {
    return false;
  }

  const normalized: string = String(entryPath).split('\\').join('/');
  const base: string = normalized.substring(normalized.lastIndexOf('/') + 1);
  const dot: number = base.lastIndexOf('.');
  const name: string = dot > 0 ? base.substring(0, dot) : base;

  return name === 'cli';
}

/* Запуск только при прямом вызове файла. */
const runtime: ProcessLike | undefined = getProcess();

if (runtime && isDirectRun(runtime.argv[1])) {
  runtime.exitCode = run(runtime.argv.slice(2), runtime);
}
