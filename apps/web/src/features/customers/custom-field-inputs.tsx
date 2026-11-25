'use client';

import { useTranslations } from 'next-intl';
import type { CustomFieldDefDto } from '@venueos/shared';
import { SelectField, TextField } from '@/components/form-fields';

/** What a form keeps for its custom fields: the text of each box, by field key. */
export type FieldTexts = Record<string, string>;

/** The values of a record as the boxes start out: a sensitive value is never shown, so its box starts empty. */
export function initialFieldTexts(
  defs: readonly CustomFieldDefDto[],
  values: Record<string, string | number | null> | undefined,
): FieldTexts {
  const texts: FieldTexts = {};
  for (const def of defs) {
    const value = values?.[def.key];
    texts[def.key] = def.sensitive || value === undefined || value === null ? '' : String(value);
  }
  return texts;
}

/**
 * The `customFields` of a create or update: on a create every filled box; on an edit only the boxes that changed
 * (an emptied one clears the value with `null`). A sensitive box that stays empty keeps the stored value.
 */
export function fieldPayload(
  defs: readonly CustomFieldDefDto[],
  texts: FieldTexts,
  initial: FieldTexts | undefined,
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const def of defs) {
    const text = (texts[def.key] ?? '').trim();
    const before = (initial?.[def.key] ?? '').trim();
    if (initial === undefined) {
      if (text !== '') out[def.key] = text;
    } else if (text !== before) {
      out[def.key] = text === '' ? null : text;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Keys of required fields whose box is empty (a sensitive one that already has a stored value counts as filled). */
export function missingRequired(
  defs: readonly CustomFieldDefDto[],
  texts: FieldTexts,
  stored: Record<string, string | number | null> | undefined,
): string[] {
  return defs
    .filter(
      (d) =>
        d.required &&
        (texts[d.key] ?? '').trim() === '' &&
        (stored?.[d.key] === undefined || stored[d.key] === null),
    )
    .map((d) => d.key);
}

/** The boxes of the tenant's custom fields (module 3 definitions), one per active field. */
export function CustomFieldInputs({
  defs,
  texts,
  onChange,
  stored,
  errors,
}: {
  defs: readonly CustomFieldDefDto[];
  texts: FieldTexts;
  onChange: (key: string, value: string) => void;
  /** The record's stored values (masked for sensitive fields), to say "leave empty to keep". */
  stored?: Record<string, string | number | null> | undefined;
  /** Key -> message. */
  errors?: Record<string, string>;
}) {
  const t = useTranslations('Customers.fields');
  const active = defs.filter((d) => d.active);
  if (active.length === 0) return null;
  return (
    <fieldset className="grid gap-4" data-testid="custom-field-inputs">
      <legend className="mb-1 text-sm font-medium">{t('custom')}</legend>
      {active.map((def) => {
        const common = {
          label: def.required ? `${def.label} *` : def.label,
          error: errors?.[def.key],
          'data-testid': `custom-field-${def.key}`,
        } as const;
        const value = texts[def.key] ?? '';
        if (def.type === 'select') {
          return (
            <SelectField
              key={def.key}
              {...common}
              value={value}
              onChange={(event) => onChange(def.key, event.target.value)}
            >
              <option value="">{t('choose')}</option>
              {def.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>
          );
        }
        const hasStoredSecret = def.sensitive && stored?.[def.key] != null;
        return (
          <TextField
            key={def.key}
            {...common}
            value={value}
            autoComplete="off"
            type={def.type === 'date' ? 'date' : def.type === 'phone' ? 'tel' : 'text'}
            inputMode={def.type === 'number' ? 'decimal' : undefined}
            isolate={def.type === 'phone' || def.type === 'number' || def.sensitive}
            hint={
              hasStoredSecret
                ? t('sensitiveKeep', { masked: String(stored?.[def.key]) })
                : def.sensitive
                  ? t('sensitiveHint')
                  : undefined
            }
            onChange={(event) => onChange(def.key, event.target.value)}
          />
        );
      })}
    </fieldset>
  );
}
