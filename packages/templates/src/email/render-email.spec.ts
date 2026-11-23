import { describe, expect, it } from 'vitest';
import { TemplateError } from '../render.js';
import { UnknownTemplateError, hasEmailTemplate, renderEmail } from './render-email.js';

const vars = { name: 'Ali', venue: 'Royal Hall', booking: { number: 'BK-2027-0001' } };

describe('renderEmail', () => {
  it('renders subject, html document and text for the sample template', () => {
    const mail = renderEmail('sample.hello', 'en', vars);
    expect(mail.locale).toBe('en');
    expect(mail.subject).toBe('Hello Ali, your booking BK-2027-0001');
    expect(mail.text).toContain('Your booking BK-2027-0001 at Royal Hall is confirmed.');
    expect(mail.html).toMatch(/^<!doctype html><html lang="en" dir="ltr">/);
    expect(mail.html).toContain('<strong>BK-2027-0001</strong>');
    expect(mail.html).toContain('<title>Hello Ali, your booking BK-2027-0001</title>');
  });

  it('escapes variables in every part of the message', () => {
    const evil = {
      name: '<img src=x onerror=alert(1)>\r\nBcc: x@y.test',
      venue: '"><b>',
      booking: { number: '&' },
    };
    const mail = renderEmail('sample.hello', 'en', evil);
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(mail.html).toContain('&amp;');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('uses the Urdu version right-to-left, and falls back to English', () => {
    const ur = renderEmail('sample.hello', 'ur', vars);
    expect(ur.locale).toBe('ur');
    expect(ur.html).toContain('lang="ur" dir="rtl"');
    expect(renderEmail('sample.hello', 'ur-PK', vars).locale).toBe('ur');
    expect(renderEmail('sample.hello', 'fr', vars).locale).toBe('en');
    expect(renderEmail('sample.hello', 'EN', vars).locale).toBe('en');
  });

  it('throws UnknownTemplateError for an unknown template or an unusable locale string', () => {
    expect(hasEmailTemplate('sample.hello')).toBe(true);
    expect(hasEmailTemplate('nope')).toBe(false);
    expect(hasEmailTemplate('__proto__')).toBe(false);
    expect(() => renderEmail('nope', 'en', vars)).toThrow(UnknownTemplateError);
    expect(() => renderEmail('toString', 'en', vars)).toThrow(UnknownTemplateError);
    expect(() => renderEmail('sample.hello', '"><x', vars)).toThrow(UnknownTemplateError);
  });

  it('throws TemplateError (not UnknownTemplateError) for a missing variable', () => {
    expect(() => renderEmail('sample.hello', 'en', { name: 'Ali' })).toThrow(TemplateError);
  });
});
