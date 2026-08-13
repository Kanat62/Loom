import crypto from 'node:crypto';
import { createJournal } from '../core/journal.js';
import { getProject } from '../core/projects.js';
import { runConsultant } from '../agents/consultant.js';
import { createIO } from '../core/io.js';

const journal = await createJournal();
const io = createIO();
const project = getProject(journal, 'project-9a4158');
const spec = journal.getProductSpec(project.id);

const consultantRunId = crypto.randomUUID();
const report = await runConsultant({ project, productSpec: spec, journal, runId: consultantRunId });
io.write(`\n${'='.repeat(60)}\n${report}\n${'='.repeat(60)}\n`);

await journal.close();
