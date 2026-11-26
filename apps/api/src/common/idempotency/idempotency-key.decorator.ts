import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { IdempotencyKeySchema } from '@venueos/shared';
import { FieldValidationError } from '../errors/domain-errors';

/**
 * The `Idempotency-Key` header (docs/04 section 7): required on every request that creates a payment, a refund request, an
 * expense or an inventory movement. The unique `(tenant_id, idempotency_key)` of those tables makes a retried request return
 * the first result instead of writing twice. A missing or malformed key is `400 VALIDATION_ERROR`.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const raw = request.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === '') {
      throw new FieldValidationError('Idempotency-Key', 'The Idempotency-Key header is required');
    }
    const parsed = IdempotencyKeySchema.safeParse(value);
    if (!parsed.success) {
      throw new FieldValidationError(
        'Idempotency-Key',
        parsed.error.issues[0]?.message ?? 'Invalid Idempotency-Key',
      );
    }
    return parsed.data;
  },
);
