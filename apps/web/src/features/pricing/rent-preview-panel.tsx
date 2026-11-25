'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { SelectField, TextField } from '@/components/form-fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { isApiError } from '@/lib/api/errors';
import { useSlots, useSpaces, useVenues } from '../setup/api';
import { useFormatters } from '../shell/session';
import { useRentPreview } from './api';
import { ruleEffect } from './logic';

/**
 * "What would this space cost on that day?" (docs/05 section 3, steps 1 and 2): the rent of a slot, every price rule
 * that applies in the order it is applied, and the final rent. Read-only, and exactly what a quotation will charge for
 * the rent, because the API uses the same functions.
 */
export function RentPreviewPanel() {
  const t = useTranslations('Pricing.preview');
  const fmt = useFormatters();
  const venues = useVenues();
  const [venueChoice, setVenueChoice] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [slotId, setSlotId] = useState('');
  const [date, setDate] = useState('');
  const [hours, setHours] = useState('');

  const venueId = venueChoice || venues.data?.data[0]?.id;
  const spaces = useSpaces(venueId);
  const slots = useSlots(venueId);
  const slot = slots.data?.data.find((s) => s.id === slotId);
  const needsHours = slot?.mode === 'HOURLY';

  const ready =
    venueId !== undefined &&
    spaceId !== '' &&
    slotId !== '' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    (!needsHours || hours.trim() !== '');
  const preview = useRentPreview(
    ready
      ? {
          venueId,
          spaceId,
          slotId,
          date,
          ...(needsHours ? { hours: hours.trim() } : {}),
        }
      : undefined,
  );

  const changeVenue = (id: string) => {
    setVenueChoice(id);
    setSpaceId('');
    setSlotId('');
  };

  return (
    <Card data-testid="rent-preview">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {(venues.data?.data.length ?? 0) > 1 ? (
            <SelectField
              label={t('venue')}
              value={venueId ?? ''}
              onChange={(e) => changeVenue(e.target.value)}
              data-testid="preview-venue"
            >
              {venues.data?.data.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </SelectField>
          ) : null}
          <SelectField
            label={t('space')}
            value={spaceId}
            onChange={(e) => setSpaceId(e.target.value)}
            data-testid="preview-space"
          >
            <option value="">{t('choose')}</option>
            {spaces.data?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('slot')}
            value={slotId}
            onChange={(e) => setSlotId(e.target.value)}
            data-testid="preview-slot"
          >
            <option value="">{t('choose')}</option>
            {slots.data?.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t('date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            isolate
            data-testid="preview-date"
          />
          {needsHours ? (
            <TextField
              label={t('hours')}
              hint={t('hoursHint')}
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              isolate
              data-testid="preview-hours"
            />
          ) : null}
        </div>

        {!ready ? (
          <p className="text-muted-foreground text-sm">{t('fillIn')}</p>
        ) : preview.isPending ? (
          <Skeleton className="h-24 w-full" aria-busy="true" />
        ) : preview.isError ? (
          <Alert variant="destructive" role="alert" data-testid="preview-error">
            <AlertDescription>{t(errorKey(preview.error))}</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-2" data-testid="preview-result" aria-live="polite">
            <dl className="grid gap-1 text-sm">
              <PreviewLine
                label={
                  preview.data.slotMode === 'HOURLY'
                    ? t('baseHourly', {
                        rent: fmt.money(preview.data.unitRent),
                        hours: preview.data.hours ?? '',
                      })
                    : preview.data.baseSource === 'SLOT_PRICE'
                      ? t('baseSlot')
                      : t('baseSpace')
                }
                value={fmt.money(preview.data.baseRent)}
                testId="preview-base"
              />
              {preview.data.adjustments.map((line) => (
                <PreviewLine
                  key={line.ruleId}
                  label={`${line.name} (${ruleEffect(line.adjustment, line.value, fmt.money)})`}
                  value={fmt.money(line.amount)}
                  testId="preview-adjustment"
                />
              ))}
              <PreviewLine
                label={t('final')}
                value={fmt.money(preview.data.finalRent)}
                testId="preview-final"
                strong
              />
            </dl>
            {preview.data.adjustments.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('noRules')}</p>
            ) : null}
            {preview.data.notApplied.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                {t('notApplied', { names: preview.data.notApplied.map((n) => n.name).join(', ') })}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PreviewLine({
  label,
  value,
  testId,
  strong,
}: {
  label: string;
  value: string;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${strong ? 'border-t pt-2 font-semibold' : ''}`}
      data-testid={testId}
    >
      <dt className="min-w-0">{label}</dt>
      <dd className="shrink-0 tabular-nums">{value}</dd>
    </div>
  );
}

/** Which message explains a failed preview: it is an answer ("not offered that day"), not a crash. */
function errorKey(error: unknown): 'noRent' | 'notOffered' | 'hoursInvalid' | 'failed' {
  if (isApiError(error)) {
    if (error.code === 'INVALID_STATE_TRANSITION') return 'noRent';
    if (error.code === 'VALIDATION_ERROR') {
      const path = error.fieldIssues[0]?.path;
      if (path === 'date') return 'notOffered';
      if (path === 'hours') return 'hoursInvalid';
    }
  }
  return 'failed';
}
