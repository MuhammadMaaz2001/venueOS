import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { mapDatabaseError } from '../common/errors/db-errors';
import { ForbiddenError, SlotTakenError } from '../common/errors/domain-errors';
import { toErrorResponse } from '../common/errors/to-error-response';
import { resolveRequestId } from '../common/request-id/request-id';

describe('toErrorResponse', () => {
  it('maps domain errors to their status and code', () => {
    expect(toErrorResponse(new ForbiddenError())).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(toErrorResponse(new SlotTakenError('Hall A is taken', { spaceId: 's1' }))).toMatchObject(
      {
        status: 409,
        code: 'SLOT_TAKEN',
        details: { spaceId: 's1' },
      },
    );
  });

  it('maps framework exceptions to fixed safe messages', () => {
    expect(toErrorResponse(new NotFoundException('Cannot GET /secret/path'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
    });
    expect(toErrorResponse(new ForbiddenException('internal reason'))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(toErrorResponse(new BadRequestException('x'))).toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
    expect(toErrorResponse(new ThrottlerException())).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('maps body-parser style errors by status', () => {
    expect(toErrorResponse({ status: 413, type: 'entity.too.large' })).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(toErrorResponse({ statusCode: 400, type: 'entity.parse.failed' })).toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('answers anything unknown with a generic 500 and flags it as unexpected', () => {
    const mapped = toErrorResponse(new Error('connect ECONNREFUSED postgresql://u:pw@host/db'));
    expect(mapped).toMatchObject({ status: 500, code: 'INTERNAL', unexpected: true });
    expect(JSON.stringify(mapped)).not.toContain('ECONNREFUSED');
    expect(toErrorResponse('a string')).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(toErrorResponse(undefined)).toMatchObject({ status: 500, code: 'INTERNAL' });
  });
});

describe('mapDatabaseError', () => {
  it('recognises the exclusion violation however the driver layers wrap it', () => {
    const viaCause = Object.assign(new Error('wrapper'), {
      cause: { code: '23P01', constraint: 'space_occupancies_no_overlap' },
    });
    const viaMeta = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { code: '23P01', message: 'exclusion constraint "space_occupancies_no_overlap"' },
    });
    const viaMessage = new Error(
      'conflicting key value violates exclusion constraint "space_occupancies_no_overlap"',
    );
    // Captured from a real PrismaClientKnownRequestError (Prisma 7.10 + pg adapter) raised by an
    // exclusion constraint of this name on the local Postgres.
    const realPrisma7 = Object.assign(new Error('Raw query failed. Code: `23P01`.'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          message:
            'conflicting key value violates exclusion constraint "space_occupancies_no_overlap"',
          cause: {
            originalCode: '23P01',
            kind: 'postgres',
            code: '23P01',
            message:
              'conflicting key value violates exclusion constraint "space_occupancies_no_overlap"',
            detail: 'Key (r)=([5,15)) conflicts with existing key (r)=([1,10)).',
          },
        },
      },
    });
    for (const error of [viaCause, viaMeta, viaMessage, realPrisma7]) {
      expect(mapDatabaseError(error)).toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
    }
  });

  it('ignores other constraints and other errors', () => {
    expect(mapDatabaseError({ code: '23P01', constraint: 'some_other_exclusion' })).toBeUndefined();
    expect(mapDatabaseError({ code: '23505', constraint: 'bookings_number_key' })).toBeUndefined();
    expect(mapDatabaseError(new Error('boom'))).toBeUndefined();
    expect(mapDatabaseError(null)).toBeUndefined();
  });
});

describe('resolveRequestId', () => {
  it('keeps a safe client id and replaces everything else', () => {
    expect(resolveRequestId('req-abc12345')).toBe('req-abc12345');
    expect(resolveRequestId(['first-id-1234', 'second'])).toBe('first-id-1234');
    for (const bad of [
      undefined,
      '',
      'short',
      'has space in it',
      'new\nline-injection',
      'x'.repeat(65),
    ]) {
      expect(resolveRequestId(bad)).toMatch(/^req_[0-9a-f-]{36}$/);
    }
  });
});
