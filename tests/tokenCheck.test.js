// tests/tokenCheck.test.js - связность токенов дизайн-системы (§8 правило 12
// ТЗ v5.2, шрам 40/41). Каждая var(--x) в CSS/HTML продукта обязана быть
// объявлена в design/tokens.css, иначе честный список необъявленных имён.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTokenConnectivity } from '../core/tokenCheck.js';

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tokencheck-'));
}

test('checkTokenConnectivity: design/ отсутствует -> pass (проверка неприменима)', () => {
  const dir = mkProject();
  try {
    const result = checkTokenConnectivity(dir);
    assert.equal(result.pass, true);
    assert.deepEqual(result.undefinedTokens, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTokenConnectivity: все использованные имена объявлены -> pass', () => {
  const dir = mkProject();
  try {
    fs.mkdirSync(path.join(dir, 'design'));
    fs.writeFileSync(path.join(dir, 'design', 'tokens.css'), ':root { --surface: oklch(98% 0 0); --accent: oklch(60% 0.15 250); }');
    fs.writeFileSync(path.join(dir, 'index.html'), '<style>body{background:var(--surface);color:var(--accent)}</style>');

    const result = checkTokenConnectivity(dir);
    assert.equal(result.pass, true);
    assert.deepEqual(result.undefinedTokens, []);
    assert.match(result.report, /undefined_tokens=0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTokenConnectivity: имена НЕ совпадают (дизайн-система против придуманных Исполнителем) -> fail со списком (шрам 40)', () => {
  const dir = mkProject();
  try {
    fs.mkdirSync(path.join(dir, 'design'));
    fs.writeFileSync(path.join(dir, 'design', 'tokens.css'), ':root { --background: oklch(98% 0 0); --content: oklch(20% 0 0); }');
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<style>body{background:var(--color-bg);color:var(--color-text);font-family:var(--font-family-base)}</style>'
    );

    const result = checkTokenConnectivity(dir);
    assert.equal(result.pass, false);
    assert.deepEqual(result.undefinedTokens, ['--color-bg', '--color-text', '--font-family-base']);
    assert.match(result.report, /FAIL: undefined_tokens=3/);
    assert.match(result.report, /--color-bg/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTokenConnectivity: игнорирует использования ВНУТРИ design/ (это сама дизайн-система, не продукт)', () => {
  const dir = mkProject();
  try {
    fs.mkdirSync(path.join(dir, 'design'));
    // tokens.css сам ссылается на другой токен через var() - это нормально
    // внутри дизайн-системы, не должно считаться использованием продукта.
    fs.writeFileSync(
      path.join(dir, 'design', 'tokens.css'),
      ':root { --base: oklch(50% 0 0); --accent: var(--base); }'
    );

    const result = checkTokenConnectivity(dir);
    assert.equal(result.pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTokenConnectivity: читает каталог design/ реально (не полагается на слова промпта) - правило 11/40', () => {
  const dir = mkProject();
  try {
    fs.mkdirSync(path.join(dir, 'design'));
    fs.writeFileSync(path.join(dir, 'design', 'tokens.css'), ':root { --brand-primary: oklch(55% 0.2 30); }');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.css'), '.button { background: var(--brand-primary); border-color: var(--missing-one); }');

    const result = checkTokenConnectivity(dir);
    assert.equal(result.pass, false);
    assert.deepEqual(result.undefinedTokens, ['--missing-one']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
