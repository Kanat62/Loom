// core/stats.js - отчёт о расходе (§17.1 ТЗ). НЕ отдельный механизм - чистый
// SQL-агрегат по `events` (данные уже пишутся с первого вызова модели, §4.4).
// Ни одного вызова модели здесь. Роли БЕЗ вызовов модели (checker) в таблицу
// не попадают - это правильно, они бесплатны.

/**
 * getUsageByRole - §17.1 ТЗ, запрос "по ролям".
 */
export function getUsageByRole(journal, projectId) {
  return journal.raw
    .prepare(
      `SELECT agent, COUNT(*) calls, SUM(tokens_in) tin, SUM(tokens_out) tout,
              SUM(cache_read) cached, ROUND(SUM(cost_usd),4) cost,
              SUM(duration_ms) ms
       FROM events WHERE project_id = ? AND type = 'usage'
       GROUP BY agent ORDER BY cost DESC`
    )
    .all(projectId);
}

/**
 * getCalendarTime - §17.1 ТЗ, "календарное время" - от первого до последнего
 * события (включает ожидание утверждения product_spec человеком, паузы).
 */
export function getCalendarTime(journal, projectId) {
  return journal.raw
    .prepare(`SELECT MIN(created_at) first, MAX(created_at) last FROM events WHERE project_id = ?`)
    .get(projectId);
}

/**
 * getAttemptsDistribution - §17.1 ТЗ, "качество": распределение done-задач
 * по числу попыток - метрика качества самого LOOM (растёт доля "с первой
 * попытки" от проекта к проекту -> система учится, §12 ТЗ).
 */
export function getAttemptsDistribution(journal, projectId) {
  return journal.raw
    .prepare(`SELECT attempts, COUNT(*) n FROM tasks WHERE project_id = ? AND status = 'done' GROUP BY attempts ORDER BY attempts`)
    .all(projectId);
}

function fmtDuration(ms) {
  if (!ms) return '0с';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}м ${sec}с` : `${sec}с`;
}

function pad(str, width) {
  str = String(str);
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}
function padLeft(str, width) {
  str = String(str);
  return str.length >= width ? str : ' '.repeat(width - str.length) + str;
}

/**
 * formatSpendReport - собирает текстовую таблицу в формате §17.1 ТЗ.
 * Пункт 8 отчёта Консультанта - harness добавляет это как есть, LLM не
 * генерирует числа сам.
 */
export function formatSpendReport(journal, projectId) {
  const rows = getUsageByRole(journal, projectId);
  const calendar = getCalendarTime(journal, projectId);
  const attemptsDist = getAttemptsDistribution(journal, projectId);

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalTin = rows.reduce((s, r) => s + (r.tin ?? 0), 0);
  const totalTout = rows.reduce((s, r) => s + (r.tout ?? 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
  const totalMs = rows.reduce((s, r) => s + (r.ms ?? 0), 0);
  const totalCached = rows.reduce((s, r) => s + (r.cached ?? 0), 0);

  const lines = [];
  lines.push(`${pad('Роль', 15)} ${padLeft('Вызовов', 8)} ${padLeft('Токенов вх.', 12)} ${padLeft('Токенов вых.', 13)} ${padLeft('Стоимость', 10)} ${padLeft('Время', 8)}`);
  lines.push('─'.repeat(75));
  for (const r of rows) {
    lines.push(
      `${pad(r.agent ?? '(?)', 15)} ${padLeft(r.calls, 8)} ${padLeft(r.tin ?? 0, 12)} ${padLeft(r.tout ?? 0, 13)} ${padLeft(`$${(r.cost ?? 0).toFixed(2)}`, 10)} ${padLeft(fmtDuration(r.ms), 8)}`
    );
  }
  lines.push('─'.repeat(75));
  lines.push(
    `${pad('ИТОГО', 15)} ${padLeft(totalCalls, 8)} ${padLeft(totalTin, 12)} ${padLeft(totalTout, 13)} ${padLeft(`$${totalCost.toFixed(2)}`, 10)} ${padLeft(fmtDuration(totalMs), 8)}`
  );
  lines.push('');

  const calendarMs = calendar.first && calendar.last ? calendar.last - calendar.first : 0;
  lines.push(`Календарное время: ${fmtDuration(calendarMs)} (включая ожидание утверждения ТЗ, паузы между запусками)`);

  const doneTotal = attemptsDist.reduce((s, r) => s + r.n, 0);
  const firstTry = attemptsDist.find((r) => r.attempts === 1)?.n ?? 0;
  const distText = attemptsDist.map((r) => `с попытки ${r.attempts}: ${r.n}`).join(', ');
  lines.push(`Задач done: ${doneTotal} (с первой попытки: ${firstTry}${distText ? ` | ${distText}` : ''})`);

  if (totalCached > 0) {
    lines.push(`Кэш сэкономил: ${totalCached} токенов`);
  }

  return lines.join('\n');
}
