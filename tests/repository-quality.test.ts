import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const REPOSITORY_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const LINT_SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'lint.mjs');

function runLint(paths: readonly string[]) {
  return spawnSync(process.execPath, [LINT_SCRIPT, ...paths], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
}

test('package exposes honest local lint and aggregate verification commands', () => {
  const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.lint, 'node scripts/lint.mjs');
  assert.equal(
    packageJson.scripts?.['verify:local'],
    'node scripts/verify-local.mjs',
  );
});

test('aggregate verification removes live credentials and retains every local gate', () => {
  const sentinel = 'PRIVATE_VERIFY_SENTINEL';
  const fixtureDirectory = mkdtempSync(join(REPOSITORY_ROOT, '.quality-fixture-'));
  const fakeNpm = join(fixtureDirectory, 'fake-npm.mjs');
  const invocationLog = join(fixtureDirectory, 'invocations.jsonl');
  writeFileSync(fakeNpm, [
    "import { appendFileSync } from 'node:fs';",
    "const protectedNames = new Set(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENROUTER_API_KEY', 'KIP_PLATFORM_ADMIN_TOKEN']);",
    "const leakedName = Object.keys(process.env).find((name) => protectedNames.has(name.toUpperCase()));",
    "const leakedValue = Object.values(process.env).includes('PRIVATE_VERIFY_SENTINEL');",
    "appendFileSync(process.env.KIP_VERIFY_INVOCATION_LOG, JSON.stringify({ args: process.argv.slice(2), leakedName, leakedValue }) + '\\n');",
  ].join('\n'), 'utf8');
  const result = spawnSync(process.execPath, [join(REPOSITORY_ROOT, 'scripts', 'verify-local.mjs')], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: fakeNpm,
      KIP_VERIFY_INVOCATION_LOG: invocationLog,
      Supabase_Url: sentinel,
      supabase_secret_key: sentinel,
      OpenRouter_Api_Key: sentinel,
      kip_platform_admin_token: sentinel,
    },
  });

  try {
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(`${result.stdout}${result.stderr}`.includes(sentinel), false);
    const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      args: string[];
      leakedName?: string;
      leakedValue: boolean;
    });
    assert.deepEqual(invocations.map(({ args }) => args), [
      ['run', 'lint'],
      ['run', 'typecheck'],
      ['test'],
      ['--prefix', 'frontend', 'run', 'build'],
    ]);
    assert.equal(invocations.some(({ leakedName, leakedValue }) => leakedName !== undefined || leakedValue), false);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('lint reports only path, line, and category for unsafe text', () => {
  const fixtureDirectory = mkdtempSync(join(REPOSITORY_ROOT, '.quality-fixture-'));
  const fixtures = [
    { name: 'whitespace.ts', content: 'const safe = true;   \n', category: 'trailing-whitespace', line: 1 },
    { name: 'conflict.ts', content: 'safe\n<<<<<<< HEAD\nprivate branch text\n', category: 'conflict-marker', line: 2 },
    {
      name: 'private-key.txt',
      content: `prefix\n${['-----BEGIN', ' PRIVATE KEY-----'].join('')}\nHIGHLY_PRIVATE_KEY_MATERIAL\n`,
      category: 'private-key',
      line: 2,
    },
    {
      name: 'provider.ts',
      content: `const token = "${['sk-or-v1', 'DO_NOT_ECHO_1234567890'].join('-')}";\n`,
      category: 'hard-coded-secret',
      line: 1,
    },
  ] as const;

  try {
    const paths = fixtures.map((fixture) => {
      const path = join(fixtureDirectory, fixture.name);
      writeFileSync(path, fixture.content, 'utf8');
      return path;
    });
    const result = runLint(paths);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    for (const fixture of fixtures) {
      const displayedPath = relative(REPOSITORY_ROOT, join(fixtureDirectory, fixture.name)).replaceAll('\\', '/');
      assert.match(output, new RegExp(`${displayedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${fixture.line}:${fixture.category}`));
    }
    for (const sensitiveText of [
      'const safe = true;',
      '<<<<<<< HEAD',
      'private branch text',
      ['-----BEGIN', ' PRIVATE KEY-----'].join(''),
      'HIGHLY_PRIVATE_KEY_MATERIAL',
      ['sk-or-v1', 'DO_NOT_ECHO_1234567890'].join('-'),
    ]) {
      assert.equal(output.includes(sensitiveText), false);
    }
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('lint rejects env variants and paths outside the repository without reading them', () => {
  const fixtureDirectory = mkdtempSync(join(REPOSITORY_ROOT, '.quality-fixture-'));
  const environmentFile = join(fixtureDirectory, '.env.local');
  writeFileSync(environmentFile, 'SAFE_NAME=not-a-real-secret\n', 'utf8');

  try {
    const envResult = runLint([environmentFile]);
    const envOutput = `${envResult.stdout}${envResult.stderr}`;
    assert.equal(envResult.status, 1);
    assert.match(envOutput, /\.env\.local:1:committed-env-file/);
    assert.equal(envOutput.includes('SAFE_NAME=not-a-real-secret'), false);

    const outsideResult = runLint([join(REPOSITORY_ROOT, '..', 'outside-secret.txt')]);
    const outsideOutput = `${outsideResult.stdout}${outsideResult.stderr}`;
    assert.equal(outsideResult.status, 2);
    assert.match(outsideOutput, /path-outside-repository/);
    assert.equal(outsideOutput.includes('outside-secret.txt'), false);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('lint accepts a clean repository-owned explicit fixture', () => {
  const fixtureDirectory = mkdtempSync(join(REPOSITORY_ROOT, '.quality-fixture-'));
  const fixturePath = join(fixtureDirectory, 'clean.ts');
  writeFileSync(fixturePath, 'export const clean = true;\n', 'utf8');

  try {
    const result = runLint([fixturePath]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

test('default lint enumeration detects a tracked env variant', () => {
  const fixtureRepository = mkdtempSync(join(REPOSITORY_ROOT, '.quality-fixture-'));
  const fixtureScripts = join(fixtureRepository, 'scripts');
  mkdirSync(fixtureScripts);
  copyFileSync(LINT_SCRIPT, join(fixtureScripts, 'lint.mjs'));
  writeFileSync(join(fixtureRepository, '.env.local'), 'SAFE_NAME=fixture-only\n', 'utf8');
  writeFileSync(
    join(fixtureRepository, 'server.pem'),
    `${['-----BEGIN', ' PRIVATE KEY-----'].join('')}\nFIXTURE_ONLY\n`,
    'utf8',
  );

  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixtureRepository });
    execFileSync('git', ['add', '--force', '.env.local', 'server.pem', 'scripts/lint.mjs'], { cwd: fixtureRepository });
    const result = spawnSync(process.execPath, [join(fixtureScripts, 'lint.mjs')], {
      cwd: fixtureRepository,
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /\.env\.local:1:committed-env-file/);
    assert.match(output, /server\.pem:1:private-key/);
    assert.equal(output.includes('SAFE_NAME=fixture-only'), false);
    assert.equal(output.includes('FIXTURE_ONLY'), false);
  } finally {
    rmSync(fixtureRepository, { recursive: true, force: true });
  }
});

test('lint rejects a repository symlink or junction that resolves outside the repository', (context) => {
  const fixtureDirectory = mkdtempSync(join(REPOSITORY_ROOT, '.quality-fixture-'));
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'kip-quality-outside-'));
  const outsideFile = join(outsideDirectory, 'outside.txt');
  const linkedDirectory = join(fixtureDirectory, 'linked');
  writeFileSync(outsideFile, 'OUTSIDE_PRIVATE_SENTINEL\n', 'utf8');

  try {
    try {
      symlinkSync(outsideDirectory, linkedDirectory, 'junction');
    } catch {
      context.skip('junction creation is unavailable on this host');
      return;
    }
    const result = runLint([join(linkedDirectory, 'outside.txt')]);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 2);
    assert.match(output, /path-outside-repository/);
    assert.equal(output.includes('OUTSIDE_PRIVATE_SENTINEL'), false);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
    rmSync(outsideDirectory, { recursive: true, force: true });
  }
});

test('lint rejects explicit directories instead of reporting an empty successful scan', () => {
  const result = runLint([join(REPOSITORY_ROOT, 'src')]);
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /unable-to-read-file/);
});
