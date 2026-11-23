import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthContextProvider } from '../common/access/auth-context.provider';
import { SessionAuthContextProvider } from '../modules/auth/session-auth-context.provider';
import { createTestApp } from './helpers/create-test-app';
import type { TestApp } from './helpers/create-test-app';
import { TEST_AUTH_HEADER, TestAuthContextProvider, authHeader } from './helpers/test-auth';
import { World } from './helpers/world';

// The test identity stub must never exist in the application: no header may authenticate a real request.

describe('the test auth stub is test-only', () => {
  let t: TestApp;
  let world: World;
  beforeAll(async () => {
    world = new World();
    t = await createTestApp({ realAuth: true }); // the production AppModule, nothing overridden
  });
  afterAll(async () => {
    await t.app.close();
    await world.close();
  });

  it('the production AppModule registers the session provider, not the stub', () => {
    const provider = t.app.get(AuthContextProvider);
    expect(provider).toBeInstanceOf(SessionAuthContextProvider);
    expect(provider).not.toBeInstanceOf(TestAuthContextProvider);
  });

  it('a perfectly valid test identity header authenticates nothing (401 on every method)', async () => {
    const tenant = await world.createTenant();
    const owner = await world.addMember(tenant, { role: 'owner' });
    const headers = t.as(authHeader(owner.userId, tenant.id));

    for (const send of [
      () => t.http().get('/v1/roles').set(headers),
      () => t.http().get(`/v1/roles/${tenant.roles.owner}`).set(headers),
      () =>
        t
          .http()
          .post('/v1/roles')
          .set(headers)
          .send({ name: 'x', copyFromRoleId: tenant.roles.owner }),
      () =>
        t.http().patch(`/v1/roles/${tenant.roles.owner}`).set(headers).send({ rev: 1, name: 'x' }),
    ]) {
      const res = await send();
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(
      (await t.http().get('/v1/roles').set(headers).set('Authorization', 'Bearer anything')).status,
    ).toBe(401);
  });

  it('no application source file (outside __tests__) mentions the stub or its header', () => {
    const srcDir = path.resolve(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8').toLowerCase();
          if (text.includes(TEST_AUTH_HEADER) || text.includes('testauthcontextprovider')) {
            offenders.push(path.relative(srcDir, full));
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
