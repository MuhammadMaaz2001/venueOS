import { Module } from '@nestjs/common';
import { PresignService } from '../../common/storage/presign.service';
import { BookingCoreModule } from '../bookings/core/booking-core.module';
import { QuotationsController } from './quotations.controller';
import { QuotationsService } from './quotations.service';

/** Module 7: quotations (preview, versions, send, accept, PDF link, WhatsApp text). */
@Module({
  imports: [BookingCoreModule],
  controllers: [QuotationsController],
  providers: [QuotationsService, PresignService],
  exports: [PresignService],
})
export class QuotationsModule {}
