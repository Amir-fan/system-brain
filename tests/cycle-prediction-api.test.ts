import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';

import type { Actor, Role } from '../src/core/authorization/actor.ts';
import type { ProjectBoundaryReaders } from '../src/core/authorization/project-boundary.ts';
import type { Project } from '../src/core/project/project.ts';
import {
  CyclePredictionRequestFailure,
  handleCyclePrediction,
  handleCyclePredictionRequest,
  type CyclePredictionApiDeps,
} from '../src/platform/api/cycle-prediction-handler.ts';
import { createHttpApi } from '../src/platform/api/http-server.ts';
import { StaticTokenAuthenticator } from '../src/platform/api/static-authenticator.ts';

const PROJECT_ID = 'project-cycle';
const ACTOR: Actor = 'user-cycle';
const CURRENT_DATE = '2026-11-21';
const INTERNAL_MESSAGE = 'cycle prediction unavailable';
const VALIDATION_MESSAGE = 'invalid cycle prediction request';
const ROUTE_TOKEN = 'cycle-route-token';
const ROUTE_PATH = `/v1/projects/${PROJECT_ID}/naqaa/cycle-predictions`;

const validBody = () => ({
  lastCycleStart: '2026-11-01',
  typicalBleedingDays: 7,
  typicalCycleDays: 30,
  regularity: 'regular' as const,
});

function project(status: Project['status'] = 'active'): Project {
  return {
    id: PROJECT_ID,
    name: 'Cycle Project',
    status,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function boundary(options: {
  exists?: boolean;
  status?: Project['status'];
  role?: Role | null;
  calls?: string[];
} = {}): ProjectBoundaryReaders {
  const { exists = true, status = 'active', role = 'member', calls = [] } = options;
  return {
    async getProject(projectId) {
      calls.push(`project:${projectId}`);
      return exists ? project(status) : null;
    },
    async getMembership(projectId, actor) {
      calls.push(`membership:${projectId}:${actor}`);
      return role === null ? null : { projectId, actor, role, createdAt: '' };
    },
  };
}

function deps(projectBoundary = boundary()): CyclePredictionApiDeps {
  return { boundary: projectBoundary, currentDate: () => CURRENT_DATE };
}

async function withPredictionServer<T>(
  options: {
    projectBoundary?: ProjectBoundaryReaders;
    includePredictionDeps?: boolean;
    runtimeCall?: () => void;
  },
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server: Server = createHttpApi({
    runtime: {
      async execute() {
        options.runtimeCall?.();
        throw new Error('UNUSED_RUNTIME_MUST_NOT_RUN');
      },
    },
    authenticator: new StaticTokenAuthenticator(new Map([[ROUTE_TOKEN, ACTOR]])),
    ...(options.includePredictionDeps === false
      ? {}
      : {
        cyclePrediction: {
          boundary: options.projectBoundary ?? boundary(),
          currentDate: () => CURRENT_DATE,
        },
      }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; contentType?: string | null; body?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

test('returns the resource-style versioned prediction without run fields', async () => {
  const result = await handleCyclePrediction(deps(), PROJECT_ID, ACTOR, validBody());

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result).sort(), ['data', 'ok', 'status']);
  if (!result.ok) return;
  assert.equal(result.data.predictedNextStart, '2026-12-01');
  assert.equal(result.data.windowStart, '2026-11-29');
  assert.equal(result.data.windowEnd, '2026-12-03');
  assert.equal(result.data.reliability, 'initial');
  assert.equal(result.data.integration.contractVersion, 'naqaa-cycle-prediction-v1');
  assert.match(result.data.integration.inputFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.data.fiqhImpact, 'none');
  assert.equal(result.data.purificationDetermination, false);
  assert.equal('runId' in result, false);
  assert.equal('result' in result, false);
});

test('authorizes before accessing a hostile body or invoking the clock', async () => {
  let bodyAccesses = 0;
  let clockCalls = 0;
  const guardedBody = new Proxy({}, {
    ownKeys() {
      bodyAccesses += 1;
      throw new Error('BODY_MUST_NOT_BE_ACCESSED');
    },
    get() {
      bodyAccesses += 1;
      throw new Error('BODY_MUST_NOT_BE_ACCESSED');
    },
  });
  const result = await handleCyclePrediction({
    boundary: boundary({ exists: false }),
    currentDate: () => {
      clockCalls += 1;
      throw new Error('CLOCK_MUST_NOT_BE_CALLED');
    },
  }, PROJECT_ID, ACTOR, guardedBody);

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    error: { category: 'not_found', message: 'project not found' },
  });
  assert.equal(bodyAccesses, 0);
  assert.equal(clockCalls, 0);
});

test('maps inactive and nonmember project access to exact 403 authorization envelopes', async () => {
  for (const authorizationCase of [
    { projectBoundary: boundary({ status: 'archived' }), message: 'project is not active' },
    { projectBoundary: boundary({ role: null }), message: 'actor is not a member' },
  ]) {
    const result = await handleCyclePrediction(
      deps(authorizationCase.projectBoundary),
      PROJECT_ID,
      ACTOR,
      validBody(),
    );
    assert.deepEqual(result, {
      ok: false,
      status: 403,
      error: { category: 'authorization', message: authorizationCase.message },
    });
  }
});

test('uses read authorization and does not require any service dependency beyond boundary and clock', async () => {
  const calls: string[] = [];
  const accessedDependencies: string[] = [];
  const minimal = {
    boundary: boundary({ calls }),
    currentDate: () => CURRENT_DATE,
  } satisfies CyclePredictionApiDeps;
  const guardedDeps = new Proxy(minimal, {
    get(target, property, receiver) {
      const name = String(property);
      accessedDependencies.push(name);
      if (name !== 'boundary' && name !== 'currentDate') {
        throw new Error(`UNEXPECTED_DEPENDENCY:${name}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const result = await handleCyclePrediction(guardedDeps, PROJECT_ID, ACTOR, validBody());

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [`project:${PROJECT_ID}`, `membership:${PROJECT_ID}:${ACTOR}`]);
  assert.deepEqual([...new Set(accessedDependencies)].sort(), ['boundary', 'currentDate']);
});

test('translates domain failures to stable generic 400 validation envelopes', async () => {
  const invalidCases = [
    {
      body: { ...validBody(), lastCycleStart: '2026-02-29' },
      code: 'PREDICTION_DATE_INVALID',
    },
    {
      body: { ...validBody(), typicalCycleDays: 0 },
      code: 'PREDICTION_NUMBER_OUT_OF_RANGE',
    },
  ] as const;

  for (const invalidCase of invalidCases) {
    const result = await handleCyclePrediction(deps(), PROJECT_ID, ACTOR, invalidCase.body);
    assert.deepEqual(result, {
      ok: false,
      status: 400,
      error: {
        category: 'validation',
        message: VALIDATION_MESSAGE,
        code: invalidCase.code,
      },
    });
    assert.equal(JSON.stringify(result).includes('2026-02-29'), false);
  }
});

test('rejects forbidden prediction fields rather than ignoring them', async () => {
  const sentinel = 'PRIVATE_SENTINEL_DO_NOT_ECHO';
  const forbiddenBodies = [
    { ...validBody(), subjectId: sentinel },
    { ...validBody(), scannerEvidence: { color: sentinel } },
    { ...validBody(), fiqhState: { ruling: sentinel } },
    { ...validBody(), asOf: '2020-01-01' },
  ];

  for (const body of forbiddenBodies) {
    const result = await handleCyclePrediction(deps(), PROJECT_ID, ACTOR, body);
    assert.deepEqual(result, {
      ok: false,
      status: 400,
      error: {
        category: 'validation',
        message: VALIDATION_MESSAGE,
        code: 'PREDICTION_INPUT_INVALID',
      },
    });
    assert.equal(JSON.stringify(result).includes(sentinel), false);
  }
});

test('rejects oversized confirmed history with its stable validation code', async () => {
  const confirmedCycleStarts = Array.from({ length: 121 }, () => '2026-11-01');
  const result = await handleCyclePrediction(deps(), PROJECT_ID, ACTOR, {
    ...validBody(),
    confirmedCycleStarts,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: {
      category: 'validation',
      message: VALIDATION_MESSAGE,
      code: 'PREDICTION_HISTORY_TOO_LONG',
    },
  });
});

test('the default clock supplies the current UTC calendar date', async () => {
  const utcToday = new Date().toISOString().slice(0, 10);
  const result = await handleCyclePrediction({ boundary: boundary() }, PROJECT_ID, ACTOR, {
    ...validBody(),
    lastCycleStart: utcToday,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('the built-in clock uses the UTC date at a year boundary', async (context) => {
  context.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2030-12-31T23:59:59.999Z'),
  });

  const today = await handleCyclePrediction({ boundary: boundary() }, PROJECT_ID, ACTOR, {
    ...validBody(),
    lastCycleStart: '2030-12-31',
  });
  const tomorrow = await handleCyclePrediction({ boundary: boundary() }, PROJECT_ID, ACTOR, {
    ...validBody(),
    lastCycleStart: '2031-01-01',
  });

  assert.equal(today.ok, true);
  assert.deepEqual(tomorrow, {
    ok: false,
    status: 400,
    error: {
      category: 'validation',
      message: VALIDATION_MESSAGE,
      code: 'PREDICTION_DATE_IN_FUTURE',
    },
  });
});

test('a configured clock returning no value fails without wall-clock fallback or body access', async () => {
  for (const missingValue of [undefined, null]) {
    let bodyAccesses = 0;
    const guardedBody = new Proxy({}, {
      ownKeys() {
        bodyAccesses += 1;
        throw new Error('BODY_MUST_NOT_BE_ACCESSED');
      },
      get() {
        bodyAccesses += 1;
        throw new Error('BODY_MUST_NOT_BE_ACCESSED');
      },
    });
    const adversarialDeps = {
      boundary: boundary(),
      currentDate: () => missingValue,
    } as unknown as CyclePredictionApiDeps;

    const result = await handleCyclePrediction(adversarialDeps, PROJECT_ID, ACTOR, guardedBody);

    assert.deepEqual(result, {
      ok: false,
      status: 500,
      error: { category: 'runtime', message: INTERNAL_MESSAGE },
    });
    assert.equal(bodyAccesses, 0);
  }
});

test('a configured currentDate method retains its dependency-object receiver', async () => {
  class MethodBackedDeps implements CyclePredictionApiDeps {
    readonly boundary = boundary();
    readonly #date = CURRENT_DATE;

    currentDate(): string {
      return this.#date;
    }
  }

  const result = await handleCyclePrediction(new MethodBackedDeps(), PROJECT_ID, ACTOR, validBody());

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test('normalizes unexpected boundary and clock errors without body access or details', async () => {
  let bodyAccesses = 0;
  let clockCalls = 0;
  const guardedBody = new Proxy({}, {
    ownKeys() {
      bodyAccesses += 1;
      throw new Error('BODY_SENTINEL');
    },
  });
  const boundaryError = await handleCyclePrediction({
    boundary: {
      async getProject() {
        throw new Error('BOUNDARY_PRIVATE_SENTINEL');
      },
      async getMembership() {
        throw new Error('MEMBERSHIP_MUST_NOT_RUN');
      },
    },
    currentDate: () => {
      clockCalls += 1;
      return CURRENT_DATE;
    },
  }, PROJECT_ID, ACTOR, guardedBody);

  assert.deepEqual(boundaryError, {
    ok: false,
    status: 500,
    error: { category: 'runtime', message: INTERNAL_MESSAGE },
  });
  assert.equal(bodyAccesses, 0);
  assert.equal(clockCalls, 0);

  const clockError = await handleCyclePrediction({
    boundary: boundary(),
    currentDate: () => {
      throw new Error('CLOCK_PRIVATE_SENTINEL');
    },
  }, PROJECT_ID, ACTOR, guardedBody);
  assert.deepEqual(clockError, {
    ok: false,
    status: 500,
    error: { category: 'runtime', message: INTERNAL_MESSAGE },
  });
  assert.equal(bodyAccesses, 0);

  const malformedClock = await handleCyclePrediction({
    boundary: boundary(),
    currentDate: () => 'not-a-calendar-date',
  }, PROJECT_ID, ACTOR, guardedBody);
  assert.deepEqual(malformedClock, {
    ok: false,
    status: 500,
    error: { category: 'runtime', message: INTERNAL_MESSAGE },
  });
  assert.equal(bodyAccesses, 0);
});

test('normalizes unexpected body failures and never logs request or sentinel details', async () => {
  const sentinel = 'PRIVATE_BODY_SENTINEL';
  const logged: unknown[] = [];
  const originalConsole = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  console.error = (...values: unknown[]) => { logged.push(...values); };
  console.info = (...values: unknown[]) => { logged.push(...values); };
  console.log = (...values: unknown[]) => { logged.push(...values); };
  console.warn = (...values: unknown[]) => { logged.push(...values); };

  try {
    const hostileBody = new Proxy({}, {
      ownKeys() {
        throw new Error(sentinel);
      },
    });
    const result = await handleCyclePrediction(deps(), PROJECT_ID, ACTOR, hostileBody);

    assert.deepEqual(result, {
      ok: false,
      status: 500,
      error: { category: 'runtime', message: INTERNAL_MESSAGE },
    });
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.deepEqual(logged, []);
  } finally {
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
});

test('the deferred body seam authorizes once before invoking its reader', async () => {
  let readerCalls = 0;
  const calls: string[] = [];
  const result = await handleCyclePredictionRequest(
    deps(boundary({ exists: false, calls })),
    PROJECT_ID,
    ACTOR,
    async () => {
      readerCalls += 1;
      throw new Error('READER_MUST_NOT_RUN');
    },
  );

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    error: { category: 'not_found', message: 'project not found' },
  });
  assert.deepEqual(calls, [`project:${PROJECT_ID}`]);
  assert.equal(readerCalls, 0);
});

test('the deferred body seam distinguishes safe request failures from unexpected reader failures', async () => {
  const invalidRequest = await handleCyclePredictionRequest(
    deps(),
    PROJECT_ID,
    ACTOR,
    async () => { throw new CyclePredictionRequestFailure(); },
  );
  const internalReaderFailure = await handleCyclePredictionRequest(
    deps(),
    PROJECT_ID,
    ACTOR,
    async () => { throw new Error('PRIVATE_READER_SENTINEL'); },
  );

  assert.deepEqual(invalidRequest, {
    ok: false,
    status: 400,
    error: {
      category: 'validation',
      message: 'invalid cycle prediction request body',
      code: 'PREDICTION_REQUEST_INVALID',
    },
  });
  assert.deepEqual(internalReaderFailure, {
    ok: false,
    status: 500,
    error: { category: 'runtime', message: INTERNAL_MESSAGE },
  });
  assert.equal(JSON.stringify(internalReaderFailure).includes('PRIVATE_READER_SENTINEL'), false);
});

test('the exact POST route returns the prediction resource contract without using runtime', async () => {
  let runtimeCalls = 0;
  await withPredictionServer({ runtimeCall: () => { runtimeCalls += 1; } }, async (baseUrl) => {
    const response = await requestJson(baseUrl, ROUTE_PATH, {
      token: ROUTE_TOKEN,
      body: JSON.stringify(validBody()),
    });

    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.status, 200);
    const data = response.json.data as Record<string, unknown>;
    assert.equal(data.predictedNextStart, '2026-12-01');
    assert.equal(data.windowStart, '2026-11-29');
    assert.equal(data.windowEnd, '2026-12-03');
    assert.equal(data.fiqhImpact, 'none');
    assert.equal(data.purificationDetermination, false);
    assert.equal(
      /hayd|tuhr|istihada|decisionLabel|ruling|prayer|fasting/i.test(JSON.stringify(data)),
      false,
    );
    assert.equal('runId' in response.json, false);
    assert.equal('result' in response.json, false);
  });
  assert.equal(runtimeCalls, 0);
});

test('the route resolves actor and project authorization before malformed or oversized bodies', async () => {
  const oversized = `"${'x'.repeat(999_999)}"`;

  await withPredictionServer({}, async (baseUrl) => {
    const unauthenticated = await requestJson(baseUrl, ROUTE_PATH, {
      body: '{"private":',
    });
    assert.deepEqual(unauthenticated, {
      status: 401,
      json: { ok: false, status: 401, error: { category: 'authorization', message: 'authentication required' } },
    });
  });

  await withPredictionServer({ projectBoundary: boundary({ role: null }) }, async (baseUrl) => {
    const forbidden = await requestJson(baseUrl, ROUTE_PATH, {
      token: ROUTE_TOKEN,
      body: oversized,
    });
    assert.deepEqual(forbidden, {
      status: 403,
      json: { ok: false, status: 403, error: { category: 'authorization', message: 'actor is not a member' } },
    });
  });

  await withPredictionServer({ projectBoundary: boundary({ exists: false }) }, async (baseUrl) => {
    const missing = await requestJson(baseUrl, ROUTE_PATH, {
      token: ROUTE_TOKEN,
      body: '{"private":',
    });
    assert.deepEqual(missing, {
      status: 404,
      json: { ok: false, status: 404, error: { category: 'not_found', message: 'project not found' } },
    });
  });
});

test('the prediction reader accepts application/json case-insensitively with parameters', async () => {
  for (const contentType of ['application/json', 'Application/JSON; Charset=UTF-8']) {
    await withPredictionServer({}, async (baseUrl) => {
      const response = await requestJson(baseUrl, ROUTE_PATH, {
        token: ROUTE_TOKEN,
        contentType,
        body: JSON.stringify(validBody()),
      });
      assert.equal(response.status, 200, contentType);
      assert.equal(response.json.ok, true, contentType);
    });
  }
});

test('the prediction reader safely rejects missing/unsupported content types and malformed JSON', async () => {
  const invalidRequests = [
    { contentType: null, body: JSON.stringify(validBody()) },
    { contentType: 'text/plain', body: JSON.stringify(validBody()) },
    { contentType: 'application/json', body: '{"health":"PRIVATE_HEALTH_SENTINEL"' },
  ] as const;

  for (const invalidRequest of invalidRequests) {
    await withPredictionServer({}, async (baseUrl) => {
      const response = await requestJson(baseUrl, ROUTE_PATH, {
        token: ROUTE_TOKEN,
        contentType: invalidRequest.contentType,
        body: invalidRequest.body,
      });
      assert.deepEqual(response, {
        status: 400,
        json: {
          ok: false,
          status: 400,
          error: {
            category: 'validation',
            message: 'invalid cycle prediction request body',
            code: 'PREDICTION_REQUEST_INVALID',
          },
        },
      });
      assert.equal(JSON.stringify(response).includes('PRIVATE_HEALTH_SENTINEL'), false);
    });
  }
});

test('the prediction reader accepts exactly one million decoded characters and rejects one more', async () => {
  const atLimit = `"${'x'.repeat(999_998)}"`;
  const aboveLimit = `"${'x'.repeat(999_999)}"`;
  assert.equal(atLimit.length, 1_000_000);
  assert.equal(aboveLimit.length, 1_000_001);

  await withPredictionServer({}, async (baseUrl) => {
    const acceptedByReader = await requestJson(baseUrl, ROUTE_PATH, {
      token: ROUTE_TOKEN,
      body: atLimit,
    });
    assert.equal(acceptedByReader.status, 400);
    assert.deepEqual(acceptedByReader.json.error, {
      category: 'validation',
      message: VALIDATION_MESSAGE,
      code: 'PREDICTION_INPUT_INVALID',
    });

    const rejectedByReader = await requestJson(baseUrl, ROUTE_PATH, {
      token: ROUTE_TOKEN,
      body: aboveLimit,
    });
    assert.deepEqual(rejectedByReader, {
      status: 400,
      json: {
        ok: false,
        status: 400,
        error: {
          category: 'validation',
          message: 'invalid cycle prediction request body',
          code: 'PREDICTION_REQUEST_INVALID',
        },
      },
    });
  });
});

test('GET, extra path segments, and missing prediction dependencies remain 404', async () => {
  await withPredictionServer({}, async (baseUrl) => {
    for (const request of [
      { path: ROUTE_PATH, method: 'GET' },
      { path: `${ROUTE_PATH}/extra`, method: 'POST' },
      { path: '/v1/projects/%ZZ/naqaa/cycle-predictions', method: 'POST' },
    ]) {
      const response = await requestJson(baseUrl, request.path, {
        method: request.method,
        token: ROUTE_TOKEN,
        ...(request.method === 'POST' ? { body: JSON.stringify(validBody()) } : {}),
      });
      assert.deepEqual(response, {
        status: 404,
        json: { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } },
      });
    }
  });

  await withPredictionServer({ includePredictionDeps: false }, async (baseUrl) => {
    const response = await requestJson(baseUrl, ROUTE_PATH, {
      token: ROUTE_TOKEN,
      body: JSON.stringify(validBody()),
    });
    assert.deepEqual(response, {
      status: 404,
      json: { ok: false, status: 404, error: { category: 'not_found', message: 'not found' } },
    });
  });
});

test('route boundary failures normalize to generic 500 and health sentinels are not logged', async () => {
  const sentinel = 'PRIVATE_HEALTH_SENTINEL';
  const logged: unknown[] = [];
  const originalConsole = { error: console.error, info: console.info, log: console.log, warn: console.warn };
  console.error = (...values: unknown[]) => { logged.push(...values); };
  console.info = (...values: unknown[]) => { logged.push(...values); };
  console.log = (...values: unknown[]) => { logged.push(...values); };
  console.warn = (...values: unknown[]) => { logged.push(...values); };
  try {
    await withPredictionServer({
      projectBoundary: {
        async getProject() { throw new Error(sentinel); },
        async getMembership() { throw new Error('MEMBERSHIP_MUST_NOT_RUN'); },
      },
    }, async (baseUrl) => {
      const response = await requestJson(baseUrl, ROUTE_PATH, {
        token: ROUTE_TOKEN,
        body: `{"health":"${sentinel}"}`,
      });
      assert.deepEqual(response, {
        status: 500,
        json: { ok: false, status: 500, error: { category: 'runtime', message: INTERNAL_MESSAGE } },
      });
      assert.equal(JSON.stringify(response).includes(sentinel), false);
    });
    assert.equal(logged.some((value) => String(value).includes(sentinel)), false);
  } finally {
    console.error = originalConsole.error;
    console.info = originalConsole.info;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }
});

test('a client cancellation during project authorization cannot leave the route pending', async () => {
  let releaseProject!: () => void;
  let projectReadStarted!: () => void;
  const projectGate = new Promise<void>((resolve) => { releaseProject = resolve; });
  const projectStarted = new Promise<void>((resolve) => { projectReadStarted = resolve; });
  const server = createHttpApi({
    runtime: { async execute() { throw new Error('UNUSED_RUNTIME_MUST_NOT_RUN'); } },
    authenticator: new StaticTokenAuthenticator(new Map([[ROUTE_TOKEN, ACTOR]])),
    cyclePrediction: {
      boundary: {
        async getProject() {
          projectReadStarted();
          await projectGate;
          return project();
        },
        async getMembership(projectId, actor) {
          return { projectId, actor, role: 'member', createdAt: '' };
        },
      },
      currentDate: () => CURRENT_DATE,
    },
  });
  const requestListener = server.listeners('request')[0] as (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  const socket = new PassThrough();
  const request = new IncomingMessage(socket as never);
  request.method = 'POST';
  request.url = ROUTE_PATH;
  request.headers = {
    authorization: `Bearer ${ROUTE_TOKEN}`,
    'content-type': 'application/json',
  };
  const response = new ServerResponse(request);

  const route = requestListener(request, response);
  await projectStarted;
  const requestClosed = new Promise<void>((resolve) => request.once('close', resolve));
  request.destroy();
  await requestClosed;
  releaseProject();

  const outcome = await Promise.race([
    route.then(() => 'settled' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250)),
  ]);
  assert.equal(outcome, 'settled');
  server.close();
});
