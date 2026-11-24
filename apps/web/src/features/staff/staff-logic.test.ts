import { describe, expect, it } from 'vitest';
import { errorMessageKey } from '@/lib/api/error-messages';
import { ApiError } from '@/lib/api/errors';
import { INVITE_MESSAGES, UPDATE_MEMBER_MESSAGES } from './api';
import { inviteVenueScope } from './venue-scope';

describe('staff error messages', () => {
  it('the last-Owner rule (422) gets its own text, other codes the generic one', () => {
    const lastOwner = new ApiError('INVALID_STATE_TRANSITION', 422, 'x');
    expect(errorMessageKey(lastOwner, UPDATE_MEMBER_MESSAGES)).toBe('Staff.errors.lastOwner');
    expect(errorMessageKey(new ApiError('INTERNAL', 500, 'x'), UPDATE_MEMBER_MESSAGES)).toBe(
      'Errors.INTERNAL',
    );
  });

  it('a plan limit and a duplicate invitation are explained on the invite form', () => {
    expect(errorMessageKey(new ApiError('PLAN_LIMIT_REACHED', 402, 'x'), INVITE_MESSAGES)).toBe(
      'Staff.errors.planLimit',
    );
    expect(errorMessageKey(new ApiError('DUPLICATE', 409, 'x'), INVITE_MESSAGES)).toBe(
      'Staff.errors.duplicateInvite',
    );
  });
});

describe("inviteVenueScope: an invitation carries the inviter's own scope", () => {
  it('an inviter with all venues ([]) invites into all venues', () => {
    expect(inviteVenueScope([])).toEqual([]);
  });

  it('an inviter limited to venues A and B invites exactly into A and B, never into "all"', () => {
    expect(inviteVenueScope(['venA', 'venB'])).toEqual(['venA', 'venB']);
    expect(inviteVenueScope(['venA'])).not.toEqual([]);
  });

  it('returns a copy without duplicates', () => {
    const own = ['venA', 'venA', 'venB'];
    const scope = inviteVenueScope(own);
    expect(scope).toEqual(['venA', 'venB']);
    expect(scope).not.toBe(own);
  });
});
