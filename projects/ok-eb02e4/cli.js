#!/usr/bin/env node
const a = process.argv[2];
if (a === undefined || a.trim() === '' || !Number.isFinite(Number(a))) {
  process.stderr.write('usage: cli.js <seconds>\n');
  process.exit(1);
}
process.stdout.write('ok\n');
