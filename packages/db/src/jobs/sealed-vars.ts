import { SEALED_VARS_KEY } from '@venueos/shared';
import { SealError } from '../crypto/seal.js';
import type { Sealer } from '../crypto/seal.js';

/** The AAD every sealed email secret is bound to: opening it for another row (or tenant) fails. */
export function sealedVarsAad(tenantId: string, messageKey: string): string {
  return `${tenantId}:${messageKey}`;
}

/**
 * The template variables of a queued message with its sealed secrets opened and merged in (secrets win on a
 * name clash). Used by the worker just before rendering; the result is never stored or logged.
 *
 * @throws SealError when `template_vars` is not an object, or the sealed part does not open for this row
 */
export function openTemplateVars(
  sealer: Sealer,
  tenantId: string,
  messageKey: string,
  stored: unknown,
): Record<string, unknown> {
  if (stored === null || stored === undefined) return {};
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    throw new SealError('template variables are malformed');
  }
  const { [SEALED_VARS_KEY]: sealed, ...plain } = stored as Record<string, unknown>;
  if (sealed === undefined) return plain;
  if (typeof sealed !== 'string') throw new SealError('sealed variables are malformed');

  let secrets: unknown;
  try {
    secrets = JSON.parse(sealer.open(sealed, sealedVarsAad(tenantId, messageKey)));
  } catch (error) {
    if (error instanceof SealError) throw error;
    throw new SealError('sealed variables are malformed');
  }
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
    throw new SealError('sealed variables are malformed');
  }
  return { ...plain, ...(secrets as Record<string, unknown>) };
}
