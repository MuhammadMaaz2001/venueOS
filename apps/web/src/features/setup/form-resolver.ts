'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { FieldErrors, FieldValues, Path, Resolver, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { isApiError } from '@/lib/api/errors';
import { issueText, serverFieldMessages } from '@/lib/validation';

export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * react-hook-form resolver for forms whose boxes hold TEXT (a number box gives "500", an empty one ""): the values
 * are turned into the API payload by `toPayload`, then checked by the very schema of `@venueos/shared` the API
 * uses. Each problem is shown under the box named by the first segment of its path, in the page's language (the
 * schema's English text is never shown).
 */
export function useSharedSchemaResolver<Values extends FieldValues>(
  schema: z.ZodType,
  toPayload: (values: Values) => unknown,
): Resolver<Values> {
  const t = useTranslations('Validation');
  return useMemo<Resolver<Values>>(
    () => (values) => {
      const parsed = schema.safeParse(toPayload(values));
      if (parsed.success) return { values, errors: {} };
      const errors: Record<string, { type: string; message: string }> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (!field || field in errors) continue;
        errors[field] = {
          type: issue.code,
          message: issueText(t as Translate, issue as Parameters<typeof issueText>[1]),
        };
      }
      return { values: {}, errors: errors as FieldErrors<Values> };
    },
    [schema, toPayload, t],
  );
}

/** '' (an empty box) as `undefined`, otherwise the trimmed text. */
export function textOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** '' as `null` (clear the value on an edit), otherwise the trimmed text. */
export function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A whole number from a text box; '' is `undefined`, garbage becomes NaN (and fails the schema). */
export function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

/** A whole number from a text box for an edit: '' clears (`null`), garbage becomes NaN. */
export function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** Put the field problems of a 400 from the API under their boxes (other failures were toasted globally). */
export function showServerFieldErrors<Values extends FieldValues>(
  form: UseFormReturn<Values>,
  t: Translate,
  error: unknown,
): void {
  if (!isApiError(error)) return;
  for (const [field, message] of Object.entries(serverFieldMessages(t, error))) {
    form.setError(field as Path<Values>, { type: 'server', message });
  }
}
