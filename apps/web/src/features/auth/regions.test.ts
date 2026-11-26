import { PHONE_COUNTRIES } from '@venueos/shared';
import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, COUNTRY_DEFAULTS } from './regions';

// A country offered at signup becomes the workspace country, and phone numbers typed the national way are read with
// it: every one of them must be in the phone table (otherwise "0300 1234567" would be refused as "needs a country code").
describe('signup countries and phone numbers', () => {
  it('every country offered at signup can type national phone numbers', () => {
    const missing = COUNTRY_CODES.filter((c) => !PHONE_COUNTRIES.includes(c));
    expect(missing).toEqual([]);
  });

  it('every country with signup defaults is offered', () => {
    for (const code of Object.keys(COUNTRY_DEFAULTS)) expect(COUNTRY_CODES).toContain(code);
  });
});
