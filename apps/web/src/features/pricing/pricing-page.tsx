'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { NoAccess, ReadOnlyNote } from '@/components/resource-ui';
import { Tabs } from '@/components/tabs';
import type { TabDefinition } from '@/components/tabs';
import { useSession } from '../shell/session';
import { CustomFieldsTab } from './custom-fields-tab';
import { PoliciesTab } from './policies-tab';
import { PriceRulesTab } from './price-rules-tab';
import { TaxRatesTab } from './tax-rates-tab';

type Tab = 'priceRules' | 'taxRates' | 'policies' | 'customFields';

/**
 * Pricing (`pricing.view`): price rules with the rent preview, tax rates, cancellation policies. Custom fields sit
 * here too (they need `catalogue.view`), because they are set up once with the rest of the prices and policies.
 */
export function PricingPage() {
  const t = useTranslations('Pricing');
  const { can, access } = useSession();

  const tabs: TabDefinition<Tab>[] = [
    ...(can('pricing.view')
      ? ([
          { id: 'priceRules', label: t('tabs.priceRules') },
          { id: 'taxRates', label: t('tabs.taxRates') },
          { id: 'policies', label: t('tabs.policies') },
        ] as const)
      : []),
    ...(can('catalogue.view')
      ? ([{ id: 'customFields', label: t('tabs.customFields') }] as const)
      : []),
  ];
  const [chosen, setChosen] = useState<Tab | null>(null);
  const first = tabs[0];
  if (!first) return <NoAccess text={t('noAccess')} />;
  const tab = tabs.some((x) => x.id === chosen) ? (chosen as Tab) : first.id;

  const readOnly = !can('pricing.manage') || access.venueIds.length > 0;

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      {readOnly ? <ReadOnlyNote text={t('readOnly')} /> : null}
      <Tabs label={t('tabs.label')} active={tab} onChange={setChosen} tabs={tabs} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'priceRules' ? <PriceRulesTab /> : null}
        {tab === 'taxRates' ? <TaxRatesTab /> : null}
        {tab === 'policies' ? <PoliciesTab /> : null}
        {tab === 'customFields' ? <CustomFieldsTab /> : null}
      </div>
    </div>
  );
}
