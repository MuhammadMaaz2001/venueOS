import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TemplateError } from '../render.js';
import { BUNDLED_FONT_FILES, pdfFontFaceCss } from './fonts.js';
import { UnknownPdfTemplateError, hasPdfTemplate, renderPdfHtml } from './render-pdf-html.js';

const vars = { tenantName: 'Royal Hall', reference: 'ent_1', issuedOn: '2026-11-25' };

describe('renderPdfHtml', () => {
  it('renders the sample as a self-contained document with Urdu and English', () => {
    expect(hasPdfTemplate('sample')).toBe(true);
    const out = renderPdfHtml('sample', 'en', vars);
    expect(out).toMatchObject({ lang: 'en', dir: 'ltr' });
    expect(out.html).toContain('<html lang="en" dir="ltr">');
    expect(out.html).toContain('Royal Hall');
    expect(out.html).toContain('نمونہ دستاویز');
    expect(out.html).toContain('PKR 150,000.00');
  });

  it('sets rtl for Urdu and falls back to English for a malformed locale', () => {
    expect(renderPdfHtml('sample', 'ur-PK', vars)).toMatchObject({ lang: 'ur', dir: 'rtl' });
    expect(renderPdfHtml('sample', '"><x', vars)).toMatchObject({ lang: 'en', dir: 'ltr' });
  });

  it('escapes every variable', () => {
    const hostile = {
      ...vars,
      tenantName: '<script>alert(1)</script> & "q"',
      reference: '<img src=x>',
    };
    const { html } = renderPdfHtml('sample', 'en', hostile);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;');
  });

  it('references nothing outside the document: no scripts, no URLs except data:', () => {
    const { html } = renderPdfHtml('sample', 'ur', vars);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/url\((?!data:)/i);
    expect(html).toContain("default-src 'none'");
  });

  it('rejects an unknown template and a missing variable', () => {
    expect(() => renderPdfHtml('nope', 'en', vars)).toThrow(UnknownPdfTemplateError);
    expect(() => renderPdfHtml('sample', 'en', { tenantName: 'x' })).toThrow(TemplateError);
    expect(() => renderPdfHtml('__proto__', 'en', vars)).toThrow(UnknownPdfTemplateError);
  });
});

describe('bundled fonts', () => {
  const dir = path.join(__dirname, '..', '..', 'fonts');

  it('has every font file and an OFL licence for each family', () => {
    for (const file of BUNDLED_FONT_FILES)
      expect(existsSync(path.join(dir, file)), file).toBe(true);
    const files = readdirSync(dir);
    for (const licence of [
      'OFL-noto-sans.txt',
      'OFL-noto-naskh-arabic.txt',
      'OFL-noto-nastaliq-urdu.txt',
      'NOTICE.md',
    ]) {
      expect(files).toContain(licence);
    }
  });

  it('inlines the fonts as data: URLs', () => {
    const css = pdfFontFaceCss();
    expect(css.match(/@font-face/g)).toHaveLength(BUNDLED_FONT_FILES.length);
    expect(css).toContain('Noto Nastaliq Urdu');
    expect(css).not.toMatch(/url\((?!data:)/);
  });
});
