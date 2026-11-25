import {
  CreateCustomerSchema,
  CustomerDetailSchema,
  CustomerDuplicatesQuerySchema,
  CustomerDuplicatesResponseSchema,
  CustomerListQuerySchema,
  CustomerListResponseSchema,
  CustomerRevealParamSchema,
  IdParamSchema,
  RevealedValueSchema,
  UpdateCustomerSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class CustomerIdParamDto extends createZodDto(IdParamSchema) {}
export class CustomerRevealParamDto extends createZodDto(CustomerRevealParamSchema) {}
export class CustomerDetailResponseDto extends createZodDto(CustomerDetailSchema) {}
export class CustomerListResponseDto extends createZodDto(CustomerListResponseSchema) {}
export class CustomerListQueryDto extends createZodDto(CustomerListQuerySchema) {}
export class CustomerDuplicatesQueryDto extends createZodDto(CustomerDuplicatesQuerySchema) {}
export class CustomerDuplicatesResponseDto extends createZodDto(CustomerDuplicatesResponseSchema) {}
export class CreateCustomerDto extends createZodDto(CreateCustomerSchema) {}
export class UpdateCustomerDto extends createZodDto(UpdateCustomerSchema) {}
export class RevealedValueResponseDto extends createZodDto(RevealedValueSchema) {}
