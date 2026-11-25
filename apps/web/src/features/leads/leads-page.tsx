'use client';

import { LEAD_SOURCES } from '@venueos/shared';
import type { LeadDto, LeadStage } from '@venueos/shared';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { SelectField, TextField } from '@/components/form-fields';
import { ListState, NoAccess } from '@/components/resource-ui';
import { Tabs } from '@/components/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useDebounced } from '@/lib/use-debounced';
import { useVenues } from '../setup/api';
import { useSession } from '../shell/session';
import { NO_FILTERS, useLeadAssignees, useLeads } from './api';
import type { LeadFilters } from './api';
import { FollowUpBadge, LeadCard } from './lead-card';
import { BOARD_STAGES, reachableStages } from './logic';
import { NewInquiryDialog } from './new-inquiry-dialog';
import { useStageMove } from './stage-move';

const VIEWS = ['board', 'list'] as const;
type View = (typeof VIEWS)[number];

function BoardColumn({
  stage,
  filters,
  mayMove,
  onMove,
  onDropLead,
  registry,
  showVenue,
}: {
  stage: LeadStage;
  filters: LeadFilters;
  mayMove: boolean;
  onMove: (lead: LeadDto, to: LeadStage) => void;
  onDropLead: (id: string, to: LeadStage) => void;
  registry: React.RefObject<Map<string, LeadDto>>;
  showVenue: boolean;
}) {
  const t = useTranslations('Leads');
  const leads = useLeads({ filters, stage, limit: 25 });
  const rows = leads.data?.pages.flatMap((p) => p.data) ?? [];
  for (const lead of rows) registry.current.set(lead.id, lead);
  const [over, setOver] = useState(false);

  return (
    <section
      aria-label={t(`stages.${stage}`)}
      className={`bg-muted/40 flex w-72 shrink-0 flex-col gap-2 rounded-xl border p-2 ${over ? 'ring-primary ring-2' : ''}`}
      data-testid={`board-column-${stage}`}
      onDragOver={(event) => {
        if (!mayMove) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const id = event.dataTransfer.getData('text/lead-id');
        if (id) onDropLead(id, stage);
      }}
    >
      <h2 className="flex items-center justify-between px-1 text-sm font-semibold">
        {t(`stages.${stage}`)}
        <Badge variant="secondary" data-testid={`board-count-${stage}`}>
          {leads.hasNextPage ? `${rows.length}+` : rows.length}
        </Badge>
      </h2>
      {leads.isPending ? (
        <p className="text-muted-foreground px-1 text-xs">{t('loading')}</p>
      ) : leads.isError ? (
        <p role="alert" className="text-destructive px-1 text-xs">
          {t('loadFailed')}
        </p>
      ) : (
        <div className="grid gap-2">
          {rows.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              mayMove={mayMove}
              onMove={onMove}
              showVenue={showVenue}
            />
          ))}
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-1 text-xs">{t('columnEmpty')}</p>
          ) : null}
          {leads.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void leads.fetchNextPage()}
              disabled={leads.isFetchingNextPage}
            >
              {t('loadMore')}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ListView({
  filters,
  stage,
  showVenue,
}: {
  filters: LeadFilters;
  stage: LeadStage | '';
  showVenue: boolean;
}) {
  const t = useTranslations('Leads');
  const leads = useLeads({ filters, stage: stage === '' ? undefined : stage });
  const rows = leads.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <ListState
      pending={leads.isPending}
      failed={leads.isError}
      empty={leads.isSuccess && rows.length === 0}
      emptyText={t('empty')}
      loadFailedText={t('loadFailed')}
    >
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y" data-testid="lead-list">
            {rows.map((lead) => (
              <li key={lead.id} data-testid="lead-row">
                <Link
                  href={`/leads/${lead.id}`}
                  className="hover:bg-muted/50 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1 basis-40 truncate font-medium">
                    {lead.customer.name}
                  </span>
                  <Badge variant="outline">{t(`stages.${lead.stage}`)}</Badge>
                  <span className="text-muted-foreground">
                    {[lead.eventTypeName, lead.preferredDate, showVenue ? lead.venueName : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <FollowUpBadge lead={lead} />
                  <span className="text-muted-foreground text-xs">
                    {lead.assignee?.name ?? t('unassigned')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {leads.hasNextPage ? (
        <Button
          variant="outline"
          size="lg"
          className="mt-3 h-10 w-fit"
          onClick={() => void leads.fetchNextPage()}
          disabled={leads.isFetchingNextPage}
          data-testid="lead-load-more"
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </ListState>
  );
}

/** The leads of the workspace (`lead.view`): a board with a column per stage, or a list, with the same filters. */
export function LeadsPage() {
  const t = useTranslations('Leads');
  const { can, user } = useSession();
  const [view, setView] = useState<View>('board');
  const [filters, setFilters] = useState<LeadFilters>(NO_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [listStage, setListStage] = useState<LeadStage | ''>('');
  const [inquiry, setInquiry] = useState(false);
  const registry = useRef(new Map<string, LeadDto>());
  const stageMove = useStageMove();

  const debouncedSearch = useDebounced(searchText.trim());
  const effective: LeadFilters = { ...filters, search: debouncedSearch };
  const venues = useVenues({ enabled: can('lead.view') });
  const assignees = useLeadAssignees('', can('lead.view'));

  if (!can('lead.view')) return <NoAccess text={t('noAccess')} />;
  const venueList = (venues.data?.data ?? []).filter((v) => v.active);
  const mine = (assignees.data?.data ?? []).find((a) => a.userId === user.id);
  const mayMove = can('lead.manage');
  const showVenue = venueList.length > 1;
  const set = <K extends keyof LeadFilters>(key: K, value: LeadFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const filtered =
    JSON.stringify({ ...filters, search: searchText.trim() }) !== JSON.stringify(NO_FILTERS);

  return (
    <div className="mx-auto grid w-full max-w-[100rem] grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {can('lead.manage') ? (
          <Button
            size="lg"
            className="h-10"
            onClick={() => setInquiry(true)}
            data-testid="lead-add"
          >
            <Plus aria-hidden />
            {t('newInquiry')}
          </Button>
        ) : null}
      </div>

      <Tabs
        label={t('views.label')}
        active={view}
        onChange={setView}
        tabs={VIEWS.map((id) => ({ id, label: t(`views.${id}`) }))}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" data-testid="lead-filters">
        <TextField
          label={t('filters.search')}
          type="search"
          autoComplete="off"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          data-testid="lead-filter-search"
        />
        {venueList.length > 1 ? (
          <SelectField
            label={t('filters.venue')}
            value={filters.venueId}
            onChange={(event) => set('venueId', event.target.value)}
            data-testid="lead-filter-venue"
          >
            <option value="">{t('filters.any')}</option>
            {venueList.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <SelectField
          label={t('filters.assignee')}
          value={filters.assignee}
          onChange={(event) => set('assignee', event.target.value)}
          data-testid="lead-filter-assignee"
        >
          <option value="">{t('filters.any')}</option>
          {mine ? <option value={mine.membershipId}>{t('filters.mine')}</option> : null}
          <option value="unassigned">{t('unassigned')}</option>
          {(assignees.data?.data ?? [])
            .filter((a) => a.userId !== user.id)
            .map((a) => (
              <option key={a.membershipId} value={a.membershipId}>
                {a.name}
              </option>
            ))}
        </SelectField>
        <SelectField
          label={t('filters.source')}
          value={filters.source}
          onChange={(event) => set('source', event.target.value as LeadFilters['source'])}
          data-testid="lead-filter-source"
        >
          <option value="">{t('filters.any')}</option>
          {LEAD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(`sources.${s}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('filters.followUp')}
          value={filters.followUp}
          onChange={(event) => set('followUp', event.target.value as LeadFilters['followUp'])}
          data-testid="lead-filter-follow-up"
        >
          <option value="">{t('filters.any')}</option>
          <option value="overdue">{t('followUp.overdue')}</option>
          <option value="today">{t('followUp.today')}</option>
        </SelectField>
        {view === 'list' ? (
          <SelectField
            label={t('filters.stage')}
            value={listStage}
            onChange={(event) => setListStage(event.target.value as LeadStage | '')}
            data-testid="lead-filter-stage"
          >
            <option value="">{t('filters.any')}</option>
            {BOARD_STAGES.map((s) => (
              <option key={s} value={s}>
                {t(`stages.${s}`)}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>
      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => {
            setFilters(NO_FILTERS);
            setSearchText('');
          }}
        >
          {t('filters.reset')}
        </Button>
      ) : null}

      <div role="tabpanel" id={`panel-${view}`} aria-labelledby={`tab-${view}`}>
        {view === 'board' ? (
          <div className="-mx-4 overflow-x-auto px-4 pb-3" data-testid="lead-board">
            <div className="flex items-start gap-3">
              {BOARD_STAGES.map((stage) => (
                <BoardColumn
                  key={stage}
                  stage={stage}
                  filters={effective}
                  mayMove={mayMove}
                  showVenue={showVenue}
                  registry={registry}
                  onMove={(lead, to) => void stageMove.move(lead, to)}
                  onDropLead={(id, to) => {
                    const lead = registry.current.get(id);
                    if (lead && reachableStages(lead.stage).includes(to))
                      void stageMove.move(lead, to);
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <ListView filters={effective} stage={listStage} showVenue={showVenue} />
        )}
      </div>
      {stageMove.dialog}
      <NewInquiryDialog open={inquiry} onClose={() => setInquiry(false)} />
    </div>
  );
}
