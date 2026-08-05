// tests/analyst.test.js - regex-фильтр технических вопросов (§1.1.1 ТЗ, шрам 15)
// и безопасный дефолт route='build' при сбое шлюза/парсинга.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findForbiddenQuestion } from '../agents/analyst.js';
import { setupTestEnv } from './harness/env.js';

test('findForbiddenQuestion: пропускает нормальные вопросы о результате', () => {
  assert.equal(findForbiddenQuestion(['Как должен выглядеть готовый результат для пользователя?']), null);
  assert.equal(findForbiddenQuestion(['По каким признакам ты поймёшь, что страница готова?']), null);
  assert.equal(findForbiddenQuestion([]), null);
  assert.equal(findForbiddenQuestion(undefined), null);
});

test('findForbiddenQuestion: отклоняет числа с единицами (px/мс/fps/...)', () => {
  assert.ok(findForbiddenQuestion(['Ширина кнопки должна быть 200px или больше?']));
  assert.ok(findForbiddenQuestion(['Задержка анимации 300мс подойдёт?']));
  assert.ok(findForbiddenQuestion(['Видео должно идти на 30fps?']));
});

test('findForbiddenQuestion: отклоняет названия технологий', () => {
  assert.ok(findForbiddenQuestion(['Делать фронтенд на React?']));
  assert.ok(findForbiddenQuestion(['Нужна база данных для хранения карточек?']));
  assert.ok(findForbiddenQuestion(['Использовать ffmpeg для конвертации?']));
});

test('findForbiddenQuestion: отклоняет формулировки выбора реализации', () => {
  assert.ok(findForbiddenQuestion(['Какой из вариантов хранения предпочесть?']));
  assert.ok(findForbiddenQuestion(['Использовать ли кэширование на клиенте?']));
});

test('findForbiddenQuestion: без \\b - работает на кириллице (§19.11 ТЗ)', () => {
  // Регэксп без границ слова: кириллица не имеет \b-семантики в JS regex,
  // проверяем, что паттерн всё равно матчит внутри кириллического текста.
  const hit = findForbiddenQuestion(['Нужен ли отдельный сервер для этого?']);
  assert.ok(hit);
  assert.match(hit.question, /сервер/);
});

test('runAnalyst: сбой шлюза (все модели недоступны) -> безопасный дефолт route=build', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'exit1' });
  try {
    const { runAnalyst } = await import('../agents/analyst.js');
    const { createJournal } = await import('../core/journal.js');
    const journal = await createJournal();
    const result = await runAnalyst({
      transcript: [{ from: 'human', text: 'хочу сайт' }],
      project: null,
      journal,
      runId: 'r1',
      gatewayOpts: { roundPauseMs: 10 },
    });
    assert.equal(result.route, 'build');
    journal.close();
  } finally {
    env.cleanup();
  }
});

test('runAnalyst: невалидный JSON от модели (после исчерпания ретраев) -> безопасный дефолт route=build', async () => {
  const env = setupTestEnv({ fakeClaudeMode: 'ok', fakeClaudeResult: 'это не json, а прозаический ответ' });
  try {
    const { runAnalyst } = await import('../agents/analyst.js');
    const { createJournal } = await import('../core/journal.js');
    const journal = await createJournal();
    const result = await runAnalyst({
      transcript: [{ from: 'human', text: 'хочу сайт' }],
      project: null,
      journal,
      runId: 'r1',
      gatewayOpts: { roundPauseMs: 10 },
    });
    assert.equal(result.route, 'build');
    journal.close();
  } finally {
    env.cleanup();
  }
});
