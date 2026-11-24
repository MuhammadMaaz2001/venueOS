'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import type { ApiError } from './api/errors';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The parts of a Zod issue the form messages depend on (Zod's own English text is never shown). */
interface IssueLike {
  code?: string;
  origin?: string;
  format?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
}

/** Translated text for one Zod issue, from the `Validation` namespace. */
export function issueText(t: Translate, issue: IssueLike): string {
  const minimum = issue.minimum === undefined ? undefined : Number(issue.minimum);
  const maximum = issue.maximum === undefined ? undefined : Number(issue.maximum);
  switch (issue.code) {
    case 'invalid_type':
      return t('required');
    case 'too_small':
      return minimum !== undefined && minimum > 1 ? t('tooShort', { min: minimum }) : t('required');
    case 'too_big':
      return t('tooLong', { max: maximum ?? 0 });
    case 'invalid_format':
      return issue.format === 'email' ? t('email') : t('invalid');
    default:
      return t('invalid');
  }
}

/**
 * `zodResolver` for a schema of `@venueos/shared`, with the messages translated into the current language
 * (the language of the page). Explicit messages written inside a schema stay as they are.
 */
export function useZodResolver<Input extends FieldValues, Output>(
  schema: z.ZodType<Output, Input>,
): Resolver<Input, unknown, Output> {
  const t = useTranslations('Validation');
  return useMemo(
    () =>
      zodResolver(schema, {
        error: (issue) => issueText(t as Translate, issue as IssueLike),
      }) as Resolver<Input, unknown, Output>,
    [schema, t],
  );
}

/**
 * Field messages for a 400 `VALIDATION_ERROR` of the API: `path` is the field name. The API's English text is
 * not shown, except that the one rule a schema cannot express (a breached password) has its own translation.
 */
export function serverFieldMessages(t: Translate, error: ApiError): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const issue of error.fieldIssues) {
    const field = issue.path.split('.')[0] ?? '';
    if (!field || field in messages) continue;
    messages[field] =
      issue.code === 'custom' && /password/i.test(field) ? t('passwordTooCommon') : t('invalid');
  }
  return messages;
}
