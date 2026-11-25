'use client';

import { CalendarClock, MoreVertical, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { LeadDto, LeadStage } from '@venueos/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useFormatters, useSession } from '../shell/session';
import { followUpState, reachableStages } from './logic';

/** The follow-up of a lead as a small badge: overdue (red), today, or the date. */
export function FollowUpBadge({ lead }: { lead: Pick<LeadDto, 'nextFollowUpAt'> }) {
  const t = useTranslations('Leads');
  const { tenant } = useSession();
  const format = useFormatters();
  if (!lead.nextFollowUpAt) return null;
  const state = followUpState(lead.nextFollowUpAt, new Date(), tenant.timezone);
  return (
    <Badge
      variant={state === 'overdue' ? 'destructive' : state === 'today' ? 'default' : 'outline'}
      data-testid={`follow-up-${state}`}
      className="gap-1"
    >
      <CalendarClock aria-hidden />
      {state === 'overdue'
        ? t('followUp.overdue')
        : state === 'today'
          ? t('followUp.today')
          : null}{' '}
      {format.dateTime(lead.nextFollowUpAt)}
    </Badge>
  );
}

/** One lead on the board: who and what, the follow-up, and a menu to move it to another stage. */
export function LeadCard({
  lead,
  mayMove,
  onMove,
  showVenue,
}: {
  lead: LeadDto;
  mayMove: boolean;
  onMove: (lead: LeadDto, to: LeadStage) => void;
  showVenue: boolean;
}) {
  const t = useTranslations('Leads');
  const options = reachableStages(lead.stage);
  return (
    <article
      draggable={mayMove && options.length > 0}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/lead-id', lead.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      className={cn(
        'bg-card grid gap-2 rounded-lg border p-3 text-sm shadow-xs',
        mayMove && options.length > 0 && 'cursor-grab',
      )}
      data-testid="lead-card"
      data-lead-id={lead.id}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/leads/${lead.id}`}
          className="min-w-0 font-medium hover:underline"
          data-testid="lead-card-link"
        >
          <span className="block truncate">{lead.customer.name}</span>
        </Link>
        {mayMove && options.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="-me-1 -mt-1 size-8 shrink-0"
                aria-label={t('moveNamed', { name: lead.customer.name })}
                data-testid="lead-move"
              >
                <MoreVertical aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('moveTo')}</DropdownMenuLabel>
              {options.map((stage) => (
                <DropdownMenuItem
                  key={stage}
                  onSelect={() => onMove(lead, stage)}
                  data-testid={`move-${stage}`}
                >
                  {t(`stages.${stage}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        {[lead.eventTypeName, lead.preferredDate, showVenue ? lead.venueName : null]
          .filter(Boolean)
          .join(' · ') || t('noDetails')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <FollowUpBadge lead={lead} />
        {lead.guests ? (
          <span className="text-muted-foreground flex items-center gap-1 text-xs">
            <Users className="size-3" aria-hidden />
            {lead.guests}
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">{lead.assignee?.name ?? t('unassigned')}</p>
    </article>
  );
}
