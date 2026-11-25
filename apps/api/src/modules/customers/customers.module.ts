import { Module } from '@nestjs/common';
import { CustomFieldValuesModule } from '../../common/custom-fields/custom-fields.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** Module 4: customers (CRUD, search, duplicate warning, sealed sensitive custom fields). */
@Module({
  imports: [CustomFieldValuesModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
