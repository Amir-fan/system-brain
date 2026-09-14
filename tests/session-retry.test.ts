import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithSessionRetry, SESSION_EXPIRED_MESSAGE } from '../frontend/src/api/session-retry.ts';

/** Build session ports with call counters so we can assert exact retry behavior. */
function makePorts(opts: { token?: string | null; fresh?: string | null }) {
  const calls = { get: 0, refresh: 0, expired: 0 };
  const ports = {
    getToken: async () => {
      calls.get++;
      return opts.token ?? null;
    },
    refresh: async () => {
      calls.refresh++;
      return opts.fresh ?? null;
    },
    onExpired: () => {
      calls.expired++;
    },
  };
  return { ports, calls };
}

test('valid token: single attempt, no refresh', async () => {
  const { ports, calls } = makePorts({ token: 'good' });
  const seen: string[] = [];
  const res = await runWithSessionRetry(ports, async (t) => {
    seen.push(t);
    return { status: 200, body: { data: ['ok'] } };
  });
  assert.equal(res.status, 200);
  assert.equal(res.refreshed, false);
  assert.deepEqual(seen, ['good']);
  assert.equal(calls.refresh, 0);
  assert.equal(calls.expired, 0);
});

test('expired token + successful refresh: retried once with the fresh token', async () => {
  const { ports, calls } = makePorts({ token: 'stale', fresh: 'fresh' });
  const seen: string[] = [];
  const res = await runWithSessionRetry(ports, async (t) => {
    seen.push(t);
    return t === 'fresh' ? { status: 200, body: { data: ['ok'] } } : { status: 401, body: {} };
  });
  assert.equal(res.status, 200);
  assert.equal(res.refreshed, true);
  assert.deepEqual(seen, ['stale', 'fresh']);
  assert.equal(calls.refresh, 1);
  assert.equal(calls.expired, 0);
});

test('failed refresh: session cleared, expiry message thrown, no infinite retry', async () => {
  const { ports, calls } = makePorts({ token: 'stale', fresh: null });
  let attempts = 0;
  await assert.rejects(
    () =>
      runWithSessionRetry(ports, async () => {
        attempts++;
        return { status: 401, body: {} };
      }),
    (e: Error) => e.message === SESSION_EXPIRED_MESSAGE,
  );
  assert.equal(attempts, 1, 'must not retry without a fresh token');
  assert.equal(calls.refresh, 1, 'exactly one refresh attempt');
  assert.equal(calls.expired, 1, 'local auth state cleared');
});

test('retry after refresh still 401: treat as unrecoverable session', async () => {
  const { ports, calls } = makePorts({ token: 'stale', fresh: 'fresh' });
  await assert.rejects(
    () => runWithSessionRetry(ports, async () => ({ status: 401, body: {} })),
    (e: Error) => e.message === SESSION_EXPIRED_MESSAGE,
  );
  assert.equal(calls.refresh, 1);
  assert.equal(calls.expired, 1);
});

test('403 never triggers a refresh (permission errors must not be masked as expiry)', async () => {
  const { ports, calls } = makePorts({ token: 'good', fresh: 'fresh' });
  const res = await runWithSessionRetry(ports, async () => ({ status: 403, body: { error: { message: 'forbidden' } } }));
  assert.equal(res.status, 403);
  assert.equal(calls.refresh, 0, 'no refresh on 403');
  assert.equal(calls.expired, 0);
});

test('no token at all: session cleared immediately', async () => {
  const { ports, calls } = makePorts({ token: null });
  await assert.rejects(
    () => runWithSessionRetry(ports, async () => ({ status: 200, body: {} })),
    (e: Error) => e.message === SESSION_EXPIRED_MESSAGE,
  );
  assert.equal(calls.expired, 1);
});
