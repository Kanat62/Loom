// tests/productSpec.test.js - защита от тихой перегенерации при правке product_spec (§1.1 ТЗ).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecSections, findUntouchedViolations } from '../core/productSpec.js';

const SAMPLE = `## 1. Что это
Одностраничник с карточками.

## 2. Как работает
Человек открывает страницу, видит три карточки.

## 3. Что на выходе
Статичная HTML-страница.

## 4. Признаки готовности
1. страница открывается
2. видно три карточки

## 5. Границы
Без бэкенда.

## 6. Инженерные решения
- React + статичная сборка

## 7. Открытые вопросы
нет
`;

test('parseSpecSections: находит все 7 секций по заголовкам', () => {
  const sections = parseSpecSections(SAMPLE);
  assert.equal(Object.keys(sections).length, 7);
  assert.match(sections[1], /Одностраничник/);
  assert.match(sections[4], /три карточки/);
});

test('findUntouchedViolations: пусто, когда правка коснулась только заявленной секции', () => {
  const edited = SAMPLE.replace('Без бэкенда.', 'Без бэкенда и без базы данных.');
  const violations = findUntouchedViolations(SAMPLE, edited, [5]);
  assert.deepEqual(violations, []);
});

test('findUntouchedViolations: находит секцию, изменённую тихо (не заявленную)', () => {
  const edited = SAMPLE.replace('Без бэкенда.', 'Без бэкенда и без базы данных.').replace(
    'Статичная HTML-страница.',
    'Что-то совсем другое.'
  );
  const violations = findUntouchedViolations(SAMPLE, edited, [5]); // заявили только 5, но 3 тоже поменялась
  assert.deepEqual(violations, [3]);
});
