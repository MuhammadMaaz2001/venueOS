import {
  CancellationPolicyListQuerySchema,
  CancellationPolicyListResponseSchema,
  CancellationPolicySchema,
  CreateCancellationPolicySchema,
  CreatePriceRuleSchema,
  CreateTaxRateSchema,
  IdParamSchema,
  PriceRuleListQuerySchema,
  PriceRuleListResponseSchema,
  PriceRuleSchema,
  RentPreviewQuerySchema,
  RentPreviewSchema,
  TaxRateListQuerySchema,
  TaxRateListResponseSchema,
  TaxRateSchema,
  UpdateCancellationPolicySchema,
  UpdatePriceRuleSchema,
  UpdateTaxRateSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class PricingIdParamDto extends createZodDto(IdParamSchema) {}

export class PriceRuleResponseDto extends createZodDto(PriceRuleSchema) {}
export class PriceRuleListResponseDto extends createZodDto(PriceRuleListResponseSchema) {}
export class PriceRuleListQueryDto extends createZodDto(PriceRuleListQuerySchema) {}
export class CreatePriceRuleDto extends createZodDto(CreatePriceRuleSchema) {}
export class UpdatePriceRuleDto extends createZodDto(UpdatePriceRuleSchema) {}

export class RentPreviewQueryDto extends createZodDto(RentPreviewQuerySchema) {}
export class RentPreviewResponseDto extends createZodDto(RentPreviewSchema) {}

export class TaxRateResponseDto extends createZodDto(TaxRateSchema) {}
export class TaxRateListResponseDto extends createZodDto(TaxRateListResponseSchema) {}
export class TaxRateListQueryDto extends createZodDto(TaxRateListQuerySchema) {}
export class CreateTaxRateDto extends createZodDto(CreateTaxRateSchema) {}
export class UpdateTaxRateDto extends createZodDto(UpdateTaxRateSchema) {}

export class CancellationPolicyResponseDto extends createZodDto(CancellationPolicySchema) {}
export class CancellationPolicyListResponseDto extends createZodDto(
  CancellationPolicyListResponseSchema,
) {}
export class CancellationPolicyListQueryDto extends createZodDto(
  CancellationPolicyListQuerySchema,
) {}
export class CreateCancellationPolicyDto extends createZodDto(CreateCancellationPolicySchema) {}
export class UpdateCancellationPolicyDto extends createZodDto(UpdateCancellationPolicySchema) {}
