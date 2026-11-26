import { Module } from '@nestjs/common';
import { PaymentsLedger } from './ledger.service';
import { PaymentSchedule } from './schedule.service';

/** What bookings and payments share: the ledger (paid total) and the payment schedule. */
@Module({
  providers: [PaymentsLedger, PaymentSchedule],
  exports: [PaymentsLedger, PaymentSchedule],
})
export class PaymentsCoreModule {}
