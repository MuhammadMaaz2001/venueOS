import { randomUUID } from 'node:crypto';
import { JOB_NAMES } from '@venueos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBossService } from '../queue/pg-boss.service';
import {
  createFixture,
  createTenant,
  eventually,
  jobsOfQueue,
  mailpitMessagesTo,
  messageLog,
  startWorker,
  uniqueRecipient,
} from './helpers/harness';
import type { Fixture, RunningWorker } from './helpers/harness';

// Module 5: the `leads.follow-up` scanner (ids only) and the per-lead `leads.follow-up.notify` job. A due lead's
// assignee is emailed exactly once per follow-up time, the mail arrives in Mailpit, the lead's rev does not move, and
// leads that are not due, closed, unassigned, or of an inactive workspace are left alone.

const HOUR = 3_600_000;
const uid = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

describe('leads follow-up reminders', () => {
  let fx: Fixture;
  let worker: RunningWorker;
  let boss: PgBossService['boss'];
  let tenantId: string;
  let venueId: string;
  let customerId: string;
  let assignee: { membershipId: string; email: string; userId: string };

  const lead = (data: Record<string, unknown> = {}) => {
    const id = uid('lead');
    return fx.tenantDb
      .tx({ tenantId }, (tx) =>
        tx.lead.create({
          data: {
            id,
            tenantId,
            venueId,
            customerId,
            source: 'phone',
            stage: 'CONTACTED',
            assigneeId: assignee.membershipId,
            nextFollowUpAt: new Date(Date.now() - 2 * HOUR),
            ...data,
          },
        }),
      )
      .then((row) => row.id);
  };
  const row = (id: string) =>
    fx.tenantDb.tx({ tenantId }, (tx) => tx.lead.findFirstOrThrow({ where: { id } }));

  const runScan = async () => {
    const jobId = await boss.send(JOB_NAMES.LEADS_FOLLOW_UP, {});
    await eventually(
      async () => {
        const { rows } = await fx.admin.query<{ state: string }>(
          'SELECT state FROM pgboss.job WHERE id = $1',
          [jobId],
        );
        return rows[0] && ['completed', 'failed'].includes(rows[0].state) ? rows[0] : undefined;
      },
      { what: 'the scan to finish' },
    );
  };
  const notifyJobs = (leadId: string) =>
    jobsOfQueue(fx.admin, JOB_NAMES.LEADS_FOLLOW_UP_NOTIFY, { key: 'leadId', value: leadId });
  const mailsOfAssignee = () => mailpitMessagesTo(assignee.email);

  beforeAll(async () => {
    fx = await createFixture();
    tenantId = await createTenant(fx.tenantDb, 'Royal Hall');
    venueId = uid('ven');
    customerId = uid('cus');
    const userId = uid('usr');
    const email = uniqueRecipient();
    const roleId = uid('rol');
    const membershipId = uid('mem');
    await fx.tenantDb.asUser(userId, (tx) =>
      tx.user.create({
        data: { id: userId, name: 'Sara Agent', email, emailVerifiedAt: new Date() },
      }),
    );
    await fx.tenantDb.tx({ tenantId, userId }, async (tx) => {
      await tx.venue.create({ data: { id: venueId, tenantId, name: 'Main Hall', photoKeys: [] } });
      await tx.customer.create({
        data: { id: customerId, tenantId, name: 'Hina <Malik>', phone: '+923001234567' },
      });
      await tx.role.create({
        data: {
          id: roleId,
          tenantId,
          name: 'Agent',
          permissions: ['lead.view', 'lead.manage'],
          limits: {},
        },
      });
      await tx.membership.create({
        data: { id: membershipId, tenantId, userId, roleId, venueIds: [] },
      });
    });
    assignee = { membershipId, email, userId };
    worker = await startWorker();
    boss = worker.get<PgBossService>(PgBossService).boss;
  }, 60_000);
  afterAll(async () => {
    await worker?.stop();
    await fx?.close();
  });

  it('emails the assignee once for a due follow-up, and not again on the next scan', async () => {
    const id = await lead();
    const before = await row(id);

    await runScan();
    const [mail] = await eventually(
      async () => {
        const found = (await mailsOfAssignee()).filter((m) => m.Text.includes('Hina <Malik>'));
        return found.length > 0 ? found : undefined;
      },
      { what: 'the follow-up email in Mailpit' },
    );
    expect(mail?.Subject).toBe('Follow-up due: Hina <Malik>');
    expect(mail?.Text).toContain('Hello Sara Agent');
    expect(mail?.Text).toContain('"Contacted"');
    expect(mail?.Text).toContain(`http://localhost:3000/leads/${id}`);
    expect(mail?.HTML).toContain('Hina &lt;Malik&gt;');
    expect(mail?.From.Name).toBe('Royal Hall');

    // The job payload holds identifiers only.
    const jobs = await notifyJobs(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ tenantId, leadId: id });
    await eventually(async () => (await notifyJobs(id))[0]?.state === 'completed', {
      what: 'the notify job',
    });
    expect((await notifyJobs(id))[0]?.output).toEqual({ result: 'SENT' });

    // Stamped, and the stamp did not touch rev or updated_at.
    const after = await row(id);
    expect(after.followUpNotifiedFor?.getTime()).toBe(after.nextFollowUpAt?.getTime());
    expect(after.rev).toBe(before.rev);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    // The delivery log: queued -> sent (the rows share the message key).
    const [queued] = await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.messageLog.findMany({
        where: { tenantId, entityId: id, template: 'lead.follow-up-due' },
      }),
    );
    expect(queued).toMatchObject({
      status: 'queued',
      event: 'lead.follow_up_due',
      entityType: 'lead',
    });
    const rows = await eventually(
      async () => {
        const r = await messageLog(fx.admin, tenantId, queued?.messageKey as string);
        return r.some((x) => x.status === 'sent') ? r : undefined;
      },
      { what: 'the sent row' },
    );
    expect(rows.map((r) => r.status)).toEqual(['queued', 'sent']);

    // A second scan finds nothing to do for this lead: no new job, no new email.
    await runScan();
    expect(await notifyJobs(id)).toHaveLength(1);
    const again = (await mailsOfAssignee()).filter((m) => m.Text.includes(`/leads/${id}`));
    expect(again).toHaveLength(1);
  });

  it('a new follow-up time is mailed again when it passes', async () => {
    const id = await lead();
    await runScan();
    await eventually(async () => (await notifyJobs(id))[0]?.state === 'completed', {
      what: 'the first notify job',
    });
    // The agent moves the follow-up; it is already past again.
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.lead.updateMany({
        where: { id },
        data: { nextFollowUpAt: new Date(Date.now() - HOUR), followUpNotifiedFor: null },
      }),
    );
    await runScan();
    await eventually(
      async () => {
        const jobs = await notifyJobs(id);
        return jobs.length === 2 && jobs.every((j) => j.state === 'completed');
      },
      { what: 'the second notify job' },
    );
    await eventually(
      async () =>
        (await mailsOfAssignee()).filter((m) => m.Text.includes(`/leads/${id}`)).length === 2,
      { what: 'two emails' },
    );
  });

  it('leaves alone leads that are not due, closed, unassigned, or of a suspended workspace', async () => {
    const future = await lead({ nextFollowUpAt: new Date(Date.now() + 5 * HOUR) });
    const lost = await lead({
      stage: 'LOST',
      lostReason: 'Went elsewhere',
      nextFollowUpAt: null,
    });
    const won = await lead({ stage: 'WON', nextFollowUpAt: null });
    const unassigned = await lead({ assigneeId: null });
    const alreadyNotified = await lead();
    await fx.tenantDb.tx({ tenantId }, async (tx) => {
      const l = await tx.lead.findFirstOrThrow({ where: { id: alreadyNotified } });
      await tx.lead.updateMany({
        where: { id: alreadyNotified },
        data: { followUpNotifiedFor: l.nextFollowUpAt },
      });
    });
    await runScan();
    for (const id of [future, lost, won, unassigned, alreadyNotified]) {
      expect(await notifyJobs(id), id).toEqual([]);
    }

    // A suspended workspace is skipped entirely.
    const suspendedTenant = await createTenant(fx.tenantDb, 'Suspended Hall');
    const susVenue = uid('ven');
    const susCustomer = uid('cus');
    const susLead = uid('lead');
    const susUser = uid('usr');
    const susRole = uid('rol');
    const susMember = uid('mem');
    await fx.tenantDb.asUser(susUser, (tx) =>
      tx.user.create({ data: { id: susUser, name: 'S', email: uniqueRecipient() } }),
    );
    await fx.tenantDb.tx({ tenantId: suspendedTenant, userId: susUser }, async (tx) => {
      await tx.venue.create({
        data: { id: susVenue, tenantId: suspendedTenant, name: 'V', photoKeys: [] },
      });
      await tx.customer.create({
        data: { id: susCustomer, tenantId: suspendedTenant, name: 'C', phone: '+923001234568' },
      });
      await tx.role.create({
        data: { id: susRole, tenantId: suspendedTenant, name: 'R', permissions: [], limits: {} },
      });
      await tx.membership.create({
        data: { id: susMember, tenantId: suspendedTenant, userId: susUser, roleId: susRole },
      });
      await tx.lead.create({
        data: {
          id: susLead,
          tenantId: suspendedTenant,
          venueId: susVenue,
          customerId: susCustomer,
          source: 'phone',
          stage: 'NEW',
          assigneeId: susMember,
          nextFollowUpAt: new Date(Date.now() - HOUR),
        },
      });
      await tx.tenant.update({ where: { id: suspendedTenant }, data: { status: 'SUSPENDED' } });
    });
    await runScan();
    expect(await notifyJobs(susLead)).toEqual([]);
  });

  it('the notify job is idempotent: a duplicate job sends nothing more, an inactive assignee gets nothing', async () => {
    const id = await lead();
    const send = (leadId: string, key: string) =>
      boss.send(JOB_NAMES.LEADS_FOLLOW_UP_NOTIFY, { tenantId, leadId }, { singletonKey: key });
    await send(id, `dup-a:${id}`);
    await eventually(async () => (await notifyJobs(id))[0]?.state === 'completed', {
      what: 'the first job',
    });
    await send(id, `dup-b:${id}`);
    await eventually(
      async () => {
        const jobs = await notifyJobs(id);
        return jobs.length === 2 && jobs.every((j) => j.state === 'completed');
      },
      { what: 'the duplicate job' },
    );
    const jobs = await notifyJobs(id);
    expect(jobs.map((j) => j.output)).toEqual([{ result: 'SENT' }, { result: 'ALREADY_SENT' }]);
    expect((await mailsOfAssignee()).filter((m) => m.Text.includes(`/leads/${id}`))).toHaveLength(
      1,
    );

    // A job for a lead that is not due (or has no assignee) does nothing either.
    const future = await lead({ nextFollowUpAt: new Date(Date.now() + 5 * HOUR) });
    await send(future, `f:${future}`);
    await eventually(async () => (await notifyJobs(future))[0]?.state === 'completed', {
      what: 'the not-due job',
    });
    expect((await notifyJobs(future))[0]?.output).toEqual({ result: 'NOT_DUE' });

    // An assignee who was deactivated cannot be emailed: the follow-up is marked handled, not retried forever.
    const gone = await lead();
    await fx.tenantDb.tx({ tenantId }, (tx) =>
      tx.membership.updateMany({ where: { id: assignee.membershipId }, data: { active: false } }),
    );
    try {
      await send(gone, `g:${gone}`);
      await eventually(async () => (await notifyJobs(gone))[0]?.state === 'completed', {
        what: 'the no-recipient job',
      });
      expect((await notifyJobs(gone))[0]?.output).toEqual({ result: 'NO_RECIPIENT' });
      expect((await row(gone)).followUpNotifiedFor).not.toBeNull();
    } finally {
      await fx.tenantDb.tx({ tenantId }, (tx) =>
        tx.membership.updateMany({ where: { id: assignee.membershipId }, data: { active: true } }),
      );
    }
  });

  it('logs no customer data', () => {
    const logs = worker.rawLogs();
    expect(logs).not.toContain('Hina');
    expect(logs).not.toContain(assignee.email);
  });
});
