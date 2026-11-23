import { spawnSync } from 'node:child_process';

const credentialNames = [
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'KIP_DEMO_PASSWORD',
  'KIP_PLATFORM_ADMIN_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENROUTER_TEST_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_URL',
];
const environment = { ...process.env };
const credentialSet = new Set(credentialNames);
for (const name of Object.keys(environment)) {
  if (credentialSet.has(name.toUpperCase())) delete environment[name];
}

const steps = [
  ['run', 'lint'],
  ['run', 'typecheck'],
  ['test'],
  ['--prefix', 'frontend', 'run', 'build'],
];

const npmExecutable = process.env.npm_execpath;
if (!npmExecutable) {
  console.error('verify:local must be started through npm');
  process.exit(2);
}

for (const step of steps) {
  const result = spawnSync(process.execPath, [npmExecutable, ...step], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error('verify:local could not start a required command');
    process.exit(2);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
