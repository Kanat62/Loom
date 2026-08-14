// core/productSpec.js - парсинг секций product_spec_md и защита от тихой
// перегенерации при правке (§1.1 ТЗ): "harness сверяет, что нетронутые пункты
// остались дословно". Секции - РОВНО формат из prompts/engineer.md (режим "Понимание"): `## N. Заголовок`.
const SECTION_HEADER_RE = /^##\s*(\d+)\.\s*.+$/gm;

/**
 * parseSpecSections - {1: "## 1. Что это\n...", 2: "...", ...}
 */
export function parseSpecSections(md) {
  const text = String(md ?? '');
  const indices = [];
  let m;
  const re = new RegExp(SECTION_HEADER_RE);
  while ((m = re.exec(text))) {
    indices.push({ num: Number(m[1]), start: m.index });
  }
  const sections = {};
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].start;
    const end = i + 1 < indices.length ? indices[i + 1].start : text.length;
    sections[indices[i].num] = text.slice(start, end).trim();
  }
  return sections;
}

/**
 * findUntouchedViolations - номера секций, которые ИЗМЕНИЛИСЬ, хотя не были
 * заявлены в changedSections. Пусто = правка внесла только заявленное.
 */
export function findUntouchedViolations(oldMd, newMd, changedSections) {
  const oldSections = parseSpecSections(oldMd);
  const newSections = parseSpecSections(newMd);
  const changed = new Set((changedSections ?? []).map(Number));
  const violations = [];
  for (const numStr of Object.keys(oldSections)) {
    const num = Number(numStr);
    if (changed.has(num)) continue;
    if (oldSections[num] !== newSections[num]) {
      violations.push(num);
    }
  }
  return violations;
}

/**
 * extractReadinessItems - раздел 4 (Признаки готовности) как список строк,
 * для случая, когда Аналитик не заполнил readiness[] отдельным полем.
 */
export function extractReadinessSection(md) {
  const sections = parseSpecSections(md);
  return sections[4] ?? '';
}
