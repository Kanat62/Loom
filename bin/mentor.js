#!/usr/bin/env node
// bin/mentor.js - разбор с Наставником (§0.1 гайда, Режим B §12.2 ТЗ).
// Отдельная команда, вне продуктовой сессии talk - канал развития LOOM.
import crypto from 'node:crypto';
import { createJournal } from '../core/journal.js';
import { listProjects, getProject } from '../core/projects.js';
import { runMentor } from '../agents/mentor.js';
import { confirmAndSaveLesson } from '../core/lessons.js';
import { createIO } from '../core/io.js';

const journal = await createJournal();
const io = createIO();

const projects = listProjects(journal).filter((p) => p.status === 'delivered');
if (projects.length === 0) {
  io.write('Нет сданных ("delivered") проектов для разбора. Сначала доведите проект до сдачи через npm run talk.\n');
  io.close();
  journal.close();
  process.exit(0);
}

io.write('Сданные проекты:\n');
for (const p of projects) {
  io.write(`  ${p.id}  ${p.title}\n`);
}

const chosenId = await io.ask(`\nКакой проект разберём? (id, по умолчанию ${projects[0].id}): `);
const project = getProject(journal, chosenId.trim() || projects[0].id) ?? projects[0];
const productSpec = journal.getProductSpec(project.id);

io.write(`\nРазбираем "${project.title}" (${project.id}).\n`);
io.write('Расскажите, что было плохо и почему (или /exit, чтобы выйти без разбора):\n');

let running = true;
while (running) {
  const feedback = await io.ask('\nвы> ');
  if (!feedback) continue;
  if (feedback === '/exit') {
    running = false;
    continue;
  }

  const runId = crypto.randomUUID();
  const result = await runMentor({ mode: 'B', humanMessage: feedback, project, productSpec, journal, runId });

  io.write(`\nнаставник> ${result.reply ?? '(нет ответа)'}\n`);

  if (result.lesson_draft) {
    const { scope, text, origin } = result.lesson_draft;
    io.write(`\nПредлагаемый урок:\n  scope: ${scope}\n  text: ${text}\n  origin: ${origin}\n`);
    const verdict = await io.ask('Подтвердить и записать в постоянную память? (да/нет): ');
    if (verdict.trim().toLowerCase() === 'да') {
      const saved = confirmAndSaveLesson(journal, { scope, text, origin });
      if (saved.saved) {
        io.write('Урок записан (confirmed_by=human).\n');
      } else {
        io.write(`Урок НЕ записан: ${saved.reason} (защита от отравления памяти, §12.3 ТЗ).\n`);
      }
    } else {
      io.write('Урок не записан.\n');
    }
  }
}

io.close();
journal.close();
process.exit(0);
