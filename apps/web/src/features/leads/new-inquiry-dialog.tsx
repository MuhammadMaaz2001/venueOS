'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { FormDialog } from '@/components/resource-ui';
import { LeadForm } from './lead-form';

/**
 * The quick "new inquiry" form (docs/01 module 5): pick the customer or type a new one in the same form, say what
 * they want, set the next follow-up. Opens the lead afterwards.
 */
export function NewInquiryDialog({
  open,
  onClose,
  customer,
}: {
  open: boolean;
  onClose: () => void;
  customer?: { id: string; name: string; phone: string } | undefined;
}) {
  const t = useTranslations('Leads');
  const router = useRouter();
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('newInquiry')}
      description={t('form.description')}
      wide
    >
      {open ? (
        <LeadForm
          customer={customer}
          onDone={(saved) => {
            onClose();
            router.push(`/leads/${saved.id}`);
          }}
        />
      ) : null}
    </FormDialog>
  );
}
