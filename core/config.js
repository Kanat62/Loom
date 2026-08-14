// core/config.js - механика без интеллекта: тиры, таймауты, пути.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// LOOM_HOME переопределяет корень состояния (журнал + projects/) - используется
// тестами (tests/harness/env.js), не булев MOCK-флаг (§19.10 ТЗ).
//
// ВАЖНО: эти пути - ФУНКЦИИ, не замороженные на момент импорта константы.
// ESM-импорты хостятся и выполняются раньше любого кода теста, поэтому
// `process.env.LOOM_HOME = ...`, установленный ВНУТРИ тела test(), не успел
// бы повлиять на константу, вычисленную один раз при первом импорте модуля
// (а модуль почти наверняка уже импортирован транзитивно раньше). Функции
// читают env на каждый вызов - изоляция тестов работает независимо от того,
// когда именно был импортирован config.js в данном процессе.
export function getStateRoot() {
  return process.env.LOOM_HOME ? path.resolve(process.env.LOOM_HOME) : ROOT;
}
export function getProjectsDir() {
  return path.join(getStateRoot(), 'projects');
}
export function getDbPath() {
  return path.join(getStateRoot(), 'journal.db');
}
export function getTmpDir() {
  return path.join(getStateRoot(), '.loom-tmp');
}

// prompts/ - статичные файлы репозитория LOOM, не зависят от LOOM_HOME.
export const PROMPTS_DIR = path.join(ROOT, 'prompts');

// §5.2 ТЗ - роли и цепочки моделей (тир -> следующий тир при технической неудаче).
// v5.2: Аналитик+Архитектор+Консультант+свод Дизайнера слиты в engineer -
// одна голова держит понимание, план и сдачу (§1.1 ТЗ v5.2, шрам 44/45).
export const ROLES = {
  engineer: ['claude-cli:opus', 'claude-cli:sonnet'],
  coder: ['claude-cli:sonnet', 'claude-cli:opus'], // эскалация при провале
  pilot: ['claude-cli:sonnet', 'claude-cli:opus'],
  diagnostician: ['claude-cli:opus'],
};

// §3.2 ТЗ v5.2 - сверка целого (checkpoint): каждая N-я закрытая задача.
export const CHECKPOINT_EVERY_N_DONE = 3;

// §3.3 ТЗ v5.2 - разведка (spike): лимит попыток меньше обычного (§7) - сама
// неуложившаяся разведка уже результат, не повод упорствовать до общего MAX_ATTEMPTS.
export const SPIKE_MAX_ATTEMPTS = 3;

// §7 ТЗ - лестница попыток.
export const MAX_ATTEMPTS = 4;

// §5.2 ТЗ - таймаут вызова модели (шрам 12: 180с убивал честно думающую
// модель -> 300с). Экзамен §22 (реальный прогон) поднял ту же проблему на
// новом уровне: Архитектор для видео-проекта с реальным исследовательским
// зерном (§22 ТЗ - настоящая неопределённость в подходе к автослежению)
// честно думал 559с и вернул качественный план (12 задач, 3 варианта
// approach) - 300с убили бы его посреди работы. Поднято до 900с с запасом.
export const MODEL_TIMEOUT_MS = 900_000;

// §5.2 ТЗ - два круга по всем моделям, пауза между кругами (шрам 13).
export const GATEWAY_ROUNDS = 2;
export const GATEWAY_ROUND_PAUSE_MS = 60_000;

// §8.8 ТЗ - таймауты критериев по классу, в коде, не в промпте (шрам 37).
export const CHECK_TIMEOUT_MS = {
  node: 10_000,
  browser: 60_000, // Playwright/chromium
  ffmpeg: 120_000, // обработка видео
  max: 180_000, // потолок
};

// §16.2 ТЗ - опорный стек: HeroUI v3 запинена жёстко, одна версия на все проекты v1.
export const HEROUI_VERSION = '3.0.0-alpha.7';

// §19.9 ТЗ - лимиты длины ввода: 4000 для содержательного, 500 для команд.
export const INPUT_LIMIT_CONTENT = 4000;
export const INPUT_LIMIT_COMMAND = 500;

// §5.1 ТЗ - claude-cli провайдер: команда исполняемого файла claude (Windows: .cmd -> shell:true).
export const CLAUDE_BIN = 'claude';

// Модельные тиры -> имена моделей claude-cli.
export const MODEL_TIER_NAMES = {
  opus: 'opus',
  sonnet: 'sonnet',
};
