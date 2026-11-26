import {
  BouncePaymentSchema,
  CreateRefundRequestSchema,
  DecideRefundSchema,
  IdParamSchema,
  PayRefundSchema,
  PaymentSchema,
  PaymentsOverviewSchema,
  ReceiptLinkSchema,
  ReceivablesQuerySchema,
  ReceivablesResponseSchema,
  ReceivablesSummarySchema,
  RecordPaymentSchema,
  RefundRequestListQuerySchema,
  RefundRequestListResponseSchema,
  RefundRequestSchema,
  RejectRefundSchema,
  ReplaceScheduleSchema,
  ResendReceiptResultSchema,
  ResendReceiptSchema,
  ReversePaymentSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class IdParamDto extends createZodDto(IdParamSchema) {}
export class RecordPaymentDto extends createZodDto(RecordPaymentSchema) {}
export class PaymentResponseDto extends createZodDto(PaymentSchema) {}
export class PaymentsOverviewResponseDto extends createZodDto(PaymentsOverviewSchema) {}
export class ReplaceScheduleDto extends createZodDto(ReplaceScheduleSchema) {}
export class BouncePaymentDto extends createZodDto(BouncePaymentSchema) {}
export class ReversePaymentDto extends createZodDto(ReversePaymentSchema) {}
export class ReceiptLinkResponseDto extends createZodDto(ReceiptLinkSchema) {}
export class ResendReceiptDto extends createZodDto(ResendReceiptSchema) {}
export class ResendReceiptResponseDto extends createZodDto(ResendReceiptResultSchema) {}
export class CreateRefundRequestDto extends createZodDto(CreateRefundRequestSchema) {}
export class RefundRequestResponseDto extends createZodDto(RefundRequestSchema) {}
export class RefundRequestListQueryDto extends createZodDto(RefundRequestListQuerySchema) {}
export class RefundRequestListResponseDto extends createZodDto(RefundRequestListResponseSchema) {}
export class DecideRefundDto extends createZodDto(DecideRefundSchema) {}
export class RejectRefundDto extends createZodDto(RejectRefundSchema) {}
export class PayRefundDto extends createZodDto(PayRefundSchema) {}
export class ReceivablesQueryDto extends createZodDto(ReceivablesQuerySchema) {}
export class ReceivablesResponseDto extends createZodDto(ReceivablesResponseSchema) {}
export class ReceivablesSummaryResponseDto extends createZodDto(ReceivablesSummarySchema) {}
