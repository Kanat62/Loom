'use strict';

/**
 * Возвращает сумму двух чисел.
 *
 * @param {number} a - первое слагаемое
 * @param {number} b - второе слагаемое
 * @returns {number} сумма a + b
 * @throws {TypeError} если аргумент не является конечным числом
 */
function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('add(a, b): both arguments must be numbers');
  }

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError('add(a, b): both arguments must be finite numbers');
  }

  return a + b;
}

// Именованный экспорт: require('./sum.js').add(2, 3) === 5
module.exports = { add };

// Дополнительно — прямой вызов модуля: require('./sum.js')(2, 3) === 5
module.exports.default = add;
