// Minimal template renderer (docs/04-security.md section 4: "{{ }} escapes; triple-stash is banned").
//
// Syntax: `{{ path }}` or `{{ a.b }}` and nothing else (no helpers, no conditionals, no logic). Every
// substituted value goes through an escape function chosen by the caller, so there is no way to print
// a variable raw. Anything that is not a plain placeholder is an error rather than being left in the
// output: `{{{ x }}}`, a stray `{{` or `}}`, an unknown variable, a variable that is an object or null.

export type TemplateErrorCode = 'TRIPLE_STASH' | 'SYNTAX' | 'MISSING_VARIABLE' | 'UNSAFE_VARIABLE';

/** Messages carry variable NAMES only, never values (values can be personal data). */
export class TemplateError extends Error {
  constructor(
    readonly code: TemplateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

export type Escape = (value: string) => string;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** For HTML text and attribute values. */
export const escapeHtml: Escape = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');

// U+2028 / U+2029 are built from char codes: a literal one inside a regex ends the line in JavaScript.
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const SUBJECT_UNSAFE = new RegExp(`[\\x00-\\x1f\\x7f\\x85${LINE_SEPARATORS}]+`, 'g');
const TEXT_UNSAFE = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f\\x85${LINE_SEPARATORS}]`, 'g');

/** For the Subject header: no line breaks or other control characters (header injection). */
export const escapeSubject: Escape = (value) => value.replace(SUBJECT_UNSAFE, ' ').trim();

/** For the plain-text part: keeps newlines and tabs, drops other control characters. */
export const escapeText: Escape = (value) => value.replace(TEXT_UNSAFE, '');

function lookup(vars: unknown, path: string): string {
  let current: unknown = vars;
  for (const key of path.split('.')) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TemplateError('UNSAFE_VARIABLE', `Template variable "${path}" is not allowed`);
    }
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
      throw new TemplateError('MISSING_VARIABLE', `Template variable "${path}" is not provided`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === 'string') return current;
  if (typeof current === 'number' || typeof current === 'boolean') return String(current);
  throw new TemplateError(
    'MISSING_VARIABLE',
    `Template variable "${path}" is not a printable value`,
  );
}

/** Render `source`, escaping every substituted value with `escape`. Literal template text is not escaped. */
export function renderTemplate(source: string, vars: unknown, escape: Escape): string {
  if (source.includes('{{{') || source.includes('}}}')) {
    throw new TemplateError('TRIPLE_STASH', 'Triple braces ({{{ }}}) are not allowed in templates');
  }
  let output = '';
  let last = 0;
  for (const match of source.matchAll(PLACEHOLDER)) {
    const literal = source.slice(last, match.index);
    if (literal.includes('{{') || literal.includes('}}')) {
      throw new TemplateError('SYNTAX', 'Unbalanced braces in template');
    }
    const path = (match[1] ?? '').trim();
    if (!PATH.test(path)) {
      throw new TemplateError('SYNTAX', 'A template placeholder must be a plain variable path');
    }
    output += literal + escape(lookup(vars, path));
    last = match.index + match[0].length;
  }
  const tail = source.slice(last);
  if (tail.includes('{{') || tail.includes('}}')) {
    throw new TemplateError('SYNTAX', 'Unbalanced braces in template');
  }
  return output + tail;
}
