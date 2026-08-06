// tests/lessons.test.js - постоянная память (§4.5, §12.3 ТЗ): неподтверждённый
// урок не применяется, фильтр галлюцинаций отклоняет чужие технологии.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './harness/env.js';

async function freshImports() {
  const journalMod = await import('../core/journal.js');
  const projectsMod = await import('../core/projects.js');
  const lessonsMod = await import('../core/lessons.js');
  return { ...journalMod, ...projectsMod, ...lessonsMod };
}

test('lessons: passesHallucinationFilter отклоняет упоминание чужого стека', async () => {
  const { passesHallucinationFilter } = await import('../core/lessons.js');
  assert.equal(passesHallucinationFilter('Не забывай проверять package.json перед npm install'), true);
  assert.equal(passesHallucinationFilter('Используй Python для парсинга - надёжнее'), false);
  assert.equal(passesHallucinationFilter('Это Unity-проект, следи за префабами'), false);
  assert.equal(passesHallucinationFilter('C# тут не подходит, пиши на TypeScript'), false);
});

test('lessons: confirmAndSaveLesson отклоняет пустой текст и отсутствие origin', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, confirmAndSaveLesson } = await freshImports();
    const journal = await createJournal();

    assert.equal(confirmAndSaveLesson(journal, { scope: 'global', text: '', origin: 'x' }).saved, false);
    assert.equal(confirmAndSaveLesson(journal, { scope: 'global', text: 'урок', origin: '' }).saved, false);
    assert.equal(
      confirmAndSaveLesson(journal, { scope: 'global', text: 'используй Python для скриптов сборки', origin: 'proj:task1' }).saved,
      false
    );

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('lessons: подтверждённый урок сохраняется и появляется в formatLessonsForPrompt; неподтверждённый - нет', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, confirmAndSaveLesson, formatLessonsForPrompt } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Lessons Demo', domain: 'cli' });

    // Урок БЕЗ confirmed_by (напрямую в БД, минуя confirmAndSaveLesson) - не должен применяться.
    journal.addLesson({ scope: `project:${project.id}`, text: 'неподтверждённый урок', origin: 'x', confirmed_by: null });
    let text = formatLessonsForPrompt(journal, `project:${project.id}`);
    assert.equal(text, null, 'урок без confirmed_by=human не должен появляться в промпте');

    const saved = confirmAndSaveLesson(journal, {
      scope: `project:${project.id}`,
      text: 'всегда пиши package.json с минимальным экранированием JSON',
      origin: `${project.id}: провал на попытке 4`,
    });
    assert.equal(saved.saved, true);

    text = formatLessonsForPrompt(journal, `project:${project.id}`);
    assert.match(text, /минимальным экранированием/);

    journal.close();
  } finally {
    env.cleanup();
  }
});

test('lessons: formatLessonsForPrompt возвращает null (SKIP), когда уроков нет', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, formatLessonsForPrompt } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'No Lessons', domain: 'cli' });
    assert.equal(formatLessonsForPrompt(journal, `project:${project.id}`), null);
    journal.close();
  } finally {
    env.cleanup();
  }
});

test('lessons: scope=global применяется вместе с project-scope', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok' });
  try {
    const { createJournal, createProject, confirmAndSaveLesson, formatLessonsForPrompt } = await freshImports();
    const journal = await createJournal();
    const project = createProject(journal, { title: 'Global Demo', domain: 'cli' });

    confirmAndSaveLesson(journal, { scope: 'global', text: 'глобальный урок про JSON', origin: 'other-project: провал' });
    confirmAndSaveLesson(journal, { scope: `project:${project.id}`, text: 'локальный урок этого проекта', origin: `${project.id}: провал` });

    const text = formatLessonsForPrompt(journal, `project:${project.id}`);
    assert.match(text, /глобальный урок/);
    assert.match(text, /локальный урок/);

    journal.close();
  } finally {
    env.cleanup();
  }
});
