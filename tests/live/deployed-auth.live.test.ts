import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const publicApiUrl = process.env.KIP_PUBLIC_API_URL?.replace(/\/$/, '');
const enabled = Boolean(supabaseUrl && publishableKey && secretKey && publicApiUrl);

test('deployed auth: two users see only their project and cannot switch project ids', { skip: !enabled }, async () => {
  const admin = createClient(supabaseUrl!, secretKey!);
  const suffix = randomUUID();
  const password = `Kip-${randomUUID()}-Aa1!`;
  const users: string[] = [];
  const projects: string[] = [];

  try {
    const credentials = await Promise.all([0, 1].map(async (index) => {
      const email = `kip-live-${index}-${suffix}@example.com`;
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      assert.ifError(createError);
      assert.ok(created.user);
      users.push(created.user.id);

      const client = createClient(supabaseUrl!, publishableKey!);
      const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
      assert.ifError(signInError);
      assert.ok(signedIn.session?.access_token);
      return { id: created.user.id, token: signedIn.session.access_token };
    }));

    for (let index = 0; index < credentials.length; index += 1) {
      const { data, error } = await admin
        .from('projects')
        .insert({ name: `kip-live-auth-${index}-${suffix}`, status: 'active' })
        .select('id')
        .single();
      assert.ifError(error);
      assert.ok(data?.id);
      projects.push(data.id);

      const { error: membershipError } = await admin
        .from('project_memberships')
        .insert({ project_id: data.id, actor_subject: credentials[index].id, role: 'member' });
      assert.ifError(membershipError);
    }

    for (let index = 0; index < credentials.length; index += 1) {
      const response = await fetch(`${publicApiUrl}/v1/projects`, {
        headers: { authorization: `Bearer ${credentials[index].token}` },
      });
      assert.equal(response.status, 200);
      const body = await response.json() as { ok: boolean; data: Array<{ id: string }> };
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.map((project) => project.id), [projects[index]]);

      const otherProject = projects[index === 0 ? 1 : 0];
      const switched = await fetch(`${publicApiUrl}/v1/projects/${otherProject}/naqaa/cycle-predictions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials[index].token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          lastCycleStart: '2026-11-01',
          typicalBleedingDays: 7,
          typicalCycleDays: 30,
          regularity: 'regular',
          confirmedCycleStarts: ['2026-10-02', '2026-11-01'],
        }),
      });
      assert.equal(switched.status, 403);
    }
  } finally {
    for (const projectId of projects) {
      const { error: membershipDeleteError } = await admin.from('project_memberships').delete().eq('project_id', projectId);
      assert.ifError(membershipDeleteError);
      const { error: projectDeleteError } = await admin.from('projects').delete().eq('id', projectId);
      assert.ifError(projectDeleteError);
    }
    for (const userId of users) {
      const { error: userDeleteError } = await admin.auth.admin.deleteUser(userId);
      assert.ifError(userDeleteError);
    }
  }
});
