#!/usr/bin/env node
import mongoose from 'mongoose';
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Session from '../src/models/Session.js';
import { repairSessionQuestionReferences } from '../src/services/questionReferenceRepair.js';

function parseArgs(argv) {
  const options = { apply: false, filter: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--apply') options.apply = true;
    else if (arg === '--session' || arg === '--course') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires an ID`);
      options.filter[arg === '--session' ? '_id' : 'courseId'] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node server/scripts/repair-question-references.js [--session ID] [--course ID] [--apply]');
    console.log('Default: read-only audit. Before --apply, back up MongoDB and stop all application writers.');
    return;
  }
  for (const relative of ['../../.env', '../.env']) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) { loadEnv({ path, quiet: true }); break; }
  }
  const uri = process.env.MONGO_URI
    || (process.env.MONGO_PORT ? `mongodb://localhost:${process.env.MONGO_PORT}/qlicker` : '');
  if (!uri) throw new Error('Set MONGO_URI or MONGO_PORT.');
  // Auditing must not create collections or indexes as a connection side effect.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const summary = { mode: options.apply ? 'apply' : 'dry-run', scanned: 0, statuses: {} };
  try {
    for await (const session of Session.collection.find(options.filter, { projection: { _id: 1 } })) {
      const report = await repairSessionQuestionReferences({ sessionId: session._id, apply: options.apply });
      summary.scanned += 1;
      summary.statuses[report.status] = (summary.statuses[report.status] || 0) + 1;
      if (report.status !== 'unchanged') console.log(JSON.stringify(report));
    }
    console.log(JSON.stringify({ summary }));
    if (!summary.scanned || summary.statuses['manual-review'] || summary.statuses.conflict || summary.statuses['missing-session']) {
      process.exitCode = 2;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  // Do not print driver errors, which can include connection credentials.
  console.error(`Repair failed (${error.name}). Check database access and command options; no automatic retry was attempted.`);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
