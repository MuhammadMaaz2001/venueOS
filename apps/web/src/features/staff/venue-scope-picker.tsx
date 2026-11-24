'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { CheckboxField } from '@/components/form-fields';
import { Label } from '@/components/ui/label';
import { useSession } from '../shell/session';
import { useVenues } from '../setup/api';

/**
 * Which venues a person works in. Someone with access to all venues may give "all venues" or a selection; someone
 * limited to some venues can only choose among their own (the API refuses anything wider, docs/04 section 2).
 *
 * `onChange` gets the venue ids to send (`[]` = all venues), or `null` while "selected venues" has nothing ticked
 * yet, so the form can keep its button disabled.
 */
export function VenueScopePicker({
  value,
  onChange,
}: {
  value: readonly string[];
  onChange: (venueIds: string[] | null) => void;
}) {
  const t = useTranslations('Staff.scope');
  const { can, access } = useSession();
  const unrestricted = access.venueIds.length === 0;
  const venues = useVenues({ enabled: can('venue.view') });
  const [mode, setMode] = useState<'all' | 'some'>(
    value.length === 0 && unrestricted ? 'all' : 'some',
  );
  const [selected, setSelected] = useState<string[]>([...value]);

  // Someone who may not list venues cannot choose: the form falls back to the caller's own scope.
  if (!venues.data) return null;

  const emit = (nextMode: 'all' | 'some', ids: string[]) => {
    if (nextMode === 'all') onChange([]);
    else onChange(ids.length === 0 ? null : ids);
  };

  return (
    <fieldset className="grid gap-2" data-testid="venue-scope-picker">
      <legend className="text-sm font-medium">{t('label')}</legend>
      {unrestricted ? (
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <input
              id="scope-all"
              type="radio"
              name="scope-mode"
              className="size-4"
              checked={mode === 'all'}
              onChange={() => {
                setMode('all');
                emit('all', selected);
              }}
            />
            <Label htmlFor="scope-all">{t('all')}</Label>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="scope-some"
              type="radio"
              name="scope-mode"
              className="size-4"
              checked={mode === 'some'}
              onChange={() => {
                setMode('some');
                emit('some', selected);
              }}
            />
            <Label htmlFor="scope-some">{t('selected')}</Label>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('ownOnly')}</p>
      )}
      {mode === 'some' ? (
        <div className="grid gap-2 ps-6">
          {venues.data.data
            .filter((venue) => venue.active || selected.includes(venue.id))
            .map((venue) => (
              <CheckboxField
                key={venue.id}
                label={venue.name}
                checked={selected.includes(venue.id)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, venue.id]
                    : selected.filter((id) => id !== venue.id);
                  setSelected(next);
                  emit('some', next);
                }}
              />
            ))}
          {selected.length === 0 ? (
            <p role="alert" className="text-destructive text-xs">
              {t('chooseOne')}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
