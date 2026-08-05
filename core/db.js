// core/db.js - адаптер БД: better-sqlite3 предпочтительно, node:sqlite фолбэк.
// Причина: нативная сборка better-sqlite3 иногда падает на Windows (§19.8 ТЗ).
// Оба бэкенда представлены единым интерфейсом: prepare/exec/pragma/transaction/close.
import path from 'node:path';
import fs from 'node:fs';

function wrapBetterSqlite3(DatabaseCtor, dbPath) {
  const raw = new DatabaseCtor(dbPath);
  raw.pragma('journal_mode = WAL');
  return {
    backend: 'better-sqlite3',
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run: (...args) => stmt.run(...args),
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      };
    },
    // BEGIN IMMEDIATE с первого дня (§4.3 ТЗ) - атомарный захват задач требует
    // немедленной write-lock, а не отложенной (deferred) транзакции.
    // better-sqlite3: `.immediate` - альтернативная вызываемая форма той же
    // транзакции (не модификатор, возвращающий новую функцию без аргументов).
    transaction(fn) {
      const wrapped = raw.transaction(fn);
      return (...args) => wrapped.immediate(...args);
    },
    close() {
      raw.close();
    },
  };
}

function wrapNodeSqlite(DatabaseSync, dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL');
  return {
    backend: 'node:sqlite',
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      const stmt = raw.prepare(sql);
      return {
        run: (...args) => stmt.run(...args),
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
      };
    },
    // node:sqlite has no built-in transaction() helper - emulate with BEGIN IMMEDIATE.
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* rollback best-effort */
          }
          throw err;
        }
      };
    },
    close() {
      raw.close();
    },
  };
}

export async function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  try {
    const mod = await import('better-sqlite3');
    return wrapBetterSqlite3(mod.default ?? mod, dbPath);
  } catch (err) {
    // Ожидаемый путь на машинах без build tools для нативных модулей - фолбэк, не ошибка.
    const mod = await import('node:sqlite');
    return wrapNodeSqlite(mod.DatabaseSync, dbPath);
  }
}
