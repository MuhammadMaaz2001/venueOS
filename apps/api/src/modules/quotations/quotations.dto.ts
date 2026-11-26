import {
  CreateQuotationSchema,
  IdParamSchema,
  QuoteInputSchema,
  QuotationListQuerySchema,
  QuotationListResponseSchema,
  QuotationPdfSchema,
  QuotationSchema,
  QuotationWhatsAppSchema,
  QuotePreviewSchema,
  SendQuotationResultSchema,
  SendQuotationSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class QuotationIdParamDto extends createZodDto(IdParamSchema) {}
export class QuoteInputDto extends createZodDto(QuoteInputSchema) {}
export class CreateQuotationDto extends createZodDto(CreateQuotationSchema) {}
export class QuotePreviewResponseDto extends createZodDto(QuotePreviewSchema) {}
export class QuotationResponseDto extends createZodDto(QuotationSchema) {}
export class QuotationListQueryDto extends createZodDto(QuotationListQuerySchema) {}
export class QuotationListResponseDto extends createZodDto(QuotationListResponseSchema) {}
export class SendQuotationDto extends createZodDto(SendQuotationSchema) {}
export class SendQuotationResponseDto extends createZodDto(SendQuotationResultSchema) {}
export class QuotationPdfResponseDto extends createZodDto(QuotationPdfSchema) {}
export class QuotationWhatsAppResponseDto extends createZodDto(QuotationWhatsAppSchema) {}
