import { Inject, Injectable } from '@nestjs/common';
import type { Sealer } from '@venueos/db';
import { PHONE_FAILURE_MESSAGES, maskSensitiveValue, normalizePhone } from '@venueos/shared';
import type { CustomFieldValues, CustomFieldValuesInput } from '@venueos/shared';
import { FIELD_SEALER } from '../jobs/email-outbox.service';
import { AUDIT_REDACTED } from '../audit/mask-sensitive';
import { FieldValidationError } from '../errors/domain-errors';
import { parseDateOnly } from '../time/zoned';

/** The part of a `custom_field_defs` row the values need. */
export interface FieldDef {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  sensitive: boolean;
  active: boolean;
}

/**
 * How values are kept in the record's `custom_fields` JSON: a plain value (`"Bride"`, `12`, `"2027-02-14"`), or for a
 * sensitive field `{ sealed, hint }`: the AES-256-GCM sealed value and its masked form (so listing never decrypts).
 */
export type StoredFieldValue = string | number | { sealed: string; hint: string };
export type StoredFields = Record<string, StoredFieldValue>;

export interface MergeInput {
  /** Active and inactive definitions of the record type. */
  defs: readonly FieldDef[];
  /** What the record holds now (`{}` for a new one). */
  current: unknown;
  /** What the client sent (only these keys change; `null` / `''` clears). */
  input: CustomFieldValuesInput | undefined;
  tenantId: string;
  /** Row id of the record: part of the sealing AAD, so a sealed value cannot be moved to another record. */
  recordId: string;
  country: string;
  /** New record: every required field must be given. Edit: a required field cannot be cleared. */
  creating: boolean;
}

export interface MergeResult {
  stored: StoredFields;
  /** Keys of sensitive fields that were written or cleared (never their values). */
  sensitiveChanged: string[];
  /** Keys that changed, sensitive or not. */
  changed: string[];
}

const TEXT_MAX = 500;

/** The AAD of a sealed field value: tenant, customer, field key (docs/04 section 6). */
export const customerFieldAad = (tenantId: string, customerId: string, key: string): string =>
  `customer-field:${tenantId}:${customerId}:${key}`;

const isSealed = (v: unknown): v is { sealed: string; hint: string } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { sealed?: unknown }).sealed === 'string' &&
  typeof (v as { hint?: unknown }).hint === 'string';

/** Reads the stored JSON defensively: anything that is not an object of known shapes is ignored. */
export function readStored(raw: unknown): StoredFields {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: StoredFields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || isSealed(value)) out[key] = value;
  }
  return out;
}

/**
 * Validation, storage and display of the values of tenant-defined fields (docs/01 module 3-5, docs/04 section 6).
 * Used by customers and leads. Sensitive fields (customers only) are sealed with the field-encryption keyring; reads
 * return the masked hint, and only `reveal` opens the value.
 */
@Injectable()
export class CustomFieldValuesService {
  constructor(@Inject(FIELD_SEALER) private readonly sealer: Sealer) {}

  merge(args: MergeInput): MergeResult {
    const byKey = new Map(args.defs.map((d) => [d.key, d]));
    const stored: StoredFields = { ...readStored(args.current) };
    const changed: string[] = [];
    const sensitiveChanged: string[] = [];

    for (const [key, raw] of Object.entries(args.input ?? {})) {
      const def = byKey.get(key);
      if (!def || !def.active) {
        throw new FieldValidationError(`customFields.${key}`, 'This field does not exist');
      }
      const value = this.parseValue(def, raw, args.country);
      if (value === undefined) {
        if (def.required && !args.creating) {
          throw new FieldValidationError(`customFields.${key}`, `${def.label} is required`);
        }
        if (key in stored) {
          delete stored[key];
          changed.push(key);
          if (def.sensitive) sensitiveChanged.push(key);
        }
        continue;
      }
      if (def.sensitive) {
        const clear = String(value);
        stored[key] = {
          sealed: this.sealer.seal(clear, customerFieldAad(args.tenantId, args.recordId, key)),
          hint: maskSensitiveValue(clear),
        };
        sensitiveChanged.push(key);
      } else {
        stored[key] = value;
      }
      changed.push(key);
    }

    if (args.creating) {
      for (const def of args.defs) {
        if (def.active && def.required && !(def.key in stored)) {
          throw new FieldValidationError(`customFields.${def.key}`, `${def.label} is required`);
        }
      }
    }
    return { stored, sensitiveChanged, changed };
  }

  /** `string | number` to store, or `undefined` when the value clears the field. */
  private parseValue(
    def: FieldDef,
    raw: string | number | null,
    country: string,
  ): string | number | undefined {
    const path = `customFields.${def.key}`;
    if (raw === null) return undefined;
    if (typeof raw === 'string' && raw.trim() === '') return undefined;
    switch (def.type) {
      case 'text': {
        const text = String(raw).trim();
        if (text.length > TEXT_MAX) {
          throw new FieldValidationError(path, `${def.label} is too long`);
        }
        return text;
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(raw.trim());
        if (!Number.isFinite(n))
          throw new FieldValidationError(path, `${def.label} must be a number`);
        return n;
      }
      case 'date': {
        if (typeof raw !== 'string' || !parseDateOnly(raw.trim())) {
          throw new FieldValidationError(path, `${def.label} must be a date (YYYY-MM-DD)`);
        }
        return raw.trim();
      }
      case 'select': {
        if (typeof raw !== 'string' || !def.options.includes(raw)) {
          throw new FieldValidationError(path, `Choose one of the options for ${def.label}`);
        }
        return raw;
      }
      case 'phone': {
        const result = normalizePhone(String(raw), country);
        if (!result.ok) throw new FieldValidationError(path, PHONE_FAILURE_MESSAGES[result.reason]);
        return result.e164;
      }
      default:
        throw new FieldValidationError(path, 'This field cannot be set');
    }
  }

  /** The values for a response: sensitive ones are the masked hint. Keys without a definition are left out. */
  display(
    defs: readonly FieldDef[],
    rawStored: unknown,
  ): { values: CustomFieldValues; sensitiveKeys: string[] } {
    const stored = readStored(rawStored);
    const values: CustomFieldValues = {};
    const sensitiveKeys: string[] = [];
    for (const def of defs) {
      const value = stored[def.key];
      if (value === undefined) continue;
      if (isSealed(value)) {
        values[def.key] = value.hint;
        sensitiveKeys.push(def.key);
      } else {
        values[def.key] = value;
      }
    }
    return { values, sensitiveKeys };
  }

  /** The values for an audit row: sensitive ones never appear, not even masked. */
  forAudit(rawStored: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(readStored(rawStored))) {
      out[key] = isSealed(value) ? AUDIT_REDACTED : value;
    }
    return out;
  }

  /** The clear value of a sensitive field, or `null` when the record holds none. */
  reveal(rawStored: unknown, tenantId: string, recordId: string, key: string): string | null {
    const value = readStored(rawStored)[key];
    if (!isSealed(value)) return null;
    return this.sealer.open(value.sealed, customerFieldAad(tenantId, recordId, key));
  }
}
