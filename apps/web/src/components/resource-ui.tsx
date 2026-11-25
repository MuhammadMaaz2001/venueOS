'use client';

import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/features/shell/session';
import type { Permission } from '@venueos/shared';

/**
 * May this person CHANGE tenant-wide data? The API needs the permission and access to all venues (someone limited
 * to some venues reads the catalogue and prices but cannot change them); this only decides what the page shows.
 */
export function useCanWrite(permission: Permission): boolean {
  const { can, access } = useSession();
  return can(permission) && access.venueIds.length === 0;
}

/** The header of one tab: a short explanation and the "add" button (only for people who may add). */
export function TabHeader({
  description,
  addLabel,
  onAdd,
  addTestId,
}: {
  description: string;
  addLabel?: string | undefined;
  onAdd?: (() => void) | undefined;
  addTestId?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="text-muted-foreground max-w-prose text-sm">{description}</p>
      {onAdd && addLabel ? (
        <Button size="lg" className="h-10" onClick={onAdd} data-testid={addTestId}>
          <Plus aria-hidden />
          {addLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** Loading, failed or empty states shared by every list. `children` is shown when there is something to show. */
export function ListState({
  pending,
  failed,
  empty,
  emptyText,
  loadFailedText,
  children,
}: {
  pending: boolean;
  failed: boolean;
  empty: boolean;
  emptyText: string;
  loadFailedText: string;
  children: ReactNode;
}) {
  if (pending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (failed) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{loadFailedText}</AlertDescription>
      </Alert>
    );
  }
  if (empty) {
    return (
      <Card>
        <CardContent>
          <p className="text-muted-foreground text-sm">{emptyText}</p>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

/** A list of rows in one card; each row is a button when it can be edited. */
export function RowList({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y" data-testid={testId}>
          {children}
        </ul>
      </CardContent>
    </Card>
  );
}

export function Row({
  onOpen,
  testId,
  children,
  openLabel,
}: {
  onOpen?: (() => void) | undefined;
  testId: string;
  children: ReactNode;
  /** Accessible name of the "edit" action when the row is clickable. */
  openLabel?: string;
}) {
  const body = (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">{children}</div>
  );
  return (
    <li data-testid={testId}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={openLabel}
          className="hover:bg-muted/50 block w-full text-start"
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}

/** The dialog every add/edit form lives in: scrolls on a short phone screen. */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        className={`max-h-[90dvh] overflow-y-auto ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** "Not allowed" answer of a page for someone without the view permission (a typed URL; the nav hides it). */
export function NoAccess({ text }: { text: string }) {
  return (
    <Alert variant="destructive" role="alert" className="mx-auto max-w-3xl">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/** A note under a page title saying changes need access to all venues. */
export function ReadOnlyNote({ text }: { text: string }) {
  const t = useTranslations('Common');
  return (
    <Alert role="status">
      <AlertDescription>
        <span className="sr-only">{t('note')}: </span>
        {text}
      </AlertDescription>
    </Alert>
  );
}
