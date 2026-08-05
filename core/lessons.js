// core/lessons.js - постоянная память (§4.5, §12.3 ТЗ). Урок без
// confirmed_by='human' НЕ применяется ни в одном промпте - арбитр знания
// тимлид, не модель. Урока нет -> SKIP, ничего не пишется (пустой урок хуже
// отсутствующего).
//
// Опорный стек LOOM v1 (§16.2 ТЗ): TypeScript/Node, React+HeroUI, Fastify/
// Express, SQLite. Урок, упоминающий чужой стек - явный признак галлюцинации
// (шрам 24, применённый к памяти, а не только к UI-библиотеке).
const FOREIGN_TECH_RE = /\b(python|django|flask|unity3d|unity|c#|\.net|dotnet|java\b|spring boot|kotlin|swift|ruby|rails|php|laravel|go\s?lang|rust\b)\b/i;

/**
 * passesHallucinationFilter - true, если текст урока не упоминает
 * технологии, чуждые опорному стеку LOOM.
 */
export function passesHallucinationFilter(text) {
  return !FOREIGN_TECH_RE.test(String(text ?? ''));
}

/**
 * confirmAndSaveLesson - записывает урок ТОЛЬКО после явного подтверждения
 * человеком (§12.3 ТЗ). Отбрасывает урок, не прошедший фильтр галлюцинаций
 * или без origin (происхождение обязательно - позволяет найти и выдрать
 * отравленный урок вместе со всем, что от него заражено).
 */
export function confirmAndSaveLesson(journal, { scope, text, origin }) {
  if (!text || !text.trim()) return { saved: false, reason: 'empty_text' };
  if (!origin || !origin.trim()) return { saved: false, reason: 'missing_origin' };
  if (!passesHallucinationFilter(text)) return { saved: false, reason: 'foreign_tech_mentioned' };

  journal.addLesson({ scope: scope || 'global', text, origin, confirmed_by: 'human' });
  return { saved: true };
}

/**
 * formatLessonsForPrompt - урок(и) в текст для user-контекста роли.
 * Нет подтверждённых уроков для scope -> null (SKIP, ничего не подставляем).
 */
export function formatLessonsForPrompt(journal, scope) {
  const lessons = journal.listConfirmedLessons(scope);
  if (!lessons.length) return null;
  return lessons.map((l) => `- [${l.scope}] ${l.text}`).join('\n');
}

export function bumpLessonsApplied(journal, scope) {
  const lessons = journal.listConfirmedLessons(scope);
  for (const l of lessons) journal.bumpLessonApplied(l.id);
}
