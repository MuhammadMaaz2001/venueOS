import { Module } from '@nestjs/common';
import { PaymentsCoreModule } from '../payments/core/payments-core.module';
import { BookingCoreModule } from './core/booking-core.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

/** Module 8: bookings (hold, confirm, change, cancel, restore) on top of the quotation core. */
@Module({
  imports: [BookingCoreModule, PaymentsCoreModule],
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
