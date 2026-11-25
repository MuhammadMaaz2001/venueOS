'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ListState, NoAccess, TabHeader } from '@/components/resource-ui';
import { FormDialog } from '@/components/resource-ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDebounced } from '@/lib/use-debounced';
import { useSession } from '../shell/session';
import { useCustomers } from './api';
import { CustomerForm } from './customer-form';

/** Customers (`customer.view`): search, a list, and the add dialog (`customer.manage`). */
export function CustomersPage() {
  const t = useTranslations('Customers');
  const { can } = useSession();
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(search.trim());
  const customers = useCustomers({
    search: debounced,
    includeInactive: showInactive,
    enabled: can('customer.view'),
  });

  if (!can('customer.view')) return <NoAccess text={t('noAccess')} />;
  const rows = customers.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      <TabHeader
        description={t('description')}
        addLabel={can('customer.manage') ? t('add') : undefined}
        onAdd={can('customer.manage') ? () => setAdding(true) : undefined}
        addTestId="customer-add"
      />
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-0 flex-1 basis-60">
          <Label htmlFor="customer-search" className="sr-only">
            {t('search')}
          </Label>
          <Search
            className="text-muted-foreground pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            id="customer-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('searchPlaceholder')}
            autoComplete="off"
            className="h-10 ps-9 text-base md:text-sm"
            data-testid="customer-search"
          />
        </div>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
            className="size-4"
            data-testid="customer-show-inactive"
          />
          {t('showInactive')}
        </label>
      </div>
      <ListState
        pending={customers.isPending}
        failed={customers.isError}
        empty={customers.isSuccess && rows.length === 0}
        emptyText={debounced === '' ? t('empty') : t('emptySearch')}
        loadFailedText={t('loadFailed')}
      >
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y" data-testid="customer-list">
              {rows.map((customer) => (
                <li key={customer.id} data-testid="customer-row">
                  <Link
                    href={`/customers/${customer.id}`}
                    className="hover:bg-muted/50 flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                  >
                    <span className="min-w-0 flex-1 basis-40 truncate text-sm font-medium">
                      {customer.name}
                    </span>
                    <span className="ltr-isolate text-muted-foreground text-sm">
                      {customer.phone}
                    </span>
                    {customer.email ? (
                      <span className="ltr-isolate text-muted-foreground min-w-0 truncate text-sm">
                        {customer.email}
                      </span>
                    ) : null}
                    {!customer.active ? <Badge variant="secondary">{t('inactive')}</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        {customers.hasNextPage ? (
          <Button
            variant="outline"
            size="lg"
            className="h-10 w-fit"
            disabled={customers.isFetchingNextPage}
            onClick={() => void customers.fetchNextPage()}
            data-testid="customer-load-more"
          >
            {t('loadMore')}
          </Button>
        ) : null}
      </ListState>
      <FormDialog
        open={adding}
        onClose={() => setAdding(false)}
        title={t('addTitle')}
        description={t('formDescription')}
      >
        {adding ? (
          <CustomerForm
            onDone={(saved) => {
              setAdding(false);
              router.push(`/customers/${saved.id}`);
            }}
          />
        ) : null}
      </FormDialog>
    </div>
  );
}
