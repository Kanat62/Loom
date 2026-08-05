// agents/analyst.js - Аналитик (§1.1 ТЗ): вход и понимание. Самый важный узел
// системы - здесь не экономим на модели (Opus первым в цепочке, §5.2).
import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR } from '../core/config.js';
import { chat, GatewayError } from '../core/gateway.js';
import { snapshotWorkspace } from '../core/context.js';

const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'analyst.md'), 'utf8');

// §1.1.1 ТЗ - regex-фильтр технических вопросов, ОБЯЗАТЕЛЕН в коде (шрам 15).
// Без \b (не работает на кириллице, §19.11 ТЗ).
const FORBIDDEN_PATTERNS = [
  { source: 'числа с единицами (px/мс/сек/fps/КБ/МБ/%/°)', re: /\d+\s?(пикс|px|мс|ms|сек|fps|кб|мб|%|°)/i },
  {
    source: 'названия технологий',
    re: /react|node\.?js|sql|api\b|css|http|ffmpeg|база данных|фреймворк|библиотек|алгоритм|формат[ае]?\b|протокол|кодек|сервер|хостинг/i,
  },
  { source: 'формулировка выбора реализации', re: /какой из|использовать ли|нужно ли делать через/i },
];

/**
 * findForbiddenQuestion - первый вопрос из списка, нарушающий фильтр §1.1.1.
 */
export function findForbiddenQuestion(questions) {
  for (const q of questions ?? []) {
    for (const { source, re } of FORBIDDEN_PATTERNS) {
      if (re.test(q)) return { question: q, reason: source };
    }
  }
  return null;
}

function buildUserPrompt({ transcript, project, productSpec, editInstruction }) {
  const parts = [];
  if (project) {
    parts.push(
      `# Активный проект\nid=${project.id} title="${project.title}" domain=${project.domain ?? '(не определён)'} status=${project.status}`
    );
    if (productSpec?.spec_md) {
      parts.push(`# Существующий product_spec\n${productSpec.spec_md}`);
    }
    parts.push(`# Снимок workspace\n${snapshotWorkspace(project.id)}`);
  } else {
    parts.push('# Активного проекта нет. Это либо новый build, либо разговор про сам LOOM (mentor).');
  }
  if (editInstruction) {
    parts.push(`# Инструкция по правке product_spec\nЧеловек попросил: "${editInstruction}"\nВнеси ТОЛЬКО это изменение, остальные секции верни дословно как было. Заполни changed_sections.`);
  }
  parts.push(`# Переписка с человеком (по порядку)\n${transcript.map((t) => `[${t.from}] ${t.text}`).join('\n')}`);
  return parts.join('\n\n---\n\n');
}

const SAFE_FALLBACK = { route: 'build', status: 'clarifying', questions: [] };

/**
 * runAnalyst - один вызов. Ошибка парсинга/шлюза -> route='build' безопасным
 * дефолтом (§1.1 ТЗ: ошибка классификации в сторону build безопасна).
 */
export async function runAnalyst({ transcript, project = null, productSpec = null, editInstruction = null, journal, runId, gatewayOpts = {} }) {
  const userPrompt = buildUserPrompt({ transcript, project, productSpec, editInstruction });
  try {
    const res = await chat(
      'analyst',
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      {
        json: true,
        projectId: project?.id ?? null,
        runId,
        logEvent: (e) => journal.logEvent(e),
        ...gatewayOpts,
      }
    );
    return res.data;
  } catch (err) {
    if (err instanceof GatewayError) {
      journal.logEvent({
        run_id: runId,
        project_id: project?.id ?? null,
        type: 'status',
        agent: 'analyst',
        payload: { kind: 'analyst_fallback_to_build', error: err.message },
      });
      return SAFE_FALLBACK;
    }
    throw err;
  }
}

/**
 * runAnalystWithQuestionFilter - как runAnalyst, но прогоняет questions[]
 * через regex-фильтр (§1.1.1) и перегенерирует до 2 раз при нарушении.
 * Совпадение логируется в events (наблюдение за качеством промпта).
 */
export async function runAnalystWithQuestionFilter(args) {
  let transcript = args.transcript;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runAnalyst({ ...args, transcript });
    if (result.route !== 'build' || result.status !== 'clarifying' || !result.questions?.length) {
      return result;
    }
    const hit = findForbiddenQuestion(result.questions);
    if (!hit) return result;

    args.journal.logEvent({
      run_id: args.runId,
      project_id: args.project?.id ?? null,
      type: 'status',
      agent: 'analyst',
      payload: { kind: 'regex_filter_hit', question: hit.question, reason: hit.reason },
    });

    if (attempt === 2) {
      // Честно отфильтровываем плохие вопросы, продолжаем с тем, что осталось.
      const clean = result.questions.filter((q) => !findForbiddenQuestion([q]));
      return { ...result, questions: clean };
    }

    transcript = [
      ...transcript,
      {
        from: 'system',
        text: `Вопрос "${hit.question}" отклонён фильтром (${hit.reason}) - это технический вопрос. Спрашивай ТОЛЬКО о результате, ничего технического.`,
      },
    ];
  }
}
