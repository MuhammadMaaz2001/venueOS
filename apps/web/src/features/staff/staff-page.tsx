'use client';

import { Mail, Pencil, UserPlus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import type { InvitationDto, StaffMemberDto } from '@venueos/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRoleName } from '../roles/use-role-name';
import { useVenues } from '../setup/api';
import { useSession } from '../shell/session';
import { useFormatters } from '../shell/session';
import { useInvitations, useRevokeInvitation, useStaff } from './api';
import { EditMemberDialog } from './edit-member-dialog';
import { InviteDialog } from './invite-dialog';

/** What a member's venue scope means, in words: the venue names when they can be listed, else a count. */
function useScopeText() {
  const t = useTranslations('Staff.scope');
  const { can } = useSession();
  const venues = useVenues({ includeInactive: true, enabled: can('venue.view') });
  return (venueIds: readonly string[]) => {
    if (venueIds.length === 0) return t('all');
    const names = venueIds.map((id) => venues.data?.data.find((v) => v.id === id)?.name);
    return names.every((n): n is string => n !== undefined)
      ? names.join(', ')
      : t('some', { count: venueIds.length });
  };
}

export function StaffPage() {
  const t = useTranslations('Staff');
  const { can } = useSession();
  const [inviteOpen, setInviteOpen] = useState(false);

  // The nav hides this page from roles without the permission; this is the page-level answer to a typed URL.
  if (!can('staff.manage')) {
    return (
      <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
        <AlertDescription>{t('noAccess')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button
          size="lg"
          className="h-10"
          onClick={() => setInviteOpen(true)}
          data-testid="invite-open"
        >
          <UserPlus aria-hidden />
          {t('invite.open')}
        </Button>
      </div>

      <MembersSection />
      <InvitationsSection />

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-2" aria-busy="true">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function MembersSection() {
  const t = useTranslations('Staff');
  const { user } = useSession();
  const staff = useStaff();
  const scopeText = useScopeText();
  const roleName = useRoleName();
  const [editing, setEditing] = useState<StaffMemberDto | null>(null);

  return (
    <section aria-labelledby="members-heading" className="grid gap-3">
      <h2 id="members-heading" className="text-lg font-medium">
        {t('members.title')}
      </h2>
      {staff.isPending ? (
        <ListSkeleton />
      ) : staff.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('members.loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="staff-list">
              {staff.data.data.map((member) => (
                <li
                  key={member.membershipId}
                  className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] md:items-center md:gap-4"
                  data-testid="staff-row"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{member.name}</span>
                      {member.userId === user.id ? (
                        <Badge variant="secondary">{t('members.you')}</Badge>
                      ) : null}
                    </p>
                    {member.email ? (
                      <p className="text-muted-foreground ltr-text truncate text-xs">
                        {member.email}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant="outline">{roleName(member.roleName)}</Badge>
                    {!member.active ? (
                      <Badge variant="secondary">{t('members.inactive')}</Badge>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground text-xs">{scopeText(member.venueIds)}</p>
                  <div className="md:justify-self-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      className="h-9"
                      onClick={() => setEditing(member)}
                      aria-label={t('members.editNamed', { name: member.name })}
                    >
                      <Pencil aria-hidden />
                      {t('members.edit')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <EditMemberDialog member={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function InvitationsSection() {
  const t = useTranslations('Staff');
  const invitations = useInvitations();
  const revoke = useRevokeInvitation();
  const formatters = useFormatters();
  const scopeText = useScopeText();
  const roleName = useRoleName();

  const onRevoke = (invitation: InvitationDto) =>
    revoke.mutate(invitation.id, { onSuccess: () => toast.success(t('invitations.revoked')) });

  return (
    <section aria-labelledby="invitations-heading" className="grid gap-3">
      <h2 id="invitations-heading" className="text-lg font-medium">
        {t('invitations.title')}
      </h2>
      {invitations.isPending ? (
        <ListSkeleton />
      ) : invitations.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t('invitations.loadFailed')}</AlertDescription>
        </Alert>
      ) : invitations.data.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('invitations.empty')}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="invitation-list">
              {invitations.data.data.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  data-testid="invitation-row"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Mail className="size-4 shrink-0" aria-hidden />
                      <span className="ltr-text truncate">{invitation.email}</span>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {invitation.roleName ? roleName(invitation.roleName) : '—'} ·{' '}
                      {scopeText(invitation.venueIds)} ·{' '}
                      {invitation.status === 'expired'
                        ? t('invitations.expired')
                        : t('invitations.expires', {
                            date: formatters.dateTime(invitation.expiresAt),
                          })}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-9"
                    disabled={revoke.isPending}
                    onClick={() => onRevoke(invitation)}
                  >
                    <X aria-hidden />
                    {t('invitations.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
