import { Module } from '@nestjs/common';
import { BookingWriter } from './booking-writer.service';
import { QuoteBuilder } from './quote-builder.service';
import { LeadLink } from './support';

/** What quotations and bookings share: pricing a quote from ids, persisting a version, moving the lead along. */
@Module({
  providers: [QuoteBuilder, BookingWriter, LeadLink],
  exports: [QuoteBuilder, BookingWriter, LeadLink],
})
export class BookingCoreModule {}
