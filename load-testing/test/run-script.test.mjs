import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const loadTestingRoot = fileURLToPath(new URL('../', import.meta.url));

test('the k6 runner raises the container file-descriptor limit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-load-runner-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.mkdir(path.join(root, 'state'));
  await fs.mkdir(path.join(root, 'scenarios'));
  await Promise.all([
    fs.copyFile(path.join(loadTestingRoot, 'run.sh'), path.join(root, 'run.sh')),
    fs.copyFile(path.join(loadTestingRoot, 'common.sh'), path.join(root, 'common.sh')),
    fs.writeFile(path.join(root, 'state/state.json'), '{}'),
    fs.writeFile(path.join(root, 'scenarios/live-session.js'), ''),
    fs.writeFile(path.join(root, '.env'), [
      'TARGET_ENV=prod',
      'TARGET_RUNTIME=native',
      'MONGO_URL=mongodb://unused/qlicker',
      'BASE_URL=https://qlicker.example.com',
      'NUM_STUDENTS=500',
      'K6_NOFILE_LIMIT=16384',
    ].join('\n')),
    fs.writeFile(path.join(root, 'bin/docker'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DOCKER_ARGS_FILE"\n', { mode: 0o755 }),
  ]);

  const argsFile = path.join(root, 'docker-args');
  const result = spawnSync('bash', ['run.sh', '--test-only'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: argsFile,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const args = (await fs.readFile(argsFile, 'utf8')).trim().split('\n');
  assert.deepEqual(args.slice(0, 4), [
    'run', '--rm', '--ulimit', 'nofile=16384:16384',
  ]);
});
