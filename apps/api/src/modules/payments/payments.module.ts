import { Module } from '@nestjs/common';
import { PresignService } from '../../common/storage/presign.service';
import { PaymentsCoreModule } from './core/payments-core.module';
import {
  BookingPaymentsController,
  PaymentsController,
  ReceivablesController,
  RefundRequestsController,
} from './payments.controller';
import { PaymentsService } from './payments.service';
import { ReceivablesService } from './receivables.service';
import { RefundsService } from './refunds.service';

/** Module 9: payments, the payment schedule, receipts, refunds and receivables. */
@Module({
  imports: [PaymentsCoreModule],
  controllers: [
    BookingPaymentsController,
    PaymentsController,
    RefundRequestsController,
    ReceivablesController,
  ],
  providers: [PaymentsService, RefundsService, ReceivablesService, PresignService],
})
export class PaymentsModule {}
