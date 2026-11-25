import { Module } from '@nestjs/common';
import { CustomFieldValuesModule } from '../../common/custom-fields/custom-fields.module';
import { CustomersModule } from '../customers/customers.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/** Module 5: leads / inquiries (board and list, stages, assignment, activity log, follow-up emails). */
@Module({
  imports: [CustomFieldValuesModule, CustomersModule],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
