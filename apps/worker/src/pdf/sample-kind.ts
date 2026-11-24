import type { PdfKindHandler } from './pdf-kind';

/**
 * `sample`: the kind of the skeleton. It prints the tenant's name and the entity id on the bilingual sample
 * page, and keeps no key (the job returns it in its output). It exists to prove the pipeline end to end and to
 * smoke-test a deployment; real documents (quotation, receipt, event sheet) are kinds added by their modules.
 */
export const sampleKind: PdfKindHandler = {
  kind: 'sample',
  template: 'sample',
  async load(tx, payload) {
    const tenant = await tx.tenant.findUnique({
      where: { id: payload.tenantId },
      select: { name: true, defaultLocale: true, timezone: true },
    });
    if (!tenant) return null;
    // The date is the tenant's local date, never the server's (CLAUDE.md rule 5).
    const issuedOn = new Intl.DateTimeFormat('en-CA', {
      timeZone: tenant.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return {
      locale: tenant.defaultLocale,
      vars: { tenantName: tenant.name, reference: payload.entityId, issuedOn },
    };
  },
};
