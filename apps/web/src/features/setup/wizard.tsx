'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import type { SlotTemplateDto, SpaceDto, VenueDto } from '@venueos/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useSession } from '../shell/session';
import { useCreateSlot, useSlots, useSpaces, useVenues } from './api';
import { SLOT_PRESETS, WIZARD_STEPS, currentStep } from './logic';
import type { WizardStep } from './logic';
import { PricesForm } from './prices-form';
import { SlotForm } from './slot-form';
import { SpaceForm } from './space-form';
import { VenueForm } from './venue-form';

const FORM_STEPS = WIZARD_STEPS.filter((s) => s !== 'done');

/**
 * The setup wizard (docs/01 module 1): venue → spaces → slots → prices → done. It works out where to start from what
 * already exists on the server, so a reload (or another device) resumes. Everything it does can also be done, and
 * changed later, on the venue pages.
 */
export function SetupWizard() {
  const t = useTranslations('Setup.wizard');
  const { can, access } = useSession();
  const venues = useVenues({ includeInactive: true });
  const venue = venues.data?.data[0];
  const spaces = useSpaces(venue?.id);
  const slots = useSlots(venue?.id);

  if (!can('venue.manage') || access.venueIds.length > 0) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }
  const failed = venues.isError || spaces.isError || slots.isError;
  const ready = venues.isSuccess && (venue === undefined || (spaces.isSuccess && slots.isSuccess));
  if (failed) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('loadFailed')}</AlertDescription>
      </Alert>
    );
  }
  if (!ready) return <Skeleton className="mx-auto h-64 max-w-3xl" aria-busy="true" />;

  return (
    <WizardBody venue={venue} spaces={spaces.data?.data ?? []} slots={slots.data?.data ?? []} />
  );
}

function WizardBody({
  venue,
  spaces,
  slots,
}: {
  venue: VenueDto | undefined;
  spaces: readonly SpaceDto[];
  slots: readonly SlotTemplateDto[];
}) {
  const t = useTranslations('Setup.wizard');
  // Resume where the data stops; from then on the buttons move the user.
  const [step, setStep] = useState<WizardStep>(() =>
    currentStep({ venue, spaces, slots, pricedSpaces: 0 }, false),
  );
  const index = FORM_STEPS.indexOf(step as (typeof FORM_STEPS)[number]);
  const next = () => setStep(WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1] ?? 'done');
  const back = () => setStep(WIZARD_STEPS[Math.max(0, WIZARD_STEPS.indexOf(step) - 1)] ?? 'venue');

  return (
    <div className="mx-auto grid max-w-2xl gap-6" data-testid="wizard">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      {step !== 'done' ? (
        <>
          <ol className="hidden grid-cols-4 gap-2 sm:grid" aria-label={t('progress')}>
            {FORM_STEPS.map((s, i) => (
              <li
                key={s}
                aria-current={s === step ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                  s === step ? 'border-primary font-medium' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'grid size-5 shrink-0 place-items-center rounded-full border text-xs',
                    i < index && 'bg-primary text-primary-foreground border-primary',
                  )}
                >
                  {i < index ? <Check className="size-3" aria-hidden /> : i + 1}
                </span>
                {t(`steps.${s}`)}
              </li>
            ))}
          </ol>
          <p className="text-muted-foreground text-sm sm:hidden" aria-live="polite">
            {t('stepOf', {
              current: index + 1,
              total: FORM_STEPS.length,
              name: t(`steps.${step}`),
            })}
          </p>
        </>
      ) : null}

      <Card data-testid={`wizard-step-${step}`}>
        {step === 'venue' ? <VenueStep venue={venue} onNext={next} /> : null}
        {step === 'spaces' && venue ? (
          <SpacesStep venue={venue} spaces={spaces} onNext={next} onBack={back} />
        ) : null}
        {step === 'slots' && venue ? (
          <SlotsStep venue={venue} slots={slots} onNext={next} onBack={back} />
        ) : null}
        {step === 'prices' && venue ? (
          <PricesStep spaces={spaces} onNext={next} onBack={back} />
        ) : null}
        {step === 'done' && venue ? <DoneStep venue={venue} /> : null}
      </Card>
    </div>
  );
}

function StepHeader({ title, description }: { title: string; description: string }) {
  return (
    <CardHeader>
      <CardTitle className="text-lg">{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
  );
}

function Nav({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
}) {
  const t = useTranslations('Setup.wizard');
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
      {onBack ? (
        <Button type="button" variant="ghost" size="lg" className="h-10" onClick={onBack}>
          {t('back')}
        </Button>
      ) : (
        <span />
      )}
      <Button
        type="button"
        size="lg"
        className="h-10"
        disabled={nextDisabled}
        onClick={onNext}
        data-testid="wizard-next"
      >
        {nextLabel}
      </Button>
    </div>
  );
}

function VenueStep({ venue, onNext }: { venue: VenueDto | undefined; onNext: () => void }) {
  const t = useTranslations('Setup.wizard.venue');
  return (
    <>
      <StepHeader title={t('title')} description={t('description')} />
      <CardContent>
        <VenueForm
          key={venue ? `${venue.id}:${venue.rev}` : 'new'}
          {...(venue ? { venue } : {})}
          submitLabel={t('submit')}
          onDone={onNext}
        />
      </CardContent>
    </>
  );
}

function SpacesStep({
  venue,
  spaces,
  onNext,
  onBack,
}: {
  venue: VenueDto;
  spaces: readonly SpaceDto[];
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Setup.wizard.spaces');
  // A fresh form after each added space.
  const [round, setRound] = useState(0);
  return (
    <>
      <StepHeader title={t('title')} description={t('description')} />
      <CardContent className="grid gap-4">
        {spaces.length > 0 ? (
          <ul
            className="grid gap-1 text-sm"
            data-testid="wizard-space-list"
            aria-label={t('added')}
          >
            {spaces.map((space) => (
              <li key={space.id} className="flex items-center gap-2">
                <Check className="size-4 text-green-600" aria-hidden />
                {space.name}
              </li>
            ))}
          </ul>
        ) : null}
        <SpaceForm
          key={round}
          venueId={venue.id}
          physicalSpaces={spaces.filter((s) => s.active)}
          submitLabel={spaces.length === 0 ? t('addFirst') : t('addAnother')}
          onDone={() => setRound((r) => r + 1)}
        />
        <Nav
          onBack={onBack}
          onNext={onNext}
          nextLabel={t('next')}
          nextDisabled={spaces.length === 0}
        />
      </CardContent>
    </>
  );
}

function SlotsStep({
  venue,
  slots,
  onNext,
  onBack,
}: {
  venue: VenueDto;
  slots: readonly SlotTemplateDto[];
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Setup.wizard.slots');
  const create = useCreateSlot();
  const [round, setRound] = useState(0);

  const addPreset = async (key: (typeof SLOT_PRESETS)[number]['key']) => {
    const preset = SLOT_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    try {
      await create.mutateAsync({
        venueId: venue.id,
        name: t(`presets.${key}`),
        mode: 'FIXED',
        startTime: preset.startTime,
        endTime: preset.endTime,
        daysOfWeek: [],
      });
      toast.success(t('added', { name: t(`presets.${key}`) }));
    } catch {
      // Toasted globally (a slot with this name already exists, plan, ...).
    }
  };
  const has = (name: string) =>
    slots.some((s) => s.active && s.name.toLowerCase() === name.toLowerCase());

  return (
    <>
      <StepHeader title={t('title')} description={t('description')} />
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap gap-2">
          {SLOT_PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="outline"
              size="lg"
              className="h-10"
              disabled={create.isPending || has(t(`presets.${preset.key}`))}
              onClick={() => addPreset(preset.key)}
              data-testid={`preset-${preset.key}`}
            >
              {t('preset', {
                name: t(`presets.${preset.key}`),
                start: preset.startTime,
                end: preset.endTime,
              })}
            </Button>
          ))}
        </div>
        {slots.length > 0 ? (
          <ul
            className="grid gap-1 text-sm"
            data-testid="wizard-slot-list"
            aria-label={t('addedList')}
          >
            {slots.map((slot) => (
              <li key={slot.id} className="flex items-center gap-2">
                <Check className="size-4 text-green-600" aria-hidden />
                {slot.name}
                <span className="text-muted-foreground text-xs">
                  {slot.mode === 'FULL_DAY' ? t('wholeDay') : `${slot.startTime}–${slot.endTime}`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">{t('custom')}</summary>
          <div className="pt-4">
            <SlotForm
              key={round}
              venueId={venue.id}
              submitLabel={t('addCustom')}
              onDone={() => setRound((r) => r + 1)}
            />
          </div>
        </details>
        <Nav
          onBack={onBack}
          onNext={onNext}
          nextLabel={t('next')}
          nextDisabled={slots.length === 0}
        />
      </CardContent>
    </>
  );
}

function PricesStep({
  spaces,
  onNext,
  onBack,
}: {
  spaces: readonly SpaceDto[];
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Setup.wizard.prices');
  const venueId = spaces[0]?.venueId;
  const slots = useSlots(venueId);
  const active = spaces.filter((s) => s.active);
  const [open, setOpen] = useState(active[0]?.id);

  return (
    <>
      <StepHeader title={t('title')} description={t('description')} />
      <CardContent className="grid gap-4">
        {slots.isPending ? <Skeleton className="h-24 w-full" aria-busy="true" /> : null}
        {slots.data
          ? active.map((space) => (
              <section key={space.id} className="grid gap-3 rounded-lg border p-3">
                <button
                  type="button"
                  className="flex min-h-10 items-center justify-between text-start text-sm font-medium"
                  aria-expanded={open === space.id}
                  onClick={() => setOpen(open === space.id ? undefined : space.id)}
                >
                  {space.name}
                </button>
                {open === space.id ? (
                  <PricesForm space={space} slots={slots.data.data} submitLabel={t('save')} />
                ) : null}
              </section>
            ))
          : null}
        <Nav onBack={onBack} onNext={onNext} nextLabel={t('next')} />
      </CardContent>
    </>
  );
}

function DoneStep({ venue }: { venue: VenueDto }) {
  const t = useTranslations('Setup.wizard.done');
  return (
    <>
      <StepHeader title={t('title')} description={t('description', { name: venue.name })} />
      <CardContent className="flex flex-wrap gap-3">
        <Button asChild size="lg" className="h-10" data-testid="wizard-finish">
          <Link href="/">{t('dashboard')}</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="h-10">
          <Link href={`/venues/${venue.id}`}>{t('openVenue')}</Link>
        </Button>
      </CardContent>
    </>
  );
}
