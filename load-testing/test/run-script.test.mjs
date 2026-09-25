import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const loadTestingRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, { runtime = 'native', baseUrl = 'https://qlicker.example.com', scenario = 'live-named' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-load-runner-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.mkdir(path.join(root, 'state'));
  await fs.mkdir(path.join(root, 'scenarios'));
  await fs.mkdir(path.join(root, 'production_setup'));
  await Promise.all([
    fs.copyFile(path.join(loadTestingRoot, 'run.sh'), path.join(root, 'run.sh')),
    fs.copyFile(path.join(loadTestingRoot, 'common.sh'), path.join(root, 'common.sh')),
    fs.writeFile(path.join(root, 'Dockerfile.seed'), 'FROM node:24-alpine\n'),
    fs.writeFile(path.join(root, 'package.json'), '{}\n'),
    fs.writeFile(path.join(root, 'package-lock.json'), '{}\n'),
    fs.writeFile(path.join(root, 'seed.mjs'), 'console.log(\"seed\")\n'),
    fs.writeFile(path.join(root, 'state/state.json'), JSON.stringify({ session: { scenario } }, null, 2)),
    fs.writeFile(path.join(root, 'scenarios/live-session.js'), ''),
    fs.writeFile(path.join(root, 'scenarios/live-anonymous.js'), ''),
    fs.writeFile(path.join(root, 'scenarios/quiz-session.js'), ''),
    fs.writeFile(path.join(root, 'production_setup/docker-compose.yml'), 'services: {}\n'),
    fs.writeFile(path.join(root, 'production_setup/.env'), 'DISABLE_RATE_LIMITS=false\n'),
    fs.writeFile(path.join(root, '.env'), [
      `TARGET_ENV=prod`,
      `TARGET_RUNTIME=${runtime}`,
      `TARGET_ENV_FILE=${path.join(root, 'production_setup/.env')}`,
      `STACK_DIR=${path.join(root, 'production_setup')}`,
      `TARGET_COMPOSE_FILE=${path.join(root, 'production_setup/docker-compose.yml')}`,
      'MONGO_URL=mongodb://unused/qlicker',
      `BASE_URL=${baseUrl}`,
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

test('prod/docker routes an anonymous quiz to the configured host', async (t) => {
  const { root, argsFile } = await fixture(t, { runtime: 'docker', baseUrl: 'https://staging.example.com', scenario: 'quiz-anonymous' });
  await fs.writeFile(path.join(root, 'state/rate-limit-restore.env'), 'DISABLE_RATE_LIMITS=false\n');
  await fs.writeFile(path.join(root, 'production_setup/.env'), 'DISABLE_RATE_LIMITS=true\n');
  const result = run(root, argsFile, '--scenario', 'quiz-anonymous', '--test-only');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const args = (await fs.readFile(argsFile, 'utf8')).trim().split('\n');
  assert.equal(args.at(-1), '/scenarios/quiz-session.js');
  assert.ok(args.includes('--summary-export'));
  assert.ok(args.some((arg) => arg.includes('/results/summary-quiz-anonymous-')));
  assert.ok(args.includes('BASE_URL=https://staging.example.com'));
});

test('test-only rejects a fixture from a different scenario', async (t) => {
  const { root, argsFile } = await fixture(t, { scenario: 'quiz-named' });
  await fs.writeFile(path.join(root, 'state/rate-limit-restore.env'), 'DISABLE_RATE_LIMITS=false\n');
  const result = run(root, argsFile, '--test-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match scenario/);
  assert.match(result.stdout, /Run \.\/run\.sh --restore/);
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


test('cleanup rebuilds an outdated seed image once, then reuses the matching image', async (t) => {
  const { root, argsFile } = await fixture(t);
  const labelFile = path.join(root, 'seed-image-label');
  await fs.writeFile(path.join(root, 'state/rate-limit-restore.env'), 'DISABLE_RATE_LIMITS=false\n');
  await fs.writeFile(path.join(root, 'bin/docker'), `#!/usr/bin/env bash
case "$1 $2" in
  'image inspect')
    if [[ -f "$DOCKER_LABEL_FILE" ]]; then cat "$DOCKER_LABEL_FILE"; else printf 'old-image\n'; fi
    ;;
  'build --label')
    printf 'build\n' >> "$DOCKER_ARGS_FILE"
    printf '%s\n' "\${3#*=}" > "$DOCKER_LABEL_FILE"
    ;;
  'run --rm')
    printf 'run\n' >> "$DOCKER_ARGS_FILE"
    ;;
esac
`, { mode: 0o755 });
  const invoke = () => spawnSync('bash', ['run.sh', '--clean'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: argsFile,
      DOCKER_LABEL_FILE: labelFile,
    },
    encoding: 'utf8',
  });
  let result = invoke();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = invoke();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual((await fs.readFile(argsFile, 'utf8')).trim().split('\n'), ['build', 'run', 'run']);
  assert.equal(await fs.readFile(path.join(root, 'state/rate-limit-restore.env'), 'utf8'), 'DISABLE_RATE_LIMITS=false\n');
});

test('prod/docker preparation does not disable rate limits when seed image build fails', async (t) => {
  const { root, argsFile } = await fixture(t, { runtime: 'docker' });
  await fs.writeFile(path.join(root, 'bin/docker'), `#!/bin/sh
case "$1" in
  image) exit 1 ;;
  build) exit 29 ;;
esac
exit 0
`, { mode: 0o755 });
  const result = run(root, argsFile, '--prepare');
  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(path.join(root, 'production_setup/.env'), 'utf8'), 'DISABLE_RATE_LIMITS=false\n');
  await assert.rejects(fs.access(path.join(root, 'state/rate-limit-restore.env')));
});

test('prod/docker prepares and restores the same Compose stack used on staging', async (t) => {
  const { root, argsFile } = await fixture(t, { runtime: 'docker', baseUrl: 'https://staging.example.com' });
  const labelFile = path.join(root, 'seed-image-label');
  await fs.writeFile(path.join(root, 'bin/docker'), `#!/usr/bin/env bash
case "$1 $2" in
  'image inspect')
    if [[ -f "$DOCKER_LABEL_FILE" ]]; then cat "$DOCKER_LABEL_FILE"; else printf 'old-image\\n'; fi
    ;;
  'build --label')
    printf 'build\\n' >> "$DOCKER_ARGS_FILE"
    printf '%s\\n' "\${3#*=}" > "$DOCKER_LABEL_FILE"
    ;;
  'compose --project-directory')
    printf 'compose %s\\n' "$*" >> "$DOCKER_ARGS_FILE"
    ;;
esac
`, { mode: 0o755 });
  const invoke = (mode) => spawnSync('bash', ['run.sh', mode], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: argsFile,
      DOCKER_LABEL_FILE: labelFile,
    },
    encoding: 'utf8',
  });
  let result = invoke('--prepare');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(await fs.readFile(path.join(root, 'production_setup/.env'), 'utf8'), /^DISABLE_RATE_LIMITS=true/m);
  result = invoke('--restore');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await fs.readFile(path.join(root, 'production_setup/.env'), 'utf8'), 'DISABLE_RATE_LIMITS=false\n');
  const actions = await fs.readFile(argsFile, 'utf8');
  assert.match(actions, /build/);
  assert.match(actions, /exec -T nginx/);
  assert.match(actions, /restart nginx/);
});

test('a failed login ingress preflight prevents the main workload from starting', async (t) => {
  const { root, argsFile } = await fixture(t);
  await fs.writeFile(path.join(root, 'bin/docker'), `#!/bin/sh
printf '%s\\n' "$@" >> "$DOCKER_ARGS_FILE"
case "$*" in
  *'/scenarios/preflight.js'*) exit 17 ;;
esac
exit 0
`, { mode: 0o755 });
  const result = run(root, argsFile, '--test-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Login ingress preflight failed/);
  const args = await fs.readFile(argsFile, 'utf8');
  assert.match(args, /\/scenarios\/preflight\.js/);
  assert.doesNotMatch(args, /\/scenarios\/live-session\.js/);
});

test('prod/docker full run refuses to seed without preparation', async (t) => {
  const { root, argsFile } = await fixture(t, { runtime: 'docker' });
  const result = run(root, argsFile);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require --prepare before seeding or testing/);
  await assert.rejects(fs.access(argsFile));
});


test('prod/docker test-only refuses a stale preparation record', async (t) => {
  const { root, argsFile } = await fixture(t, { runtime: 'docker' });
  await fs.writeFile(path.join(root, 'state/rate-limit-restore.env'), 'DISABLE_RATE_LIMITS=false\n');
  const result = run(root, argsFile, '--test-only');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DISABLE_RATE_LIMITS=true is missing/);
  await assert.rejects(fs.access(argsFile));
});
