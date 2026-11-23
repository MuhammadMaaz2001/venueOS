// Seed: platform plans (always) and one demo tenant with a venue, spaces, slots and an owner.
//
//   pnpm db:seed          (safe to run any number of times)
//
// Runs as venueos_migrator (MIGRATE_DATABASE_URL), which is subject to forced RLS like every other
// role: tenant rows are written inside a transaction that sets app.tenant_id / app.user_id first.
//
// Rules:
//  - Idempotent: fixed ids + upsert with `update: {}`, so a re-run never overwrites later edits
//    (for example the permissions P0-5 puts on the Owner role).
//  - NODE_ENV=production seeds the plans only. No demo tenant, no demo owner, ever.
//  - The demo owner's credentials come from SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD (packages/db/.env).
//    No default password exists in the code. If either is missing the seed refuses (exit 1) before
//    touching the database.
//  - No roles/permissions here except one placeholder Owner role so the owner membership can exist
//    (memberships.role_id is NOT NULL). P0-5 must UPDATE that role by its fixed id (SEED_IDS.ownerRole),
//    not create a second one.

import 'dotenv/config';
import { randomBytes, argon2Sync } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/** Fixed ids so the seed can find its own rows again, and P0-5 can find the Owner role. */
const SEED_IDS = {
  tenant: 'seed_tenant_demo',
  owner: 'seed_user_owner',
  ownerRole: 'seed_role_owner',
  ownerMembership: 'seed_membership_owner',
  subscription: 'seed_subscription_demo',
  venue: 'seed_venue_main',
  hallA: 'seed_space_hall_a',
  hallB: 'seed_space_hall_b',
  hallAB: 'seed_space_hall_ab',
  lawn: 'seed_space_lawn',
  slotLunch: 'seed_slot_lunch',
  slotDinner: 'seed_slot_dinner',
} as const;

const PLANS = [
  {
    code: 'starter',
    name: 'Starter',
    entitlements: { maxVenues: 1, maxSpaces: 3, maxUsers: 5, emailsPerMonth: 2000, customDomain: false },
    priceMonthly: '9900',
    priceYearly: '99000',
  },
  {
    code: 'growth',
    name: 'Growth',
    entitlements: { maxVenues: 3, maxSpaces: 15, maxUsers: 20, emailsPerMonth: 10000, customDomain: true },
    priceMonthly: '24900',
    priceYearly: '249000',
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    entitlements: { maxVenues: 50, maxSpaces: 500, maxUsers: 200, emailsPerMonth: 100000, customDomain: true },
    priceMonthly: '59900',
    priceYearly: '599000',
  },
] as const;

/** argon2id, PHC string format ($argon2id$v=19$m=...,t=...,p=...$salt$hash), OWASP-recommended cost. */
function hashPassword(password: string): string {
  const memory = 65_536; // KiB
  const passes = 3;
  const parallelism = 4;
  const salt = randomBytes(16);
  const hash = argon2Sync('argon2id', {
    message: password,
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength: 32,
  });
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(hash)}`;
}

type OwnerConfig = { email: string; password: string };

/** Returns the owner credentials, or null when the demo tenant must not be seeded (production). */
function readOwnerConfig(env: NodeJS.ProcessEnv): OwnerConfig | null {
  if (env.NODE_ENV === 'production') return null;
  const email = env.SEED_OWNER_EMAIL?.trim();
  const password = env.SEED_OWNER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Refusing to seed the demo owner: set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD in packages/db/.env ' +
        '(see .env.example). To seed only the plans, run with NODE_ENV=production.',
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('SEED_OWNER_EMAIL is not a valid email address');
  }
  if (password.length < 12) {
    throw new Error('SEED_OWNER_PASSWORD must be at least 12 characters');
  }
  return { email, password };
}

async function seedPlans(prisma: PrismaClient) {
  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      create: { ...p, currency: 'PKR', isPublic: true },
      update: {},
    });
  }
}

async function seedDemoTenant(prisma: PrismaClient, owner: OwnerConfig) {
  const passwordHash = hashPassword(owner.password);
  const starter = await prisma.plan.findUniqueOrThrow({ where: { code: 'starter' } });
  const now = new Date();

  await prisma.$transaction(
    async (tx) => {
      // Same context TenantDb sets. user_id is the owner so the `users` policy lets us insert that row.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${SEED_IDS.tenant}, true), set_config('app.user_id', ${SEED_IDS.owner}, true)`;

      await tx.tenant.upsert({
        where: { id: SEED_IDS.tenant },
        create: {
          id: SEED_IDS.tenant,
          slug: 'demo',
          name: 'Demo Banquets',
          country: 'PK',
          currency: 'PKR',
          timezone: 'Asia/Karachi',
          status: 'ACTIVE',
          settings: {},
        },
        update: {},
      });

      await tx.subscription.upsert({
        where: { id: SEED_IDS.subscription },
        create: {
          id: SEED_IDS.subscription,
          tenantId: SEED_IDS.tenant,
          planId: starter.id,
          status: 'active',
          billingCycle: 'monthly',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 3600 * 1000),
        },
        update: {},
      });

      await tx.user.upsert({
        where: { id: SEED_IDS.owner },
        create: {
          id: SEED_IDS.owner,
          email: owner.email,
          name: 'Demo Owner',
          emailVerifiedAt: now,
        },
        update: {},
      });
      // user_credentials has no RLS and is owned by the migrator, so it can be written here. Created
      // once; a re-run never resets a password the owner changed.
      await tx.userCredential.upsert({
        where: { userId: SEED_IDS.owner },
        create: { userId: SEED_IDS.owner, passwordHash },
        update: {},
      });

      // Placeholder role: P0-5 UPDATEs it (by this id) with the real permission set.
      await tx.role.upsert({
        where: { id: SEED_IDS.ownerRole },
        create: {
          id: SEED_IDS.ownerRole,
          tenantId: SEED_IDS.tenant,
          name: 'Owner',
          permissions: [],
          isSystem: true,
        },
        update: {},
      });
      await tx.membership.upsert({
        where: { id: SEED_IDS.ownerMembership },
        create: {
          id: SEED_IDS.ownerMembership,
          tenantId: SEED_IDS.tenant,
          userId: SEED_IDS.owner,
          roleId: SEED_IDS.ownerRole,
          venueIds: [],
        },
        update: {},
      });

      await tx.venue.upsert({
        where: { id: SEED_IDS.venue },
        create: {
          id: SEED_IDS.venue,
          tenantId: SEED_IDS.tenant,
          name: 'Royal Banquet Hall',
          address: 'Main Boulevard, Gulberg',
          city: 'Lahore',
          photoKeys: [],
        },
        update: {},
      });

      const spaces = [
        { id: SEED_IDS.hallA, name: 'Hall A', kind: 'HALL', capacitySeated: 300, baseRent: '150000' },
        { id: SEED_IDS.hallB, name: 'Hall B', kind: 'HALL', capacitySeated: 200, baseRent: '100000' },
        { id: SEED_IDS.lawn, name: 'Lawn', kind: 'LAWN', capacitySeated: 500, baseRent: '200000' },
        {
          id: SEED_IDS.hallAB,
          name: 'Hall A+B',
          kind: 'HALL',
          capacitySeated: 500,
          baseRent: '240000',
          isCombined: true,
        },
      ] as const;
      for (const s of spaces) {
        await tx.space.upsert({
          where: { id: s.id },
          create: { ...s, tenantId: SEED_IDS.tenant, venueId: SEED_IDS.venue },
          update: {},
        });
      }
      // A combined space is made of physical spaces of the same venue (trigger-checked).
      for (const componentSpaceId of [SEED_IDS.hallA, SEED_IDS.hallB]) {
        await tx.spaceComponent.upsert({
          where: {
            combinedSpaceId_componentSpaceId: { combinedSpaceId: SEED_IDS.hallAB, componentSpaceId },
          },
          create: { tenantId: SEED_IDS.tenant, combinedSpaceId: SEED_IDS.hallAB, componentSpaceId },
          update: {},
        });
      }

      const slots = [
        { id: SEED_IDS.slotLunch, name: 'Lunch', startTime: '12:00', endTime: '16:00' },
        { id: SEED_IDS.slotDinner, name: 'Dinner', startTime: '19:00', endTime: '23:30' },
      ];
      for (const slot of slots) {
        await tx.slotTemplate.upsert({
          where: { id: slot.id },
          create: {
            ...slot,
            tenantId: SEED_IDS.tenant,
            venueId: SEED_IDS.venue,
            mode: 'FIXED',
            daysOfWeek: [],
          },
          update: {},
        });
      }
    },
    { timeout: 30_000 },
  );
}

async function main() {
  const owner = readOwnerConfig(process.env); // validate before touching the database
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL is not set (packages/db/.env)');

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await seedPlans(prisma);
    console.log(`seed: ${PLANS.length} plans ready`);
    if (owner) {
      await seedDemoTenant(prisma, owner);
      console.log(`seed: demo tenant "${SEED_IDS.tenant}" ready (owner ${owner.email})`);
    } else {
      console.log('seed: NODE_ENV=production, demo tenant and owner skipped');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
