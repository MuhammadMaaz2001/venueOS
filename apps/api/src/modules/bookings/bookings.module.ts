import { Module } from '@nestjs/common';
import { BookingCoreModule } from './core/booking-core.module';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

/** Module 8: bookings (hold, confirm, change, cancel, restore) on top of the quotation core. */
@Module({
  imports: [BookingCoreModule],
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
