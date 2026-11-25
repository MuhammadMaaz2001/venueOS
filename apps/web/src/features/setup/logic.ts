import type { SlotTemplateDto, SpaceDto, VenueDto } from '@venueos/shared';

/**
 * The steps of the setup wizard, in order (docs/01 modules 1 and 3: venue → spaces → slots → prices → first package →
 * done). The package step is optional and can be skipped.
 */
export const WIZARD_STEPS = ['venue', 'spaces', 'slots', 'prices', 'package', 'done'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardFacts {
  venue: VenueDto | undefined;
  spaces: readonly SpaceDto[];
  slots: readonly SlotTemplateDto[];
  /** How many spaces already have at least one price. */
  pricedSpaces: number;
}

/**
 * Where the wizard stands, derived from what exists on the server, so a reload or a second device resumes at the
 * right step. Prices are optional per space (the wizard never forces a rent), so "prices" ends when the user says so
 * (`pricesDone`), not by counting.
 */
export function currentStep(facts: WizardFacts, pricesDone: boolean): WizardStep {
  if (!facts.venue) return 'venue';
  if (facts.spaces.length === 0) return 'spaces';
  if (facts.slots.length === 0) return 'slots';
  return pricesDone ? 'done' : 'prices';
}

/** The first two slots almost every venue starts with (docs/05 section 1). */
export const SLOT_PRESETS = [
  { key: 'lunch', startTime: '12:00', endTime: '16:00' },
  { key: 'dinner', startTime: '19:00', endTime: '23:30' },
] as const;

/** Parse an optional whole number from a text box: '' and garbage are "not given" (null). */
export function wholeNumberOrNull(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** The `daysOfWeek` of a slot in words ("Every day", "Sat, Sun"), from a formatter for weekday numbers. */
export function describeDays(
  days: readonly number[],
  everyDay: string,
  dayName: (day: number) => string,
): string {
  if (days.length === 0 || days.length === 7) return everyDay;
  return [...days]
    .sort((a, b) => a - b)
    .map(dayName)
    .join(', ');
}

/** "12:00–16:00", or "ends next day" hint is added by the caller when `endsNextDay`. */
export function slotRange(slot: Pick<SlotTemplateDto, 'mode' | 'startTime' | 'endTime'>): string {
  return `${slot.startTime}–${slot.endTime}`;
}

/** Does a FIXED/HOURLY range run past midnight? FULL_DAY (00:00–00:00) is "the whole day", not overnight. */
export function endsNextDay(
  slot: Pick<SlotTemplateDto, 'mode' | 'startTime' | 'endTime'>,
): boolean {
  return slot.mode !== 'FULL_DAY' && slot.endTime <= slot.startTime;
}
