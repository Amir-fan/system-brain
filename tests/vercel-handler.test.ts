import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { HttpApiHandler } from '../src/platform/api/http-server.ts';
import { createVercelHandler } from '../src/platform/vercel/vercel-handler.ts';

test('Vercel configuration routes the complete API surface to the bounded function', async () => {
  const configuration = JSON.parse(await readFile('vercel.json', 'utf8')) as {
    framework?: string | null;
    buildCommand?: string | null;
    functions?: Record<string, { maxDuration?: number }>;
    rewrites?: Array<{ source?: string; destination?: string }>;
  };

  assert.equal(configuration.framework, null);
  assert.equal(configuration.buildCommand, null);
  assert.equal(configuration.functions?.['api/index.ts']?.maxDuration, 60);
  assert.deepEqual(configuration.rewrites, [{
    source: '/v1/:path*',
    destination: '/api/index?__kip_path=/v1/:path*',
  }]);
});

async function withServer(
  handler: HttpApiHandler,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('Vercel adapter restores the canonical path and preserves caller query values', async () => {
  const seenUrls: string[] = [];
  let loads = 0;
  const canonicalHandler: HttpApiHandler = async (request, response) => {
    seenUrls.push(request.url ?? '');
    response.statusCode = 204;
    response.end();
  };
  const handler = createVercelHandler(async () => {
    loads += 1;
    return canonicalHandler;
  });

  await withServer(handler, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/index?__kip_path=/v1/projects&limit=2`);
    const second = await fetch(`${baseUrl}/api/index?__kip_path=/v1/projects/demo/runs`);
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
  });

  assert.deepEqual(seenUrls, ['/v1/projects?limit=2', '/v1/projects/demo/runs']);
  assert.equal(loads, 1, 'composition should be reused by warm function invocations');
});

test('Vercel adapter rejects missing, duplicate, or non-KIP route parameters', async () => {
  let loads = 0;
  const handler = createVercelHandler(async () => {
    loads += 1;
    throw new Error('must not initialize');
  });

  await withServer(handler, async (baseUrl) => {
    for (const path of [
      '/api/index',
      '/api/index?__kip_path=/admin',
      '/api/index?__kip_path=/v1/projects&__kip_path=/v1/admin',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), {
        ok: false,
        status: 404,
        error: { category: 'not_found', message: 'not found' },
      });
    }
  });

  assert.equal(loads, 0);
});

test('Vercel adapter returns a generic error and retries a failed cold start', async () => {
  let loads = 0;
  const originalConsoleError = console.error;
  const originalTestSecret = process.env.KIP_TEST_SECRET_KEY;
  const syntheticSecret = 'synthetic-private-bootstrap-secret';
  const diagnostics: string[] = [];
  process.env.KIP_TEST_SECRET_KEY = syntheticSecret;
  console.error = (...values: unknown[]) => diagnostics.push(values.join(' '));
  const handler = createVercelHandler(async () => {
    loads += 1;
    throw new Error(`private bootstrap diagnostics: ${syntheticSecret}`);
  });

  try {
    await withServer(handler, async (baseUrl) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/index?__kip_path=/v1/projects`);
        assert.equal(response.status, 500);
        const text = await response.text();
        assert.equal(text.includes('private bootstrap diagnostics'), false);
        assert.deepEqual(JSON.parse(text), {
          ok: false,
          status: 500,
          error: { category: 'runtime', message: 'internal error' },
        });
      }
    });
  } finally {
    console.error = originalConsoleError;
    if (originalTestSecret === undefined) delete process.env.KIP_TEST_SECRET_KEY;
    else process.env.KIP_TEST_SECRET_KEY = originalTestSecret;
  }

  assert.equal(loads, 2);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics.every((entry) => entry.includes('private bootstrap diagnostics')), true);
  assert.equal(diagnostics.some((entry) => entry.includes(syntheticSecret)), false);
  assert.equal(diagnostics.every((entry) => entry.includes('<redacted>')), true);
});
