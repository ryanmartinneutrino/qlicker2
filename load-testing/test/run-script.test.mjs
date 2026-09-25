import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const loadTestingRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, { environment = 'prod', host = 'qlicker.example.com', scenario = 'live-named' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-load-runner-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.mkdir(path.join(root, 'state'));
  await fs.mkdir(path.join(root, 'scenarios'));
  await fs.mkdir(path.join(root, 'production_setup'));
  await Promise.all([
    fs.copyFile(path.join(loadTestingRoot, 'run.sh'), path.join(root, 'run.sh')),
    fs.copyFile(path.join(loadTestingRoot, 'common.sh'), path.join(root, 'common.sh')),
    fs.writeFile(path.join(root, 'state/state.json'), JSON.stringify({ session: { scenario } }, null, 2)),
    fs.writeFile(path.join(root, 'scenarios/live-session.js'), ''),
    fs.writeFile(path.join(root, 'scenarios/live-anonymous.js'), ''),
    fs.writeFile(path.join(root, 'scenarios/quiz-session.js'), ''),
    fs.writeFile(path.join(root, 'production_setup/docker-compose.yml'), 'services: {}\n'),
    fs.writeFile(path.join(root, 'production_setup/.env'), 'DISABLE_RATE_LIMITS=false\n'),
    fs.writeFile(path.join(root, '.env'), [
      `TARGET_ENV=${environment}`,
      `TARGET_RUNTIME=${environment === 'staging' ? 'docker' : 'native'}`,
      `TARGET_ENV_FILE=${path.join(root, 'production_setup/.env')}`,
      `STACK_DIR=${path.join(root, 'production_setup')}`,
      `TARGET_COMPOSE_FILE=${path.join(root, 'production_setup/docker-compose.yml')}`,
      `STAGING_HOST=${host}`,
      'MONGO_URL=mongodb://unused/qlicker',
      'BASE_URL=https://qlicker.example.com',
      'NUM_STUDENTS=500',
      'K6_NOFILE_LIMIT=16384',
    ].join('\n')),
    fs.writeFile(path.join(root, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGS_FILE"\n', { mode: 0o755 }),
  ]);
  return { root, argsFile: path.join(root, 'docker-args') };
}

function run(root, argsFile, ...args) {
  return spawnSync('bash', ['run.sh', ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: argsFile,
    },
    encoding: 'utf8',
  });
}

test('named live retains the existing scenario and raises the k6 file-descriptor limit', async (t) => {
  const { root, argsFile } = await fixture(t);
  const result = run(root, argsFile, '--test-only');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const args = (await fs.readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args[0], 'run');
  assert.equal(args[1], '--rm');
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('--ulimit'));
  assert.ok(args.includes('nofile=16384:16384'));
  assert.equal(args.at(-1), '/scenarios/live-session.js');
});

test('staging routes an anonymous quiz through the production Docker target', async (t) => {
  const { root, argsFile } = await fixture(t, { environment: 'staging', scenario: 'quiz-anonymous' });
  const result = run(root, argsFile, '--scenario', 'quiz-anonymous', '--test-only');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const args = (await fs.readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args.at(-1), '/scenarios/quiz-session.js');
  assert.ok(args.includes('--summary-export'));
  assert.ok(args.some((arg) => arg.includes('/results/summary-quiz-anonymous-')));
});

test('staging rejects a target hostname mismatch before invoking Docker', async (t) => {
  const { root, argsFile } = await fixture(t, { environment: 'staging', host: 'other.example.com' });
  const result = run(root, argsFile, '--test-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match STAGING_HOST/);
  await assert.rejects(fs.access(argsFile));
});

test('test-only rejects a fixture from a different scenario', async (t) => {
  const { root, argsFile } = await fixture(t, { scenario: 'quiz-named' });
  const result = run(root, argsFile, '--test-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match scenario/);
  await assert.rejects(fs.access(argsFile));
});

test('prepare and restore preserve the original rate-limit setting', async (t) => {
  const { root, argsFile } = await fixture(t);
  const targetEnv = path.join(root, 'production_setup/.env');
  await fs.writeFile(targetEnv, 'DISABLE_RATE_LIMITS=true\n');
  let result = run(root, argsFile, '--prepare');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(root, argsFile, '--restore');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(targetEnv, 'utf8'), 'DISABLE_RATE_LIMITS=true\n');
  await fs.writeFile(targetEnv, 'ROOT_URL=https://qlicker.example.com\n');
  result = run(root, argsFile, '--prepare');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(root, argsFile, '--restore');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(targetEnv, 'utf8'), 'ROOT_URL=https://qlicker.example.com\n\n');
});
