// tests/context.test.js - Context Engineering (§6 ТЗ, фаза 2): дельта, не
// снимок; фильтр мусора; релевантность (полный текст только touches_files).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournal } from '../core/journal.js';
import { createProject } from '../core/projects.js';
import { buildCoderContext } from '../core/context.js';

function setLoomHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-context-'));
  process.env.LOOM_HOME = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.LOOM_HOME;
  // Windows иногда держит journal.db-wal/-shm короткое время после close() -
  // гигиена тестового окружения, не свойство продакшн-кода (см. tests/harness/env.js).
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 9) {
        process.stderr.write(`[loom test] не удалось удалить ${dir}: ${err.message}\n`);
        return;
      }
      const until = Date.now() + 300;
      while (Date.now() < until) {
        /* короткая синхронная пауза перед повтором */
      }
    }
  }
}

test('context: ход 1-2 - полный снимок; ход 3+ - только дельта', async () => {
  const dir = setLoomHome();
  try {
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Context Demo', domain: 'cli' });
    const ws = project.workspace_dir;

    // Ход 1: workspace уже содержит .gitignore из scaffold'а проекта - это
    // тоже "полный снимок" (ход<=2), просто маленький.
    const ctx1 = buildCoderContext(journal, project.id, []);
    assert.match(ctx1, /Полный снимок/);

    // "Исполнитель" пишет первый файл между ходами.
    fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 1;\n');

    // Ход 2: всё ещё полный снимок (правило "ход<=2") - должен содержать a.js целиком.
    const ctx2 = buildCoderContext(journal, project.id, ['a.js']);
    assert.match(ctx2, /Полный снимок/);
    assert.match(ctx2, /a\.js/);
    assert.match(ctx2, /module\.exports = 1;/);

    // Между ходом 2 и 3: b.js добавлен, a.js изменён.
    fs.writeFileSync(path.join(ws, 'a.js'), 'module.exports = 2;\n');
    fs.writeFileSync(path.join(ws, 'b.js'), 'module.exports = 99;\n');

    // Ход 3: только дельта - НЕ должен содержать полный список всех файлов как "снимок".
    const ctx3 = buildCoderContext(journal, project.id, ['b.js']);
    assert.match(ctx3, /Дельта с прошлого хода/);
    assert.match(ctx3, /\[ДОБАВЛЕН\].*b\.js/s);
    assert.match(ctx3, /\[ИЗМЕНЁН\].*a\.js/s);
    assert.doesNotMatch(ctx3, /Полный снимок/);

    journal.close();
  } finally {
    cleanup(dir);
  }
});

test('context: релевантность - touches_files получают полный текст, остальные - имя + 30 строк', async () => {
  const dir = setLoomHome();
  try {
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Relevance Demo', domain: 'cli' });
    const ws = project.workspace_dir;

    const longFile = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(ws, 'touched.js'), longFile);
    fs.writeFileSync(path.join(ws, 'other.js'), longFile);

    buildCoderContext(journal, project.id, []); // ход 1 (пустой на момент вызова - файлы уже на диске? см. ниже)

    // Файлы уже существовали ДО первого вызова - ход 1 покажет их как "полный
    // снимок" (условие "ход<=2 ИЛИ ещё нет валидной карты"), поэтому релевантность
    // проверяем на ходу 2, где явная логика full-snapshot тоже применяет relevance.
    const ctx2 = buildCoderContext(journal, project.id, ['touched.js']);

    assert.match(ctx2, /touched\.js \(полностью, затрагивается задачей\)/);
    assert.match(ctx2, /line 59/, 'touched.js должен быть показан целиком, включая последнюю строку');

    assert.match(ctx2, /other\.js \(первые 30 строк\)/);
    const otherStart = ctx2.indexOf('--- other.js');
    const otherEnd = ctx2.indexOf('\n\n---', otherStart);
    const otherSection = ctx2.slice(otherStart, otherEnd === -1 ? undefined : otherEnd);
    assert.doesNotMatch(otherSection, /line 59/, 'other.js не должен содержать строку 59 (обрезан до 30 строк)');

    journal.close();
  } finally {
    cleanup(dir);
  }
});

test('context: состояние переживает переоткрытие журнала (симуляция перезапуска процесса)', async () => {
  const dir = setLoomHome();
  try {
    const dbPath = path.join(dir, 'journal.db');
    let journal = await createJournal(dbPath);
    const project = createProject(journal, { title: 'Restart Demo', domain: 'cli' });
    const ws = project.workspace_dir;

    fs.writeFileSync(path.join(ws, 'a.js'), 'v1');
    buildCoderContext(journal, project.id, []); // ход 1
    fs.writeFileSync(path.join(ws, 'a.js'), 'v2');
    buildCoderContext(journal, project.id, []); // ход 2 (полный снимок, сохраняет fileMap)
    journal.close();

    // "Процесс убит и перезапущен" - новое соединение с той же БД.
    journal = await createJournal(dbPath);
    fs.writeFileSync(path.join(ws, 'a.js'), 'v3');
    const ctx3 = buildCoderContext(journal, project.id, ['a.js']);
    assert.match(ctx3, /Дельта с прошлого хода/);
    assert.match(ctx3, /\[ИЗМЕНЁН\].*a\.js/s);

    journal.close();
  } finally {
    cleanup(dir);
  }
});

test('context: фильтр мусора - .min.js и файлы >50КБ показываются заглушкой, не содержимым', async () => {
  const dir = setLoomHome();
  try {
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Garbage Demo', domain: 'cli' });
    const ws = project.workspace_dir;

    fs.writeFileSync(path.join(ws, 'lib.min.js'), 'SECRET_MARKER_CONTENT'.repeat(10));
    fs.writeFileSync(path.join(ws, 'huge.js'), 'x'.repeat(60 * 1024));

    const ctx = buildCoderContext(journal, project.id, ['lib.min.js', 'huge.js']);
    assert.doesNotMatch(ctx, /SECRET_MARKER_CONTENT/);
    assert.match(ctx, /не читается/);

    journal.close();
  } finally {
    cleanup(dir);
  }
});
