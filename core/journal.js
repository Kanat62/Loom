// core/journal.js - "умный журнал": единственный источник правды (§4, §2 ТЗ).
// Схемы приведены дословно из §4 ТЗ. Журнал не думает - защищает целостность:
// атомарный захват задач (BEGIN IMMEDIATE), зависимости, трейсинг run_id.
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { getDbPath } from './config.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,              -- slug + короткий хеш
  title TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,      -- projects/<id>/
  status TEXT DEFAULT 'active',     -- active | awaiting_approval | delivered | cancelled
  domain TEXT,                      -- ui | cli | lib | data
  created_at INTEGER, last_active_at INTEGER
);

CREATE TABLE IF NOT EXISTS product_spec (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  spec_md TEXT NOT NULL,            -- полный текст ТЗ продукта
  readiness TEXT DEFAULT '[]',      -- JSON: [{text, tier: 'core'|'support'}] (§3.1 ТЗ v5.2)
  core_intent TEXT,                 -- "Ядро замысла" (§3.1 ТЗ v5.2) - 1-2 предложения, ради чего продукт существует
  engineering_defaults TEXT,        -- принятые инженерные решения
  approved_at INTEGER,
  reference_note TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT, spec TEXT,
  criteria TEXT,                    -- JSON: {cmd, expect, timeout_ms} | {regression_of:[ids]}
  role TEXT DEFAULT 'coder',
  type TEXT DEFAULT 'build',        -- build | tweak | regression | pilot_fix | spike (§3.3 ТЗ v5.2)
  status TEXT DEFAULT 'pending',    -- pending|claimed|done|failed|blocked_needs_human|retired
  touches_files TEXT DEFAULT '[]',
  covers TEXT DEFAULT '[]',         -- какие признаки готовности закрывает
  core_check INTEGER DEFAULT 0,     -- §8 правило 13 ТЗ v5.2: критерий проверяет ПРОДУКТ ЦЕЛИКОМ, не кусок
  attempts INTEGER DEFAULT 0,
  level TEXT DEFAULT 'code',        -- code|approach|understanding (уровень §11)
  claimed_by TEXT,
  feedback TEXT,                    -- ТОЛЬКО последний отчёт, не история
  question TEXT,
  spent_usd REAL DEFAULT 0.0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT REFERENCES tasks(id),
  blocked_by TEXT REFERENCES tasks(id),
  PRIMARY KEY (task_id, blocked_by)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  run_id TEXT, project_id TEXT, task_id TEXT,
  type TEXT,          -- thinking|action|test_result|status|usage|pilot|diagnosis|checkpoint
  agent TEXT, duration_ms INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER,
  cost_usd REAL, payload TEXT, created_at INTEGER
);

-- Таблица lessons: НЕ удалена (§6.2 ТЗ v5.2) - данные не выбрасываются, но
-- модуль core/lessons.js и Наставник, которые её использовали, удалены -
-- таблица не читается и не пишется нигде в v5.2. Вернётся вместе с Наставником.
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY,
  scope TEXT,             -- global | project:<id> | stack:<name>
  text TEXT NOT NULL,
  origin TEXT NOT NULL,   -- откуда: project_id + task_id + факт провала
  confirmed_by TEXT,      -- 'human' | NULL. Без 'human' урок НЕ применяется
  created_at INTEGER, applied_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_role ON tasks(project_id, role, status);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_deps(task_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_lessons_scope ON lessons(scope);
`;

/**
 * ensureColumn - идемпотентная миграция колонки. SQLite не умеет
 * "ADD COLUMN IF NOT EXISTS" - ловим ошибку "duplicate column name".
 */
export function ensureColumn(db, table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

function jstr(v) {
  return JSON.stringify(v ?? null);
}

function parseTaskRow(row) {
  if (!row) return null;
  return {
    ...row,
    criteria: JSON.parse(row.criteria ?? 'null'),
    touches_files: JSON.parse(row.touches_files ?? '[]'),
    covers: JSON.parse(row.covers ?? '[]'),
    core_check: !!row.core_check,
  };
}

export async function createJournal(dbPath = getDbPath()) {
  const db = await openDb(dbPath);
  db.exec(SCHEMA_SQL);

  // §6 ТЗ (Context Engineering, фаза 2) - счётчик ходов + карта хешей файлов
  // "как видел прошлый вызов Исполнителя", нужна для дельты (added/removed/
  // changed). Демонстрация ensureColumn как реальной идемпотентной миграции
  // поверх уже существующей таблицы `projects` (SQLite не умеет ADD COLUMN
  // IF NOT EXISTS - см. комментарий у ensureColumn).
  ensureColumn(db, 'projects', 'context_state TEXT');
  // §1.7/§11 ТЗ (Диагност, фаза 7): нужен доступ к рассмотренным Архитектором
  // вариантам (approach.options), чтобы при уровне "approach" перепроектировать
  // ветку ДРУГИМ вариантом, а не с нуля.
  ensureColumn(db, 'projects', 'approach_json TEXT');
  // §3.1/§4 ТЗ v5.2 - "Ядро замысла" и §8 правило 13 - критерий целого на core-задаче.
  ensureColumn(db, 'product_spec', 'core_intent TEXT');
  ensureColumn(db, 'tasks', 'core_check INTEGER DEFAULT 0');

  const stmts = {
    insertProject: db.prepare(
      `INSERT INTO projects (id, title, workspace_dir, status, domain, created_at, last_active_at)
       VALUES (@id, @title, @workspace_dir, @status, @domain, @created_at, @last_active_at)`
    ),
    getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
    listProjects: db.prepare(`SELECT * FROM projects ORDER BY last_active_at DESC`),
    setProjectStatus: db.prepare(
      `UPDATE projects SET status = ?, last_active_at = ? WHERE id = ?`
    ),
    touchProject: db.prepare(`UPDATE projects SET last_active_at = ? WHERE id = ?`),
    getContextState: db.prepare(`SELECT context_state FROM projects WHERE id = ?`),
    setContextState: db.prepare(`UPDATE projects SET context_state = ? WHERE id = ?`),
    getApproach: db.prepare(`SELECT approach_json FROM projects WHERE id = ?`),
    setApproach: db.prepare(`UPDATE projects SET approach_json = ? WHERE id = ?`),

    upsertSpec: db.prepare(
      `INSERT INTO product_spec (project_id, spec_md, readiness, core_intent, engineering_defaults, reference_note)
       VALUES (@project_id, @spec_md, @readiness, @core_intent, @engineering_defaults, @reference_note)
       ON CONFLICT(project_id) DO UPDATE SET
         spec_md=excluded.spec_md,
         readiness=excluded.readiness,
         core_intent=excluded.core_intent,
         engineering_defaults=excluded.engineering_defaults,
         reference_note=excluded.reference_note`
    ),
    getSpec: db.prepare(`SELECT * FROM product_spec WHERE project_id = ?`),
    approveSpec: db.prepare(
      `UPDATE product_spec SET approved_at = ? WHERE project_id = ?`
    ),

    insertTask: db.prepare(
      `INSERT INTO tasks (id, project_id, title, spec, criteria, role, type, touches_files, covers, core_check, created_at)
       VALUES (@id, @project_id, @title, @spec, @criteria, @role, @type, @touches_files, @covers, @core_check, @created_at)`
    ),
    insertDep: db.prepare(
      `INSERT OR IGNORE INTO task_deps (task_id, blocked_by) VALUES (?, ?)`
    ),
    getTask: db.prepare(`SELECT * FROM tasks WHERE id = ? AND project_id = ?`),
    getTaskAnyProject: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    listTasks: db.prepare(
      `SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC`
    ),
    listTasksByStatus: db.prepare(
      `SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY created_at ASC`
    ),

    selectClaimable: db.prepare(
      `SELECT t.id FROM tasks t
       WHERE t.project_id = ? AND t.role = ? AND t.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM task_deps td
           JOIN tasks bt ON bt.id = td.blocked_by
           WHERE td.task_id = t.id AND bt.status != 'done'
         )
       ORDER BY t.created_at ASC
       LIMIT 1`
    ),
    claimById: db.prepare(
      `UPDATE tasks SET status='claimed', claimed_by=? WHERE id=? AND status='pending'`
    ),

    setStatus: db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`),
    requeue: db.prepare(`UPDATE tasks SET status='pending', claimed_by=NULL WHERE id = ?`),
    setFeedback: db.prepare(`UPDATE tasks SET feedback = ? WHERE id = ?`),
    setQuestion: db.prepare(`UPDATE tasks SET question = ? WHERE id = ?`),
    setLevel: db.prepare(`UPDATE tasks SET level = ? WHERE id = ?`),
    incrementAttempts: db.prepare(
      `UPDATE tasks SET attempts = attempts + 1 WHERE id = ?`
    ),
    addSpend: db.prepare(
      `UPDATE tasks SET spent_usd = spent_usd + ? WHERE id = ?`
    ),
    releaseStuck: db.prepare(
      `UPDATE tasks SET status='pending', claimed_by=NULL WHERE status='claimed'`
    ),

    insertEvent: db.prepare(
      `INSERT INTO events (run_id, project_id, task_id, type, agent, duration_ms,
         tokens_in, tokens_out, cache_read, cost_usd, payload, created_at)
       VALUES (@run_id, @project_id, @task_id, @type, @agent, @duration_ms,
         @tokens_in, @tokens_out, @cache_read, @cost_usd, @payload, @created_at)`
    ),
    listEvents: db.prepare(
      `SELECT * FROM events WHERE project_id = ? ORDER BY created_at ASC`
    ),

    insertLesson: db.prepare(
      `INSERT INTO lessons (scope, text, origin, confirmed_by, created_at, applied_count)
       VALUES (@scope, @text, @origin, @confirmed_by, @created_at, 0)`
    ),
    listConfirmedLessons: db.prepare(
      `SELECT * FROM lessons WHERE confirmed_by = 'human' AND (scope = ? OR scope = 'global') ORDER BY created_at ASC`
    ),
    listAllLessons: db.prepare(`SELECT * FROM lessons ORDER BY created_at DESC`),
    bumpLessonApplied: db.prepare(
      `UPDATE lessons SET applied_count = applied_count + 1 WHERE id = ?`
    ),
  };

  const claimTxn = db.transaction((role, projectId, claimedBy) => {
    const row = stmts.selectClaimable.get(projectId, role);
    if (!row) return null;
    const res = stmts.claimById.run(claimedBy, row.id);
    if (res.changes === 0) return null; // задачу перехватил другой процесс
    return parseTaskRow(stmts.getTask.get(row.id, projectId));
  });

  return {
    raw: db,
    backend: db.backend,

    // --- projects ---
    createProject({ id, title, workspace_dir, domain, status = 'active' }) {
      const now = Date.now();
      stmts.insertProject.run({
        id,
        title,
        workspace_dir,
        status,
        domain: domain ?? null,
        created_at: now,
        last_active_at: now,
      });
      return stmts.getProject.get(id);
    },
    getProject(id) {
      return stmts.getProject.get(id);
    },
    listProjects() {
      return stmts.listProjects.all();
    },
    setProjectStatus(id, status) {
      stmts.setProjectStatus.run(status, Date.now(), id);
    },
    touchProject(id) {
      stmts.touchProject.run(Date.now(), id);
    },

    // --- context engineering state (§6 ТЗ, фаза 2) ---
    getContextState(projectId) {
      const row = stmts.getContextState.get(projectId);
      if (!row?.context_state) return { callCount: 0, fileMap: {} };
      try {
        return JSON.parse(row.context_state);
      } catch {
        return { callCount: 0, fileMap: {} };
      }
    },
    setContextState(projectId, state) {
      stmts.setContextState.run(jstr(state), projectId);
    },
    getApproach(projectId) {
      const row = stmts.getApproach.get(projectId);
      if (!row?.approach_json) return null;
      try {
        return JSON.parse(row.approach_json);
      } catch {
        return null;
      }
    },
    setApproach(projectId, approach) {
      stmts.setApproach.run(jstr(approach), projectId);
    },

    // --- product_spec (§4.2: цель ВНЕ контекста агентов) ---
    saveProductSpec({
      project_id,
      spec_md,
      readiness = [],
      core_intent = null,
      engineering_defaults = [],
      reference_note = null,
    }) {
      stmts.upsertSpec.run({
        project_id,
        spec_md,
        readiness: jstr(readiness),
        core_intent,
        engineering_defaults: jstr(engineering_defaults),
        reference_note,
      });
      return this.getProductSpec(project_id);
    },
    getProductSpec(project_id) {
      const row = stmts.getSpec.get(project_id);
      if (!row) return null;
      return {
        ...row,
        readiness: JSON.parse(row.readiness ?? '[]'),
        engineering_defaults: JSON.parse(row.engineering_defaults ?? 'null'),
      };
    },
    approveProductSpec(project_id) {
      stmts.approveSpec.run(Date.now(), project_id);
    },

    // --- tasks ---
    addTask({
      project_id,
      title,
      spec,
      criteria,
      role = 'coder',
      type = 'build',
      touches_files = [],
      covers = [],
      deps = [],
      core_check = false,
    }) {
      const id = `task_${crypto.randomBytes(5).toString('hex')}`;
      stmts.insertTask.run({
        id,
        project_id,
        title,
        spec,
        criteria: jstr(criteria),
        role,
        type,
        touches_files: jstr(touches_files),
        covers: jstr(covers),
        core_check: core_check ? 1 : 0,
        created_at: Date.now(),
      });
      for (const dep of deps) {
        stmts.insertDep.run(id, dep);
      }
      return this.getTask(id, project_id);
    },
    addTaskDep(taskId, blockedById) {
      stmts.insertDep.run(taskId, blockedById);
    },
    getTask(id, project_id) {
      const row = project_id
        ? stmts.getTask.get(id, project_id)
        : stmts.getTaskAnyProject.get(id);
      return parseTaskRow(row);
    },
    listTasks(project_id, { status } = {}) {
      const rows = status
        ? stmts.listTasksByStatus.all(project_id, status)
        : stmts.listTasks.all(project_id);
      return rows.map(parseTaskRow);
    },
    claimNext(role, projectId) {
      const claimedBy = `${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
      return claimTxn(role, projectId, claimedBy);
    },
    setStatus(id, status, { feedback, question } = {}) {
      stmts.setStatus.run(status, id);
      if (feedback !== undefined) stmts.setFeedback.run(feedback, id);
      if (question !== undefined) stmts.setQuestion.run(question, id);
    },
    setLevel(id, level) {
      stmts.setLevel.run(level, id);
    },
    requeueTask(id) {
      stmts.requeue.run(id);
    },
    incrementAttempts(id) {
      stmts.incrementAttempts.run(id);
    },
    addSpend(id, usd) {
      stmts.addSpend.run(usd, id);
    },
    releaseStuck() {
      const res = stmts.releaseStuck.run();
      return res.changes;
    },

    // --- events (§4.4 наблюдаемость) ---
    logEvent({
      run_id,
      project_id,
      task_id = null,
      type,
      agent = null,
      duration_ms = null,
      tokens_in = null,
      tokens_out = null,
      cache_read = null,
      cost_usd = null,
      payload = null,
    }) {
      stmts.insertEvent.run({
        run_id: run_id ?? null,
        project_id: project_id ?? null,
        task_id,
        type,
        agent,
        duration_ms,
        tokens_in,
        tokens_out,
        cache_read,
        cost_usd,
        payload: typeof payload === 'string' ? payload : jstr(payload),
        created_at: Date.now(),
      });
    },
    listEvents(project_id) {
      return stmts.listEvents.all(project_id);
    },

    // --- lessons (§4.5, §12.3 - только confirmed_by=human применяется) ---
    addLesson({ scope, text, origin, confirmed_by = null }) {
      stmts.insertLesson.run({
        scope,
        text,
        origin,
        confirmed_by,
        created_at: Date.now(),
      });
    },
    listConfirmedLessons(scope) {
      return stmts.listConfirmedLessons.all(scope);
    },
    listAllLessons() {
      return stmts.listAllLessons.all();
    },
    bumpLessonApplied(id) {
      stmts.bumpLessonApplied.run(id);
    },

    close() {
      db.close();
    },
  };
}
