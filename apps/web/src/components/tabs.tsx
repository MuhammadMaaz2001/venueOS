'use client';

import { cn } from '@/lib/utils';

export interface TabDefinition<T extends string> {
  id: T;
  label: string;
}

/**
 * A row of tabs that scrolls sideways inside its own box on a phone (360 px) instead of widening the page. The page
 * renders the panel itself (`role="tabpanel"`, `id={`panel-${id}`}`, `aria-labelledby={`tab-${id}`}`).
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabDefinition<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mx-1 flex gap-1 overflow-x-auto border-b px-1"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          data-testid={`tab-${tab.id}`}
          onClick={() => onChange(tab.id)}
          className={cn(
            'h-10 shrink-0 border-b-2 px-3 text-sm font-medium whitespace-nowrap',
            tab.id === active
              ? 'border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground border-transparent',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
