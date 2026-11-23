import { Controller, Post, Query } from '@nestjs/common';
import { TenantDb } from '@venueos/db';
import type { EnqueuedEmail } from '@venueos/db';
import { RequirePermission } from '../../common/access/access.decorators';
import { EmailOutbox } from '../../common/jobs/email-outbox.service';

// Test-only controller (never part of the application): a stand-in for a business endpoint that changes
// something and sends an email in the SAME transaction.

@Controller('_email')
export class EmailProbeController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly outbox: EmailOutbox,
  ) {}

  /** `?fail=1` makes the "business change" fail after the email was queued. */
  @Post('confirm')
  @RequirePermission('customer.manage')
  confirm(@Query('fail') fail?: string): Promise<EnqueuedEmail> {
    return this.tenantDb.tx(async (tx) => {
      const queued = await this.outbox.enqueue(tx, {
        to: 'guest@example.test',
        template: 'sample.hello',
        locale: 'en',
        vars: { name: 'Ali', venue: 'Royal Hall', booking: { number: 'BK-1' } },
        event: 'booking.confirmed',
      });
      if (fail === '1') throw new Error('business rule failed');
      return queued;
    });
  }
}
