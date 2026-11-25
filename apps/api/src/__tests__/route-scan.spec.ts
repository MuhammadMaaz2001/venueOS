import { Controller, Get, Post } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { isPermission } from '@venueos/shared';
import { describe, expect, it } from 'vitest';
import { AuthenticatedOnly, Public, RequirePermission } from '../common/access/access.decorators';
import { createTestApp } from './helpers/create-test-app';
import { findAccessViolations, scanRoutes } from './helpers/route-scan';

// CLAUDE.md rule 2 / docs/04 section 2: every route is @Public() or @RequirePermission(), and a test
// scans all routes and fails otherwise.

describe('route scan: the application', () => {
  it('every route declares exactly one of @Public(), @AuthenticatedOnly() or @RequirePermission()', async () => {
    // No test controllers: only what the production AppModule registers.
    const { app } = await createTestApp({ controllers: [] });
    try {
      const routes = scanRoutes(app.get(ModulesContainer));
      // Sanity: the scan really sees the application's routes.
      const names = routes.map((r) => `${r.controller}.${r.handler}`);
      expect(names).toEqual(
        expect.arrayContaining([
          'HealthController.check',
          'HealthController.ready',
          'RolesController.list',
          'RolesController.get',
          'RolesController.create',
          'RolesController.update',
          'AuditLogsController.list',
          'AuditLogsController.get',
          'AuthController.login',
          'AuthController.logout',
          'MeController.get',
          'InvitationsController.create',
          'InvitationAcceptController.accept',
          'StaffController.update',
          'VenuesController.create',
          'SpacesController.replaceSlotPrices',
          'SlotTemplatesController.update',
          'EventTypesController.list',
          'TenantSettingsController.update',
        ]),
      );
      expect(findAccessViolations(routes)).toEqual([]);
      for (const r of routes.filter((x) => !x.isPublic && !x.isAuthenticatedOnly)) {
        expect(isPermission(r.permission), `${r.controller}.${r.handler}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});

describe('route scan: the scanner itself', () => {
  @Controller('fixture-ok')
  @Public()
  class PublicClass {
    @Get() a(): void {}
  }

  @Controller('fixture-mixed')
  class Mixed {
    @Get() @Public() open(): void {}
    @Post() @RequirePermission('venue.manage') guarded(): void {}
    @Get('forgotten') forgotten(): void {}
    @Post('both') @Public() @RequirePermission('venue.manage') both(): void {}
    helper(): void {} // not a route: ignored
  }

  @Controller('fixture-auth-only')
  @AuthenticatedOnly()
  class AuthOnlyClass {
    @Get() a(): void {}
  }

  @Controller('fixture-auth-mixed')
  class AuthMixed {
    @Get() @AuthenticatedOnly() ok(): void {}
    @Post() @AuthenticatedOnly() @RequirePermission('venue.manage') withPermission(): void {}
    @Post('pub') @AuthenticatedOnly() @Public() withPublic(): void {}
  }

  @Controller('fixture-class-permission')
  @RequirePermission('customer.view')
  class ClassPermission {
    @Get() a(): void {}
  }

  it('flags a route with neither decorator and a route with both, and accepts class-level ones', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicClass, Mixed, ClassPermission, AuthOnlyClass, AuthMixed],
    }).compile();
    const violations = findAccessViolations(scanRoutes(moduleRef.get(ModulesContainer)));
    expect(violations).toEqual([
      'Mixed.forgotten (GET): none of @Public(), @AuthenticatedOnly(), @RequirePermission()',
      'Mixed.both (POST): more than one of @Public(), @RequirePermission()',
      'AuthMixed.withPermission (POST): more than one of @AuthenticatedOnly(), @RequirePermission()',
      'AuthMixed.withPublic (POST): more than one of @Public(), @AuthenticatedOnly()',
    ]);
    await moduleRef.close();
  });
});
