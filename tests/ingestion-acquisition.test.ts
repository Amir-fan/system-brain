import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/platform/ingestion/html-to-text.ts';
import { assertUrlAllowed, isBlockedHostname, isBlockedIp } from '../src/platform/ingestion/url-safety.ts';
import { IngestionFailure } from '../src/core/ingestion/ingestion.types.ts';
import {
  selectAcquirablePaths,
  isSecretLikePath,
  combineFiles,
  GITHUB_ACQUISITION_LIMITS,
} from '../src/platform/ingestion/github-acquisition.ts';
import { createUrlAcquisitionAdapter } from '../src/platform/ingestion/url-acquisition.ts';
import { createGitHubAcquisitionAdapter } from '../src/platform/ingestion/github-acquisition.ts';

// ---------------------------------------------------------------- HTML -> text

test('html: keeps title, headings, paragraphs and list items; drops non-content', () => {
  const html = `<!doctype html><html><head><title>KIP Docs</title>
    <style>body{color:red}</style><script>window.x=1</script></head>
    <body><h1>Architecture</h1><p>Modular monolith.</p>
    <ul><li>Core</li><li>Skills</li></ul>
    <noscript>enable js</noscript></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'KIP Docs');
  assert.ok(text.startsWith('KIP Docs'), 'title is preserved at the top');
  assert.ok(text.includes('Architecture'));
  assert.ok(text.includes('Modular monolith.'));
  assert.ok(text.includes('- Core') && text.includes('- Skills'), 'list items kept as bullets');
  assert.ok(!text.includes('window.x'), 'script content removed');
  assert.ok(!text.includes('color:red'), 'style content removed');
  assert.ok(!text.includes('enable js'), 'noscript removed');
});

test('html: decodes entities and is deterministic', () => {
  const html = '<p>a &amp; b &lt;tag&gt; &quot;q&quot; &#39;s&#39;&nbsp;end</p>';
  assert.equal(htmlToText(html).text, 'a & b <tag> "q" \'s\' end');
  assert.deepEqual(htmlToText(html), htmlToText(html));
});

test('html: never manufactures content from an empty document', () => {
  assert.equal(htmlToText('<html><head><title></title><script>x</script></head><body></body></html>').text, '');
});

// ---------------------------------------------------------------- SSRF guard

test('ssrf: blocked IPv4 ranges', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '198.18.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip + ' must be blocked');
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
    assert.equal(isBlockedIp(ip), false, ip + ' must be allowed');
  }
});

test('ssrf: blocked IPv6 forms', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip + ' must be blocked');
  }
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
});

test('ssrf: blocked hostnames', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', 'thing.local', 'svc.internal', 'metadata.google.internal', 'instance-data']) {
    assert.equal(isBlockedHostname(host), true, host + ' must be blocked');
  }
  assert.equal(isBlockedHostname('example.com'), false);
});

test('ssrf: assertUrlAllowed rejects schemes and private targets, allows public', async () => {
  const resolveTo = (addrs: string[]) => async () => addrs;

  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
    await assert.rejects(() => assertUrlAllowed(bad, { resolve: resolveTo(['93.184.216.34']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED', bad);
  }
  await assert.rejects(() => assertUrlAllowed('http://localhost', { resolve: resolveTo(['127.0.0.1']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED');
  await assert.rejects(() => assertUrlAllowed('http://127.0.0.1', { resolve: resolveTo(['127.0.0.1']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED');
  await assert.rejects(() => assertUrlAllowed('http://169.254.169.254', { resolve: resolveTo(['169.254.169.254']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED');
  await assert.rejects(() => assertUrlAllowed('http://10.0.0.10', { resolve: resolveTo(['10.0.0.10']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED');
  // public hostname that RESOLVES to a private address is still refused
  await assert.rejects(() => assertUrlAllowed('http://internal.example.com', { resolve: resolveTo(['192.168.0.10']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED');
  // credentials in the URL are refused
  await assert.rejects(() => assertUrlAllowed('http://user:pw@example.com', { resolve: resolveTo(['93.184.216.34']) }), (e: IngestionFailure) => e.code === 'URL_BLOCKED');
  // unresolvable host is a fetch failure, not a policy violation
  await assert.rejects(() => assertUrlAllowed('http://nope.invalid', { resolve: async () => { throw new Error('ENOTFOUND'); } }), (e: IngestionFailure) => e.code === 'URL_FETCH_FAILED');
  // a genuine public target passes
  const ok = await assertUrlAllowed('https://example.com/page', { resolve: resolveTo(['93.184.216.34']) });
  assert.equal(ok.hostname, 'example.com');
});

// ---------------------------------------------------------------- GitHub selection

test('github: selection keeps text files only, excludes dirs and secret files', () => {
  const paths = [
    'README.md',
    'docs/architecture.md',
    'src/index.ts',
    'package.json',
    'node_modules/dep/index.js',
    'dist/bundle.js',
    'vendor/lib.py',
    '.env',
    '.env.local',
    'certs/key.pem',
    'id_rsa',
    'secrets.json',
    'logo.png',
    'package-lock.json',
    '.agents/skills/supabase/SKILL.md',
    'deep/a/b/c/notes.md',
  ];
  const selected = selectAcquirablePaths(paths);
  assert.deepEqual(selected, ['README.md', 'package.json', 'docs/architecture.md', 'src/index.ts', 'deep/a/b/c/notes.md']);
  // pointer on what the ordering guarantees: top-level files come first
  assert.equal(selected[0], 'README.md', 'top-level knowledge files win the cap');
  assert.equal(selected[selected.length - 1], 'deep/a/b/c/notes.md', 'deep paths sort last');
  assert.equal(isSecretLikePath('.env'), true);
  assert.equal(isSecretLikePath('.env.local'), true);
  assert.equal(isSecretLikePath('certs/key.pem'), true);
  assert.equal(isSecretLikePath('id_rsa'), true);
  assert.equal(isSecretLikePath('README.md'), false);
});

test('github: combined representation is ordered, bounded and path-labelled', () => {
  const combined = combineFiles([
    { path: 'README.md', text: '# Title' },
    { path: 'src/a.ts', text: 'const a = 1;' },
  ]);
  assert.equal(combined, '--- FILE: README.md ---\n# Title\n\n--- FILE: src/a.ts ---\nconst a = 1;');
});

test('github: limits are conservative and explicit', () => {
  assert.ok(GITHUB_ACQUISITION_LIMITS.maxFiles <= 100);
  assert.ok(GITHUB_ACQUISITION_LIMITS.maxFileBytes <= 1_000_000);
  assert.ok(GITHUB_ACQUISITION_LIMITS.maxTotalBytes <= 5_000_000);
});

const TOKEN = 'ghs_installationTokenPlaceholderForTest';

function githubHarness(opts: {
  connection?: unknown;
  reference?: unknown;
  files: Array<{ path: string; text: string; size?: number }>;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}) {
  const blobs = new Map<string, string>();
  const tree = opts.files.map((f, i) => {
    const sha = 'sha' + i;
    blobs.set(sha, Buffer.from(f.text, 'utf8').toString('base64'));
    return { path: f.path, type: 'blob', size: f.size ?? Buffer.byteLength(f.text, 'utf8'), sha };
  });

  const connections = {
    getConnection: async () => opts.connection,
    getReferenceBySource: async () => opts.reference,
  } as never;
  const app = { installationToken: async () => TOKEN } as never;

  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes('/git/trees/')) return new Response(JSON.stringify({ tree }), { status: 200, headers: { 'content-type': 'application/json' } });
    const m = /\/git\/blobs\/([^/?]+)/.exec(u);
    if (m) {
      const content = blobs.get(m[1]);
      if (content === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ content, encoding: 'base64' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const adapter = createGitHubAcquisitionAdapter({
    sources: { getSource: async () => ({ id: 's1', projectId: 'p1', sourceType: 'github', status: 'registered' }) } as never,
    connections,
    app,
    fetchImpl,
    ...(opts.maxFiles ? { maxFiles: opts.maxFiles } : {}),
    ...(opts.maxFileBytes ? { maxFileBytes: opts.maxFileBytes } : {}),
    ...(opts.maxTotalBytes ? { maxTotalBytes: opts.maxTotalBytes } : {}),
  });
  return { adapter, blobs, tree };
}

test('github: acquires real repository file content through the installation', async () => {
  const { adapter } = githubHarness({
    connection: { id: 'c1', projectId: 'p1', provider: 'github', status: 'connected', accountId: '161612762', accountLabel: 'bolaith' },
    reference: { sourceId: 's1', provider: 'github', externalItemId: '1369793273', externalType: 'repository', displayName: 'bolaith/kip-next', externalPath: 'main' },
    files: [
      { path: 'README.md', text: '# KIP Next\nClean-room rebuild.' },
      { path: 'src/platform/api/http-server.ts', text: 'export function createHttpApi() {}' },
      { path: '.env', text: 'SUPABASE_SECRET_KEY=should-never-be-acquired' },
      { path: 'node_modules/x/index.js', text: 'module.exports=1' },
    ],
  });
  const acquired = await adapter.acquire({ projectId: 'p1', sourceId: 's1', sourceType: 'github' });
  assert.ok(acquired.text.includes('--- FILE: README.md ---'));
  assert.ok(acquired.text.includes('Clean-room rebuild.'));
  assert.ok(acquired.text.includes('--- FILE: src/platform/api/http-server.ts ---'));
  assert.ok(!acquired.text.includes('.env'), 'secret file must not be acquired');
  assert.ok(!acquired.text.includes('node_modules'), 'excluded directory must not be acquired');
  assert.ok(!acquired.text.includes('should-never-be-acquired'), 'secret content must never appear');
  assert.equal(acquired.provenance.kind, 'github');
  assert.equal(acquired.provenance.detail, 'bolaith/kip-next');
  assert.equal(acquired.provenance.fileCount, 2);
  assert.equal(acquired.provenance.truncated, undefined);
});

test('github: the installation token never appears in the acquired payload', async () => {
  const { adapter } = githubHarness({
    connection: { id: 'c1', projectId: 'p1', provider: 'github', status: 'connected', accountId: '1' },
    reference: { sourceId: 's1', provider: 'github', externalItemId: '1', externalType: 'repository', displayName: 'a/b', externalPath: 'main' },
    files: [{ path: 'README.md', text: 'hello' }],
  });
  const acquired = await adapter.acquire({ projectId: 'p1', sourceId: 's1', sourceType: 'github' });
  assert.ok(!JSON.stringify(acquired).includes(TOKEN), 'token must not leak into acquired content or provenance');
});

test('github: without a connected installation the acquisition fails explicitly', async () => {
  const { adapter } = githubHarness({
    connection: { id: 'c1', projectId: 'p1', provider: 'github', status: 'not_connected', accountId: undefined },
    reference: { sourceId: 's1', provider: 'github', externalItemId: '1', externalType: 'repository', displayName: 'a/b', externalPath: 'main' },
    files: [{ path: 'README.md', text: 'x' }],
  });
  await assert.rejects(
    () => adapter.acquire({ projectId: 'p1', sourceId: 's1', sourceType: 'github' }),
    (e: IngestionFailure) => e.code === 'GITHUB_NOT_CONNECTED',
  );
});

test('github: maxFiles cap yields a bounded, flagged result', async () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ path: 'doc-' + i + '.md', text: 'c' + i }));
  const { adapter } = githubHarness({
    connection: { id: 'c1', projectId: 'p1', provider: 'github', status: 'connected', accountId: '1' },
    reference: { sourceId: 's1', provider: 'github', externalItemId: '1', externalType: 'repository', displayName: 'a/b', externalPath: 'main' },
    files,
    maxFiles: 3,
  });
  const acquired = await adapter.acquire({ projectId: 'p1', sourceId: 's1', sourceType: 'github' });
  assert.equal(acquired.provenance.fileCount, 3);
  assert.equal(acquired.provenance.truncated, true);
});

test('github: an oversized file is skipped, not downloaded whole', async () => {
  const { adapter } = githubHarness({
    connection: { id: 'c1', projectId: 'p1', provider: 'github', status: 'connected', accountId: '1' },
    reference: { sourceId: 's1', provider: 'github', externalItemId: '1', externalType: 'repository', displayName: 'a/b', externalPath: 'main' },
    files: [
      { path: 'huge.md', text: 'z', size: 5_000_000 },
      { path: 'small.md', text: 'ok' },
    ],
  });
  const acquired = await adapter.acquire({ projectId: 'p1', sourceId: 's1', sourceType: 'github' });
  assert.equal(acquired.provenance.truncated, true);
  assert.ok(acquired.text.includes('small.md'));
  assert.ok(!acquired.text.includes('huge.md'));
});

test('github: a repository with no acquirable text fails explicitly', async () => {
  const { adapter } = githubHarness({
    connection: { id: 'c1', projectId: 'p1', provider: 'github', status: 'connected', accountId: '1' },
    reference: { sourceId: 's1', provider: 'github', externalItemId: '1', externalType: 'repository', displayName: 'a/b', externalPath: 'main' },
    files: [
      { path: 'image.png', text: 'binary' },
      { path: '.env.local', text: 'secret' },
    ],
  });
  await assert.rejects(
    () => adapter.acquire({ projectId: 'p1', sourceId: 's1', sourceType: 'github' }),
    (e: IngestionFailure) => e.code === 'GITHUB_ACQUISITION_FAILED',
  );
});
