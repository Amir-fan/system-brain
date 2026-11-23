import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realRepositoryRoot = realpathSync(repositoryRoot);
const textExtensions = new Set([
  '.cjs', '.css', '.html', '.js', '.jsx', '.json', '.key', '.md', '.mjs', '.pem', '.sql', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);
const secretPatterns = [
  /\bsk-or-v1-[A-Za-z0-9_-]{12,}/,
  /\bsk-proj-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}/,
  /\bAIza[A-Za-z0-9_-]{20,}/,
];

function repositoryPath(input) {
  const absolutePath = resolve(repositoryRoot, input);
  const repositoryRelative = relative(repositoryRoot, absolutePath);
  if (repositoryRelative === '..'
    || repositoryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(repositoryRelative)) {
    throw new Error('path-outside-repository');
  }
  return { absolutePath, repositoryRelative: repositoryRelative.replaceAll('\\', '/') };
}

function defaultPaths() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repositoryRoot });
  return Buffer.concat([tracked, untracked])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.startsWith('.agents/') && !path.startsWith('.codex/'))
    .filter((path) => {
      const name = basename(path);
      return textExtensions.has(extname(name).toLowerCase())
        || name.startsWith('.env')
        || name === '.env.example'
        || name === '.gitignore'
        || name === 'Dockerfile';
    });
}

function scanFile(path) {
  const { absolutePath, repositoryRelative } = repositoryPath(path);
  const realPath = realpathSync(absolutePath);
  const realRelative = relative(realRepositoryRoot, realPath);
  if (realRelative === '..'
    || realRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(realRelative)) {
    throw new Error('path-outside-repository');
  }
  if (!statSync(realPath).isFile()) throw new Error('path-not-file');

  const findings = [];
  const name = basename(absolutePath);
  if (name.startsWith('.env') && name !== '.env.example') {
    findings.push({ path: repositoryRelative, line: 1, category: 'committed-env-file' });
  }

  const lines = readFileSync(realPath, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/[ \t]+$/.test(line)) findings.push({ path: repositoryRelative, line: lineNumber, category: 'trailing-whitespace' });
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?:\s|$)/.test(line)) findings.push({ path: repositoryRelative, line: lineNumber, category: 'conflict-marker' });
    if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(line)) findings.push({ path: repositoryRelative, line: lineNumber, category: 'private-key' });
    if (secretPatterns.some((pattern) => pattern.test(line))) findings.push({ path: repositoryRelative, line: lineNumber, category: 'hard-coded-secret' });
  });
  return findings;
}

let paths;
try {
  paths = process.argv.length > 2 ? process.argv.slice(2) : defaultPaths();
  for (const path of paths) repositoryPath(path);
} catch (error) {
  if (error instanceof Error && error.message === 'path-outside-repository') {
    console.error('lint:error:path-outside-repository');
    process.exitCode = 2;
  } else {
    console.error('lint:error:unable-to-enumerate-files');
    process.exitCode = 2;
  }
}

if (paths && process.exitCode === undefined) {
  const findings = [];
  try {
    for (const path of paths) findings.push(...scanFile(path));
  } catch (error) {
    console.error(error instanceof Error && error.message === 'path-outside-repository'
      ? 'lint:error:path-outside-repository'
      : 'lint:error:unable-to-read-file');
    process.exitCode = 2;
  }

  if (process.exitCode === undefined) {
    for (const finding of findings) {
      console.error(`${finding.path}:${finding.line}:${finding.category}`);
    }
    if (findings.length > 0) {
      console.error(`lint:failed:${findings.length}`);
      process.exitCode = 1;
    } else {
      console.log(`lint:passed:${paths.length}`);
    }
  }
}
