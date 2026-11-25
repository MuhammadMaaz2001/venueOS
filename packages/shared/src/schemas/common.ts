import { z } from 'zod';

// Building blocks shared by the schema files of the modules. Not re-exported from the package: import by path.

export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid id');
export const Rev = z.number().int().min(1);
export const Name = (max: number) => z.string().trim().min(1).max(max);
export const OptionalText = (max: number) => z.string().trim().max(max).nullable();
export const IsoDateTime = z.iso.datetime();

/** Unpaged list answer (a tenant has few venues, spaces, catalogue rows): `nextCursor` is always null. */
export const listOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.null() });

/** `?includeInactive=true` shows deactivated rows too (settings screens need them to reactivate). */
export const IncludeInactive = z.enum(['true', 'false']).optional();

/** True when a PATCH body names at least one field besides `rev`. */
export const hasChange = (v: Record<string, unknown>): boolean =>
  Object.keys(v).some((k) => k !== 'rev' && v[k] !== undefined);
