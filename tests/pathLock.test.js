// tests/pathLock.test.js - замок пути (§15.1 ТЗ): запись только под projects/<id>/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournal } from '../core/journal.js';
import { createProject } from '../core/projects.js';
import { resolveSafePath, writeFilesSafely, PathLockViolation } from '../core/pathLock.js';

test('pathLock: разрешённый путь внутри проекта резолвится и пишется', async () => {
  process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pathlock-'));
  const journal = await createJournal(path.join(process.env.LOOM_HOME, 'journal.db'));
  const project = createProject(journal, { title: 'Path Lock Demo', domain: 'cli' });

  const events = [];
  const written = writeFilesSafely(project.id, { 'src/index.js': 'console.log(1)' }, { logEvent: (e) => events.push(e) });
  assert.deepEqual(written, ['src/index.js']);
  const full = resolveSafePath(project.id, 'src/index.js');
  assert.equal(fs.readFileSync(full, 'utf8'), 'console.log(1)');
  assert.equal(events.length, 0);

  journal.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  delete process.env.LOOM_HOME;
});

test('pathLock: попытка выйти за пределы проекта (../) блокируется и логируется, ничего не пишется', async () => {
  process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pathlock-'));
  const journal = await createJournal(path.join(process.env.LOOM_HOME, 'journal.db'));
  const project = createProject(journal, { title: 'Escape Attempt', domain: 'cli' });

  const events = [];
  assert.throws(
    () =>
      writeFilesSafely(
        project.id,
        { 'ok.js': 'safe', '../evil.js': 'escaped' },
        { logEvent: (e) => events.push(e), runId: 'r1', taskId: 't1' }
      ),
    PathLockViolation
  );

  // Ничего не должно было записаться - ни ok.js, ни evil.js (двухпроходная защита).
  assert.equal(fs.existsSync(path.join(project.workspace_dir, 'ok.js')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(project.workspace_dir), 'evil.js')), false);

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.kind, 'path_lock_violation');

  journal.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  delete process.env.LOOM_HOME;
});

test('pathLock: абсолютный путь вне проекта тоже блокируется', async () => {
  process.env.LOOM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pathlock-'));
  const journal = await createJournal(path.join(process.env.LOOM_HOME, 'journal.db'));
  const project = createProject(journal, { title: 'Absolute Escape', domain: 'cli' });

  const evilAbs = path.join(os.tmpdir(), 'loom-absolute-escape.txt');
  assert.throws(() => resolveSafePath(project.id, evilAbs), PathLockViolation);

  journal.close();
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
  delete process.env.LOOM_HOME;
});
