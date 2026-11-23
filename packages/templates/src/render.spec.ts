import { describe, expect, it } from 'vitest';
import { TemplateError, escapeHtml, escapeSubject, escapeText, renderTemplate } from './render.js';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof TemplateError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

describe('renderTemplate', () => {
  it('substitutes plain and nested variables, trimming spaces inside the braces', () => {
    expect(
      renderTemplate(
        'Hi {{name}}, {{ booking.number }} for {{booking.guests}}',
        {
          name: 'Ali',
          booking: { number: 'BK-1', guests: 250 },
        },
        escapeText,
      ),
    ).toBe('Hi Ali, BK-1 for 250');
  });

  it('HTML-escapes every value and leaves literal markup alone', () => {
    const out = renderTemplate(
      '<p>{{ name }}</p>',
      { name: `<script>alert("x")</script> & 'q' \`t\`` },
      escapeHtml,
    );
    expect(out).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &#96;t&#96;</p>',
    );
    expect(out).not.toContain('<script>');
  });

  it('does not re-interpret placeholders that appear inside a value', () => {
    expect(renderTemplate('{{ a }}', { a: '{{ b }}', b: 'secret' }, escapeHtml)).toBe('{{ b }}');
  });

  it('strips CR/LF and other control characters from the subject', () => {
    const subject = renderTemplate(
      'Re: {{ s }}',
      { s: 'Hi\r\nBcc: evil@example.test\u0000' },
      escapeSubject,
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).not.toContain(String.fromCharCode(0));
    expect(subject).toBe('Re: Hi Bcc: evil@example.test');
  });

  it('keeps newlines in text but drops other control characters', () => {
    expect(renderTemplate('{{ s }}', { s: 'a\nb\u0007c' }, escapeText)).toBe('a\nbc');
  });

  it('refuses triple-stash', () => {
    expect(code(() => renderTemplate('{{{ name }}}', { name: '<b>' }, escapeHtml))).toBe(
      'TRIPLE_STASH',
    );
    expect(code(() => renderTemplate('x }}} y', {}, escapeHtml))).toBe('TRIPLE_STASH');
  });

  it('refuses anything that is not a plain variable path', () => {
    for (const source of [
      '{{ a b }}',
      '{{ a() }}',
      '{{ #if a }}',
      '{{ }}',
      '{{ a-b }}',
      '{{ 1a }}',
    ]) {
      expect(
        code(() => renderTemplate(source, { a: 1 }, escapeHtml)),
        source,
      ).toBe('SYNTAX');
    }
  });

  it('refuses unbalanced braces instead of printing them', () => {
    expect(code(() => renderTemplate('hello {{ a', { a: 1 }, escapeHtml))).toBe('SYNTAX');
    expect(code(() => renderTemplate('hello }} a', { a: 1 }, escapeHtml))).toBe('SYNTAX');
  });

  it('throws on an unknown, null, or object variable (never prints blanks)', () => {
    expect(code(() => renderTemplate('{{ nope }}', {}, escapeHtml))).toBe('MISSING_VARIABLE');
    expect(code(() => renderTemplate('{{ a.b }}', { a: {} }, escapeHtml))).toBe('MISSING_VARIABLE');
    expect(code(() => renderTemplate('{{ a }}', { a: null }, escapeHtml))).toBe('MISSING_VARIABLE');
    expect(code(() => renderTemplate('{{ a }}', { a: { b: 1 } }, escapeHtml))).toBe(
      'MISSING_VARIABLE',
    );
  });

  it('blocks prototype access', () => {
    for (const source of [
      '{{ __proto__ }}',
      '{{ constructor }}',
      '{{ a.constructor }}',
      '{{ a.prototype }}',
    ]) {
      expect(
        code(() => renderTemplate(source, { a: {} }, escapeHtml)),
        source,
      ).toBe('UNSAFE_VARIABLE');
    }
    // inherited members are not variables either
    expect(code(() => renderTemplate('{{ toString }}', {}, escapeHtml))).toBe('MISSING_VARIABLE');
  });

  it('never puts values into error messages', () => {
    try {
      renderTemplate('{{ a.b }}', { a: { b: { secret: 'hunter2' } } }, escapeHtml);
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });
});
