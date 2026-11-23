import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ErrorResponseSchema } from './errors.js';
import { HealthResponseSchema, ReadyResponseSchema } from './schemas/health.js';

describe('error format', () => {
  it('accepts the docs/06 shape', () => {
    const body = {
      error: {
        code: 'SLOT_TAKEN',
        message: 'Hall A is already booked for this time.',
        details: { spaceId: 'clx1' },
        requestId: 'req_1',
      },
    };
    expect(ErrorResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects unknown codes and a missing requestId', () => {
    expect(() =>
      ErrorResponseSchema.parse({ error: { code: 'NOPE', message: 'x', requestId: 'r' } }),
    ).toThrow();
    expect(() =>
      ErrorResponseSchema.parse({ error: { code: 'INTERNAL', message: 'x' } }),
    ).toThrow();
  });

  it('has no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('health schemas', () => {
  it('parse the endpoint bodies', () => {
    expect(HealthResponseSchema.parse({ status: 'ok' })).toEqual({ status: 'ok' });
    expect(
      ReadyResponseSchema.parse({
        status: 'unavailable',
        checks: { database: 'down', queue: 'down' },
      }),
    ).toEqual({
      status: 'unavailable',
      checks: { database: 'down', queue: 'down' },
    });
  });
});
