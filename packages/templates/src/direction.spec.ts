import { describe, expect, it } from 'vitest';
import { textDirection } from './direction.js';

describe('textDirection', () => {
  it('is left-to-right for English and unknown languages', () => {
    expect(textDirection('en')).toBe('ltr');
    expect(textDirection('en-GB')).toBe('ltr');
    expect(textDirection('xx')).toBe('ltr');
  });

  it('is right-to-left for Arabic (planned) and the other right-to-left languages, region or not', () => {
    expect(textDirection('ar')).toBe('rtl');
    expect(textDirection('AR-AE')).toBe('rtl');
    expect(textDirection('he')).toBe('rtl');
  });
});
