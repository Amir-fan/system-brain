/**
 * K18 Memory Foundation V1 — service + contract tests.
 * The real Supabase persistence/supersession/isolation is proven by the LIVE
 * acceptance (scripts/_k18accept.mjs); these tests cover the service contract,
 * validation, supersession orchestration and bounded retrieval via a faithful
 * in-memory port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService, DEFAULT_RELEVANT_LIMIT, MAX_RELEVANT_LIMIT } from '../src/core/memory/memory.service.ts';
import {
  ACTIVE,
  ARCHIVED,
  SUPERSEDED,
  MemoryFailure,
  type ArchiveInput,
  type MemoryRecord,
  type RecallInput,
  type RelevantMemoryQuery,
  type RememberInput,
  type SupersedeInput,
} from '../src/core/memory/memory.ts';
import type { MemoryStoragePort } from '../src/core/memory/memory.service.ts';

/** Faithful in-memory port mirroring the DB semantics (incl. partial-active unique). */
class FakeMemory implements MemoryStoragePort {
  rows: MemoryRecord[] = [];
  private id = 0;
  private next(partial: {
    projectId: string;
    scope: MemoryRecord['scope'];
    subjectId: string;
    memoryType: string;
    memoryKey: string;
    payload: Record<string, unknown>;
    validFrom?: string;
    provenance?: Partial<MemoryRecord['provenance']>;
  }): MemoryRecord {
    const now = new Date().toISOString();
    return {
      ...partial,
      id: 'm' + ++this.id,
      status: ACTIVE,
      provenance: {
        source: partial.provenance?.source ?? 'application',
        ...(partial.provenance?.detail ? { detail: partial.provenance.detail } : {}),
      },
      createdAt: now,
      updatedAt: now,
    };
  }
  private matches(r: MemoryRecord, q: RecallInput): boolean {
    return r.projectId === q.projectId &&
      (q.scope === undefined || r.scope === q.scope) &&
      (q.subjectId === undefined || r.subjectId === q.subjectId) &&
      (q.memoryType === undefined || r.memoryType === q.memoryType) &&
      (q.memoryKey === undefined || r.memoryKey === q.memoryKey);
  }
  async remember(input: RememberInput): Promise<MemoryRecord> {
    const r = this.next(input);
    this.rows.push(r);
    return r;
  }
  async recallActive(input: RecallInput): Promise<MemoryRecord[]> {
    return this.rows.filter((r) => this.matches(r, input) && r.status === ACTIVE);
  }
  async history(input: RecallInput): Promise<MemoryRecord[]> {
    return this.rows.filter((r) => this.matches(r, input));
  }
  async supersede(input: SupersedeInput): Promise<MemoryRecord> {
    for (const r of this.rows) {
      if (this.matches(r, input) && r.status === ACTIVE) {
        r.status = SUPERSEDED;
        r.updatedAt = new Date().toISOString();
      }
    }
    const fresh = this.next(input);
    this.rows.push(fresh);
    for (const r of this.rows) if (this.matches(r, input) && r.status === SUPERSEDED) r.supersededById = fresh.id;
    return fresh;
  }
  async archive(input: ArchiveInput): Promise<MemoryRecord | null> {
    const r = this.rows.find((x) => x.id === input.memoryId && x.projectId === input.projectId);
    if (!r) return null;
    r.status = ARCHIVED;
    r.updatedAt = new Date().toISOString();
    return r;
  }
  async retrieveRelevant(query: RelevantMemoryQuery): Promise<MemoryRecord[]> {
    let rows = this.rows.filter((r) => r.projectId === query.projectId && r.status === ACTIVE);
    if (query.scope) rows = rows.filter((r) => r.scope === query.scope);
    if (query.subjectId) rows = rows.filter((r) => r.subjectId === query.subjectId);
    if (query.memoryType) rows = rows.filter((r) => r.memoryType === query.memoryType);
    const terms = (query.context ?? '').trim();
    if (terms) {
      const low = terms.toLowerCase();
      rows = rows.filter((r) => low.split(/\s+/).some((t) => r.memoryKey.toLowerCase().includes(t) || JSON.stringify(r.payload).toLowerCase().includes(t)));
    }
    rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rows.slice(0, query.limit ?? DEFAULT_RELEVANT_LIMIT);
  }
}

const svc = new MemoryService(new FakeMemory());
const P = 'p1';

test('remember + recall across all three scopes', async () => {
  await svc.remember({ projectId: P, scope: 'user', subjectId: 'u1', memoryType: 'preference', memoryKey: 'preferred_language', payload: { value: 'Arabic' } });
  await svc.remember({ projectId: P, scope: 'conversation', subjectId: 'c1', memoryType: 'preference', memoryKey: 'output_style', payload: { value: 'concise' } });
  await svc.remember({ projectId: P, scope: 'case', subjectId: 'k1', memoryType: 'state', memoryKey: 'case_status', payload: { value: 'waiting_for_documents' } });
  for (const [scope, subject, key, val] of [
    ['user', 'u1', 'preferred_language', 'Arabic'],
    ['conversation', 'c1', 'output_style', 'concise'],
    ['case', 'k1', 'case_status', 'waiting_for_documents'],
  ] as const) {
    const r = await svc.recall({ projectId: P, scope, subjectId: subject, memoryKey: key });
    assert.equal(r.length, 1);
    assert.equal(r[0].status, ACTIVE);
    assert.equal((r[0].payload as Record<string, unknown>).value, val);
  }
});

test('supersession: 09:00 -> 10:00 -> 11:00 keeps one active, history preserved', async () => {
  const s = svc as unknown as { persistence: FakeMemory };
  const a = await svc.remember({ projectId: P, scope: 'user', subjectId: 'u9', memoryType: 'preference', memoryKey: 'preferred_time', payload: { value: '09:00' } });
  const b = await svc.supersede({ projectId: P, scope: 'user', subjectId: 'u9', memoryType: 'preference', memoryKey: 'preferred_time', payload: { value: '10:00' } });
  const c = await svc.supersede({ projectId: P, scope: 'user', subjectId: 'u9', memoryType: 'preference', memoryKey: 'preferred_time', payload: { value: '11:00' } });

  const active = await svc.recall({ projectId: P, scope: 'user', subjectId: 'u9', memoryKey: 'preferred_time' });
  assert.equal(active.length, 1);
  assert.equal((active[0].payload as Record<string, unknown>).value, '11:00');

  const hist = await svc.history({ projectId: P, scope: 'user', subjectId: 'u9', memoryKey: 'preferred_time' });
  assert.equal(hist.length, 3);
  const statuses = Object.fromEntries(hist.map((r) => [(r.payload as Record<string, unknown>).value, r.status]));
  assert.equal(statuses['09:00'], SUPERSEDED);
  assert.equal(statuses['10:00'], SUPERSEDED);
  assert.equal(statuses['11:00'], ACTIVE);
  assert.equal(s.persistence.rows.filter((r) => r.id === a.id)[0].status, SUPERSEDED);
  assert.equal(s.persistence.rows.filter((r) => r.id === b.id)[0].status, SUPERSEDED);
});

test('archive removes from normal recall, history preserved', async () => {
  const r = await svc.remember({ projectId: P, scope: 'case', subjectId: 'k2', memoryType: 'fact', memoryKey: 'doc', payload: { value: 'x' } });
  const archived = await svc.archive({ projectId: P, memoryId: r.id });
  assert.equal(archived?.status, ARCHIVED);
  const active = await svc.recall({ projectId: P, scope: 'case', subjectId: 'k2' });
  assert.equal(active.length, 0);
  const hist = await svc.history({ projectId: P, scope: 'case', subjectId: 'k2' });
  assert.equal(hist.some((x) => x.id === r.id && x.status === ARCHIVED), true);
});

test('bounded relevant retrieval excludes archived/superseded and prefers active', async () => {
  const P2 = 'p2';
  await svc.remember({ projectId: P2, scope: 'user', subjectId: 'u', memoryType: 'preference', memoryKey: 'a1', payload: { value: 'alpha' } });
  const arch = await svc.remember({ projectId: P2, scope: 'user', subjectId: 'u', memoryType: 'preference', memoryKey: 'a2', payload: { value: 'beta' } });
  await svc.archive({ projectId: P2, memoryId: arch.id });
  await svc.remember({ projectId: P2, scope: 'user', subjectId: 'u', memoryType: 'preference', memoryKey: 'a3', payload: { value: 'gamma' } });
  await svc.supersede({ projectId: P2, scope: 'user', subjectId: 'u', memoryType: 'preference', memoryKey: 'a1', payload: { value: 'ALPHA2' } });

  const rel = await svc.retrieveRelevant({ projectId: P2 });
  const keys = rel.map((r) => r.memoryKey).sort();
  assert.deepEqual(keys, ['a1', 'a3']); // a2 archived, a1 now superseded -> excluded
  assert.equal(rel.length, 2);

  // relevance by term
  const onAlpha = await svc.retrieveRelevant({ projectId: P2, context: 'alpha' });
  assert.deepEqual(onAlpha.map((r) => r.memoryKey), ['a1']);
});

test('bounded limit is clamped to a small default and a hard max', async () => {
  const P3 = 'p3';
  for (let i = 0; i < 30; i++) await svc.remember({ projectId: P3, scope: 'user', subjectId: 'u', memoryType: 'preference', memoryKey: 'k' + i, payload: { i } });
  const dflt = await svc.retrieveRelevant({ projectId: P3 });
  assert.ok(dflt.length <= DEFAULT_RELEVANT_LIMIT);
  const big = await svc.retrieveRelevant({ projectId: P3, limit: 9999 });
  assert.ok(big.length <= MAX_RELEVANT_LIMIT);
});

test('project isolation at the service boundary', async () => {
  const rel = await svc.retrieveRelevant({ projectId: 'other-project' });
  assert.equal(rel.length, 0);
  const recalled = await svc.recall({ projectId: 'other-project', scope: 'user', subjectId: 'u1' });
  assert.equal(recalled.length, 0);
});

test('invalid contract rejected', async () => {
  await assert.rejects(svc.remember({ projectId: P, scope: 'bogus' as never, subjectId: 's', memoryType: 't', memoryKey: 'k', payload: {} }), MemoryFailure);
  await assert.rejects(svc.remember({ projectId: P, scope: 'user', subjectId: '', memoryType: 't', memoryKey: 'k', payload: {} }), MemoryFailure);
  await assert.rejects(svc.remember({ projectId: P, scope: 'user', subjectId: 's', memoryType: '', memoryKey: 'k', payload: {} }), MemoryFailure);
  await assert.rejects(svc.remember({ projectId: P, scope: 'user', subjectId: 's', memoryType: 't', memoryKey: '', payload: {} }), MemoryFailure);
  await assert.rejects(svc.remember({ projectId: P, scope: 'user', subjectId: 's', memoryType: 't', memoryKey: 'k', payload: 'not-object' as never }), MemoryFailure);
});
