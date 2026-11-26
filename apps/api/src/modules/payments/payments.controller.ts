import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type {
  PaymentDto,
  PaymentsOverviewDto,
  ReceiptLinkDto,
  ReceivablesResponse,
  ReceivablesSummaryDto,
  RefundRequestDto,
  RefundRequestListResponse,
} from '@venueos/shared';
import type { Response } from 'express';
import { RequirePermission } from '../../common/access/access.decorators';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  BouncePaymentDto,
  CreateRefundRequestDto,
  DecideRefundDto,
  IdParamDto,
  PayRefundDto,
  PaymentResponseDto,
  PaymentsOverviewResponseDto,
  ReceiptLinkResponseDto,
  ReceivablesQueryDto,
  ReceivablesResponseDto,
  ReceivablesSummaryResponseDto,
  RecordPaymentDto,
  RefundRequestListQueryDto,
  RefundRequestListResponseDto,
  RefundRequestResponseDto,
  RejectRefundDto,
  ReplaceScheduleDto,
  ResendReceiptDto,
  ResendReceiptResponseDto,
  ReversePaymentDto,
} from './payments.dto';
import { PaymentsService } from './payments.service';
import { ReceivablesService } from './receivables.service';
import { RefundsService } from './refunds.service';

const IDEMPOTENCY = {
  name: 'Idempotency-Key',
  required: true,
  description:
    'A client-made key (8-100 letters, digits or _ . : -). A retry with the same key returns the first result (200 instead of 201); the same key with a different request is 409 IDEMPOTENCY_CONFLICT.',
};

/** The Payments tab of a booking: totals, schedule, entries; recording, the schedule, and refund requests. */
@ApiTags('payments')
@Controller('bookings')
export class BookingPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  @Get(':id/payments')
  @RequirePermission('payment.view')
  @ApiOperation({
    summary: 'Totals, payment schedule, entries and refund requests of a booking',
    description:
      'The schedule items carry their FIFO status (PAID, PARTLY, UNPAID, OVERDUE) from the cleared receipts. `summary.readyToConfirm` is true while the hold is open and the advance is in; nothing confirms by itself.',
  })
  @ApiOkResponse({ type: PaymentsOverviewResponseDto })
  overview(@Param() params: IdParamDto): Promise<PaymentsOverviewDto> {
    return this.payments.overview(params.id);
  }

  @Post(':id/payments')
  @RequirePermission('payment.record')
  @ApiHeader(IDEMPOTENCY)
  @ApiOperation({
    summary: 'Record a payment received',
    description:
      'A RECEIPT. Cash, bank transfer, card and wallet are CLEARED at once; a cheque is PENDING until it is cleared. The receipt number comes from the workspace counter and the receipt PDF is made in the background. An overpayment is allowed and shown as credit.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiOkResponse({
    description: 'A retry with the same Idempotency-Key: the first result',
    type: PaymentResponseDto,
  })
  async record(
    @Param() params: IdParamDto,
    @Body() body: RecordPaymentDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const result = await this.payments.record(params.id, body, key);
    if (result.replay) res.status(200);
    return result.payment;
  }

  @Put(':id/payment-schedule')
  @RequirePermission('payment.record')
  @ApiOperation({
    summary: 'Replace the payment schedule',
    description:
      'The items must add up to the grand total. Allowed while the slot is held or the booking is confirmed.',
  })
  @ApiOkResponse({ type: PaymentsOverviewResponseDto })
  replaceSchedule(
    @Param() params: IdParamDto,
    @Body() body: ReplaceScheduleDto,
  ): Promise<PaymentsOverviewDto> {
    return this.payments.replaceSchedule(params.id, body);
  }

  @Post(':id/refund-requests')
  @RequirePermission('payment.refund.request')
  @ApiHeader(IDEMPOTENCY)
  @ApiOperation({
    summary: 'Ask for a refund',
    description:
      'The amount cannot be more than what is paid and not yet requested. Someone with payment.refund.approve decides; the booking page pre-fills the suggested refund of a cancelled booking.',
  })
  @ApiCreatedResponse({ type: RefundRequestResponseDto })
  @ApiOkResponse({
    description: 'A retry with the same Idempotency-Key: the first result',
    type: RefundRequestResponseDto,
  })
  async requestRefund(
    @Param() params: IdParamDto,
    @Body() body: CreateRefundRequestDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefundRequestDto> {
    const result = await this.refunds.create(params.id, body, key);
    if (result.replay) res.status(200);
    return result.request;
  }
}

/** One payment entry: cheque clearing, reversal, the receipt. */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':id/clear')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary: 'A pending cheque cleared',
    description:
      'PENDING -> CLEARED; it counts towards the paid total from now on and the receipt is sent. A refund cheque completes its refund request.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  clear(@Param() params: IdParamDto): Promise<PaymentDto> {
    return this.payments.clear(params.id);
  }

  @Post(':id/bounce')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary: 'A cheque bounced',
    description:
      'PENDING or CLEARED -> BOUNCED. A bounced receipt stops counting, which lowers the paid total.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  bounce(@Param() params: IdParamDto, @Body() body: BouncePaymentDto): Promise<PaymentDto> {
    return this.payments.bounce(params.id, body);
  }

  @Post(':id/reverse')
  @RequirePermission('payment.reverse')
  @ApiHeader(IDEMPOTENCY)
  @ApiOperation({
    summary: 'Reverse a wrong entry',
    description:
      'Writes a REVERSAL entry that points to the original (a reason is required); the original is never changed and can be reversed once. Only a cleared receipt can be reversed.',
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  @ApiOkResponse({
    description: 'A retry with the same Idempotency-Key: the first result',
    type: PaymentResponseDto,
  })
  async reverse(
    @Param() params: IdParamDto,
    @Body() body: ReversePaymentDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const result = await this.payments.reverse(params.id, body, key);
    if (result.replay) res.status(200);
    return result.payment;
  }

  @Get(':id/receipt')
  @RequirePermission('payment.view')
  @ApiOperation({
    summary: 'A pre-signed link to the receipt PDF (valid 5 minutes)',
    description: '422 while the PDF is still being prepared.',
  })
  @ApiOkResponse({ type: ReceiptLinkResponseDto })
  receipt(@Param() params: IdParamDto): Promise<ReceiptLinkDto> {
    return this.payments.receiptLink(params.id);
  }

  @Post(':id/receipt/resend')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({
    summary: 'Send the receipt to the customer again',
    description:
      "To the customer's email address, or to `to`. The PDF is attached. 422 for a payment that has not cleared.",
  })
  @ApiOkResponse({ type: ResendReceiptResponseDto })
  resend(@Param() params: IdParamDto, @Body() body: ResendReceiptDto): Promise<{ to: string }> {
    return this.payments.resendReceipt(params.id, body);
  }
}

/** The refund queue: decide and pay out. */
@ApiTags('payments')
@Controller('refund-requests')
export class RefundRequestsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @RequirePermission('payment.view')
  @ApiOperation({
    summary: 'Refund requests, newest first',
    description: "Filters: status, bookingId. Cursor pagination. Only the caller's venues.",
  })
  @ApiOkResponse({ type: RefundRequestListResponseDto })
  list(@Query() query: RefundRequestListQueryDto): Promise<RefundRequestListResponse> {
    return this.refunds.list(query);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('payment.refund.approve')
  @ApiOperation({
    summary: 'Approve a refund request',
    description:
      'Someone other than the requester. A workspace with exactly one active member who may approve refunds can approve its own request (`selfApproved`, audited).',
  })
  @ApiOkResponse({ type: RefundRequestResponseDto })
  approve(@Param() params: IdParamDto, @Body() body: DecideRefundDto): Promise<RefundRequestDto> {
    return this.refunds.approve(params.id, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('payment.refund.approve')
  @ApiOperation({
    summary: 'Reject a refund request',
    description: 'A note with the reason is required.',
  })
  @ApiOkResponse({ type: RefundRequestResponseDto })
  reject(@Param() params: IdParamDto, @Body() body: RejectRefundDto): Promise<RefundRequestDto> {
    return this.refunds.reject(params.id, body);
  }

  @Post(':id/pay')
  @RequirePermission('payment.record')
  @ApiHeader(IDEMPOTENCY)
  @ApiOperation({
    summary: 'Mark an approved refund as paid out',
    description:
      'Writes the REFUND payment with the method used: CLEARED at once, or PENDING for a cheque (the request stays APPROVED until the cheque is cleared).',
  })
  @ApiCreatedResponse({ type: RefundRequestResponseDto })
  @ApiOkResponse({
    description: 'A retry with the same Idempotency-Key: the first result',
    type: RefundRequestResponseDto,
  })
  async pay(
    @Param() params: IdParamDto,
    @Body() body: PayRefundDto,
    @IdempotencyKey() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefundRequestDto> {
    const result = await this.refunds.pay(params.id, body, key);
    if (result.replay) res.status(200);
    return result.request;
  }
}

/** Money still owed on confirmed and completed bookings. */
@ApiTags('payments')
@Controller('receivables')
export class ReceivablesController {
  constructor(private readonly receivables: ReceivablesService) {}

  @Get()
  @RequirePermission('payment.view')
  @ApiOperation({
    summary: 'Bookings with a balance due, overdue first',
    description: 'Filters: venueId, from / to (next due date), overdue=true. Cursor pagination.',
  })
  @ApiOkResponse({ type: ReceivablesResponseDto })
  list(@Query() query: ReceivablesQueryDto): Promise<ReceivablesResponse> {
    return this.receivables.list(query);
  }

  @Get('summary')
  @RequirePermission('payment.view')
  @ApiOperation({
    summary: 'Due this week, overdue and outstanding (the dashboard cards)',
  })
  @ApiOkResponse({ type: ReceivablesSummaryResponseDto })
  summary(): Promise<ReceivablesSummaryDto> {
    return this.receivables.summary();
  }
}
