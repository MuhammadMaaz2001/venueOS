import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClsService } from 'nestjs-cls';
import { EmailOutbox } from '../common/jobs/email-outbox.service';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { EmailProbeController } from './helpers/email-probe.controller';
import { authHeader } from './helpers/test-auth';
import { World } from './helpers/world';
import type { TestTenant } from './helpers/world';

// A job is enqueued in the SAME transaction as the business change (docs/02, request lifecycle).
// The email.send worker itself is covered by the worker's integration tests.

describe('EmailOutbox', () => {
  let t: TestApp;
  let world: World;
  let tenant: TestTenant;
  let other: TestTenant;
  let owner: string;

  beforeAll(async () => {
    world = new World();
    t = await createTestApp({ controllers: [EmailProbeController] });
    tenant = await world.createTenant();
    other = await world.createTenant();
    owner = (await world.addMember(tenant, { role: 'owner' })).userId;
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  const jobs = (tenantId: string) =>
    world.db.tx(
      { tenantId },
      (tx) =>
        tx.$queryRaw<{ name: string; data: Record<string, unknown> }[]>`
        SELECT name, data FROM pgboss.job WHERE data->>'tenantId' = ${tenantId} ORDER BY created_on`,
    );
  const logRows = (tenantId: string, messageKey: string) =>
    world.db.tx({ tenantId }, (tx) => tx.messageLog.findMany({ where: { messageKey } }));

  it('commits the queued message_logs row and the job together; the job carries only tenantId + messageKey', async () => {
    const res = await t
      .http()
      .post('/v1/_email/confirm')
      .set(t.as(authHeader(owner, tenant.id)));
    expect(res.status).toBe(201);
    const { messageKey, jobId } = res.body as { messageKey: string; jobId: string };

    const rows = await logRows(tenant.id, messageKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'queued',
      channel: 'email',
      to: 'guest@example.test',
      template: 'sample.hello',
      locale: 'en',
      event: 'booking.confirmed',
    });
    expect(rows[0]?.templateVars).toEqual({
      name: 'Ali',
      venue: 'Royal Hall',
      booking: { number: 'BK-1' },
    });

    const queued = await jobs(tenant.id);
    expect(queued).toEqual([{ name: 'email.send', data: { tenantId: tenant.id, messageKey } }]);
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(queued)).not.toMatch(/guest@example|Ali|Royal Hall|BK-1/);
  });

  it('a rolled-back business transaction leaves no job and no message_logs row', async () => {
    const before = (await jobs(tenant.id)).length;
    const logsBefore = await world.db.tx({ tenantId: tenant.id }, (tx) => tx.messageLog.count());

    const res = await t
      .http()
      .post('/v1/_email/confirm?fail=1')
      .set(t.as(authHeader(owner, tenant.id)));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');

    expect(await jobs(tenant.id)).toHaveLength(before);
    expect(await world.db.tx({ tenantId: tenant.id }, (tx) => tx.messageLog.count())).toBe(
      logsBefore,
    );
  });

  it('is refused without the permission (403) and for nobody (401), and queues nothing', async () => {
    const viewer = (await world.addMember(tenant, { role: { permissions: ['customer.view'] } }))
      .userId;
    const before = (await jobs(tenant.id)).length;
    expect(
      (
        await t
          .http()
          .post('/v1/_email/confirm')
          .set(t.as(authHeader(viewer, tenant.id)))
      ).status,
    ).toBe(403);
    expect((await t.http().post('/v1/_email/confirm').set(t.csrfHeaders)).status).toBe(401);
    expect(await jobs(tenant.id)).toHaveLength(before);
  });

  it("queues for the caller's tenant only: another tenant's user sees nothing of it (404 for a foreign tenant)", async () => {
    const foreign = (await world.addMember(other, { role: 'owner' })).userId;
    // Calling with a tenant the user is not a member of never reaches the endpoint.
    const res = await t
      .http()
      .post('/v1/_email/confirm')
      .set(t.as(authHeader(foreign, tenant.id)));
    expect([403, 404]).toContain(res.status);
    expect(await jobs(other.id)).toEqual([]);
    expect(await world.db.tx({ tenantId: other.id }, (tx) => tx.messageLog.count())).toBe(0);
  });

  it('refuses invalid input and a missing tenant context before anything is written', async () => {
    const outbox = t.app.get(EmailOutbox);
    const cls = t.app.get(ClsService);
    const before = (await jobs(tenant.id)).length;

    await expect(
      cls.run(() =>
        world.db.tx({ tenantId: tenant.id }, (tx) =>
          outbox.enqueue(tx, { to: 'a@b.test', template: 'sample.hello', locale: 'en' }),
        ),
      ),
    ).rejects.toThrow(/tenant in the request context/);

    await expect(
      cls.run(() => {
        cls.set('tenantId', tenant.id);
        return world.db.tx({ tenantId: tenant.id }, (tx) =>
          outbox.enqueue(tx, { to: 'not-an-address', template: 'sample.hello', locale: 'en' }),
        );
      }),
    ).rejects.toThrow();

    expect(await jobs(tenant.id)).toHaveLength(before);
  });
});
