/**
 * Ядро утилиты: чистые функции обработки текста.
 *
 * Модуль намеренно не знает ничего про CLI, аргументы и вывод в терминал —
 * это делает его пригодным для повторного использования и тестирования.
 */

/** Регулярное выражение для разделения строки по любым пробельным символам. */
const WHITESPACE = /\s+/;

/**
 * Разбивает строку на слова по пробельным символам.
 *
 * Ведущие и завершающие пробелы игнорируются, несколько подряд идущих
 * пробельных символов не создают пустых «слов».
 *
 * @param text исходная строка
 * @returns массив слов (пустой массив для пустой строки или строки из пробелов)
 */
export function splitWords(text: string): string[] {
  if (typeof text !== 'string') {
    return [];
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed.split(WHITESPACE);
}

/**
 * Подсчитывает количество слов в строке.
 *
 * @param text исходная строка
 * @returns количество слов; 0 для пустой строки или строки только из пробелов
 */
export function countWords(text: string): number {
  return splitWords(text).length;
}

/**
 * Переводит строку в верхний регистр.
 *
 * @param text исходная строка
 * @returns строка в верхнем регистре (пустая строка для некорректного ввода)
 */
export function toUpper(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }

  return text.toUpperCase();
}
