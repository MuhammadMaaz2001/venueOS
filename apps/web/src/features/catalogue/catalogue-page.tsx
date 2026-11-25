'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { NoAccess, ReadOnlyNote } from '@/components/resource-ui';
import { Tabs } from '@/components/tabs';
import { useSession } from '../shell/session';
import { AddOnsTab } from './add-ons-tab';
import { MenuItemsTab } from './menu-items-tab';
import { PackagesTab } from './packages-tab';

const TABS = ['menuItems', 'packages', 'addOns'] as const;
type Tab = (typeof TABS)[number];

/** The catalogue (`catalogue.view`): menu items, packages and add-ons, the things a quotation is built from. */
export function CataloguePage() {
  const t = useTranslations('Catalogue');
  const { can, access } = useSession();
  const [tab, setTab] = useState<Tab>('menuItems');

  if (!can('catalogue.view')) return <NoAccess text={t('noAccess')} />;
  const readOnly = !can('catalogue.manage') || access.venueIds.length > 0;

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      {readOnly ? <ReadOnlyNote text={t('readOnly')} /> : null}
      <Tabs
        label={t('tabs.label')}
        active={tab}
        onChange={setTab}
        tabs={TABS.map((id) => ({ id, label: t(`tabs.${id}`) }))}
      />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'menuItems' ? <MenuItemsTab /> : null}
        {tab === 'packages' ? <PackagesTab /> : null}
        {tab === 'addOns' ? <AddOnsTab /> : null}
      </div>
    </div>
  );
}
