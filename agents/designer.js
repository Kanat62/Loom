// agents/designer.js - Дизайнер (§1.2 ТЗ). Включается ТОЛЬКО при domain='ui'
// (инвариант стоимости - для cli/lib/data не вызывается вовсе). Выдаёт
// дизайн-систему, не макет; направление - от референса или выбора человека
// из 2-3 названных вариантов (единственный дизайн-вопрос человеку).
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../core/config.js';
import { chat } from '../core/gateway.js';
import { getHeroUIDocs } from '../core/herouiDocs.js';
import { workspaceDir } from '../core/projects.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'designer.md'), 'utf8');

function buildUserPrompt({ productSpec, chosenDirection, herouiDocsText }) {
  const parts = [`# product_spec продукта\n${productSpec.spec_md}`];
  if (chosenDirection) {
    parts.push(`# Человек выбрал направление\n"${chosenDirection}" - заверши дизайн-систему для него (status="ready").`);
  }
  parts.push(`# Актуальный индекс документации HeroUI v3 (React)\n${herouiDocsText}`);
  return parts.join('\n\n---\n\n');
}

/**
 * runDesigner - один вызов. Без chosenDirection - Дизайнер либо сам находит
 * референс в product_spec (status=ready сразу), либо предлагает варианты
 * (status=choose_direction). С chosenDirection - фиксирует систему для него.
 */
export async function runDesigner({ project, productSpec, journal, runId, chosenDirection = null }) {
  const { text: herouiDocsText } = await getHeroUIDocs();
  const userPrompt = buildUserPrompt({ productSpec, chosenDirection, herouiDocsText });

  const res = await chat(
    'designer',
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { json: true, projectId: project.id, runId, logEvent: (e) => journal.logEvent(e) }
  );
  return res.data;
}

/**
 * saveDesignSystem - записывает дизайн-систему в <project>/design/tokens.css
 * и DESIGN.md (§1.2 ТЗ). Исполнитель получает этот блок ВСЕГДА ПОЛНОСТЬЮ.
 */
export function saveDesignSystem(projectId, result) {
  const dir = path.join(workspaceDir(projectId), 'design');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens.css'), result.tokens_css ?? '', 'utf8');

  const md = [
    `# Дизайн-система\n`,
    `## Направление\n${result.direction ?? ''}\n`,
    `## Обоснование (референс)\n${result.reference_note ?? ''}\n`,
    `## Правила для Исполнителя\n${(result.rules ?? []).map((r) => `- ${r}`).join('\n')}\n`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), md, 'utf8');

  return { tokensPath: path.join(dir, 'tokens.css'), designMdPath: path.join(dir, 'DESIGN.md') };
}

/**
 * loadDesignSystem - блок для Исполнителя (§6.4 ТЗ - всегда полностью, не дельтой).
 */
export function loadDesignSystem(projectId) {
  const dir = path.join(workspaceDir(projectId), 'design');
  const tokensPath = path.join(dir, 'tokens.css');
  const mdPath = path.join(dir, 'DESIGN.md');
  if (!fs.existsSync(tokensPath) && !fs.existsSync(mdPath)) return null;

  const tokens = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, 'utf8') : '';
  const md = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
  return `${md}\n\n## tokens.css\n\`\`\`css\n${tokens}\n\`\`\``;
}
