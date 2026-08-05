// core/projects.js - создание/поиск/статус проектов (§13 ТЗ: мультипроектность).
// Каждый проект изолирован полностью: projects/<id>/ - свой git-репо, свои
// зависимости, свой design/, свои инструменты. project_id - обязательный
// фильтр в каждой точке чтения журнала (шрам 35, 38).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getProjectsDir } from './config.js';

function slugify(title) {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'project';
}

/**
 * "default" запрещён как project_id (§13 ТЗ) - тихий дефолт был источником
 * смешивания продуктов в одной папке. id - всегда slug + короткий хеш.
 */
export function makeProjectId(title) {
  const slug = slugify(title).slice(0, 40);
  const hash = crypto.randomBytes(3).toString('hex');
  return `${slug}-${hash}`;
}

/**
 * createProject - создаёт запись в журнале + каталог workspace на диске.
 * domain: ui | cli | lib | data | null (Аналитик/Архитектор проставляют позже,
 * если ещё не известен на момент создания).
 */
export function createProject(journal, { title, domain = null }) {
  const id = makeProjectId(title);
  const dir = path.join(getProjectsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'design'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });

  // §13 ТЗ: каждый проект - свой git-репо, полностью изолированный от git LOOM
  // (gitGuard, §15.1.4). cwd жёстко = каталог проекта, никогда не ROOT.
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.history/\ndist/\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=loom@local', '-c', 'user.name=LOOM', 'commit', '-m', 'chore: scaffold project', '--allow-empty'], {
    cwd: dir,
    stdio: 'ignore',
  });

  return journal.createProject({ id, title, workspace_dir: dir, domain });
}

export function getProject(journal, id) {
  if (!id || id === 'default') return null;
  return journal.getProject(id);
}

export function listProjects(journal) {
  return journal.listProjects();
}

export function setProjectDomain(journal, projectId, domain) {
  // Нет отдельного stmt в journal.js для domain-only update - используем raw.
  journal.raw
    .prepare(`UPDATE projects SET domain = ? WHERE id = ?`)
    .run(domain, projectId);
}

export function setProjectStatus(journal, projectId, status) {
  journal.setProjectStatus(projectId, status);
}

export function workspaceDir(projectId) {
  return path.join(getProjectsDir(), projectId);
}
