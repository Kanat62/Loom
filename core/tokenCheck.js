// core/tokenCheck.js - критерий связности токенов (§8 правило 12 ТЗ v5.2,
// шрам 40). Каждый var(--x) в CSS/HTML продукта обязан быть объявлен в
// design/tokens.css - иначе дизайн-система и вёрстка говорят на разных
// языках имён, и все var() уходят в пустоту молча (найдено на экзамене:
// Дизайнер выпустил 84 токена, Исполнитель написал CSS к 28 придуманным -
// ни одно имя не совпало, критерий "оформление по системе" исключал design/
// из обхода и не мог этого заметить). Проверка ЧИТАЕТ каталог design/ - в
// этом и была дыра прежнего критерия.
//
// Код-уровневая проверка, не полагающаяся на то, что LLM не забудет вписать
// критерий в дерево задач (правило 12 явно требует харнесс-энфорсмента) -
// вызывается coordinator.js как часть гейта сдачи (canDeliver).
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.history', '.loom-tmp', 'dist', 'build']);
const STYLE_FILE_RE = /\.(css|html)$/i;
const VAR_DEF_RE = /(--[a-zA-Z0-9-_]+)\s*:/g;
const VAR_USE_RE = /var\(\s*(--[a-zA-Z0-9-_]+)/g;

function listStyleSources(rootDir) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (STYLE_FILE_RE.test(entry.name)) results.push(full);
    }
  }
  walk(rootDir);
  return results;
}

function collectMatches(files, re) {
  const set = new Set();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(re)) set.add(m[1]);
  }
  return set;
}

/**
 * checkTokenConnectivity - true если design/ отсутствует (проверка неприменима
 * - продукт без дизайн-системы), иначе сравнивает объявленные --токены в
 * design/**\/*.{css,html} с использованными var(--x) во ВСЕХ ОСТАЛЬНЫХ
 * .css/.html продукта. Провал -> честный список необъявленных имён (§8.4:
 * говорящий провал).
 */
export function checkTokenConnectivity(projectDir) {
  const designDir = path.join(projectDir, 'design');
  if (!fs.existsSync(designDir)) {
    return { pass: true, undefinedTokens: [], report: 'OK: design/ отсутствует - продукт без дизайн-системы, проверка неприменима' };
  }

  const defined = collectMatches(listStyleSources(designDir), VAR_DEF_RE);

  const productFiles = listStyleSources(projectDir).filter((f) => !f.startsWith(designDir + path.sep) && f !== designDir);
  const used = collectMatches(productFiles, VAR_USE_RE);

  const undefinedTokens = [...used].filter((name) => !defined.has(name)).sort();
  if (undefinedTokens.length === 0) {
    return {
      pass: true,
      undefinedTokens: [],
      report: `OK: undefined_tokens=0 (объявлено ${defined.size}, использовано ${used.size})`,
    };
  }
  return {
    pass: false,
    undefinedTokens,
    report: `FAIL: undefined_tokens=${undefinedTokens.length} [${undefinedTokens.join(', ')}] expected=0`,
  };
}
