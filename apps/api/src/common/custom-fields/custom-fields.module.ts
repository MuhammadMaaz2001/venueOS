import { Module } from '@nestjs/common';
import { CustomFieldValuesService } from './custom-field-values.service';

/** Validation / sealing of custom field VALUES, shared by customers and leads (the definitions are module 3). */
@Module({ providers: [CustomFieldValuesService], exports: [CustomFieldValuesService] })
export class CustomFieldValuesModule {}
