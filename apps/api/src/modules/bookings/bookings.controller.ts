import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BookingDetailDto, BookingListResponse, CancelResultDto } from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  AddSessionDto,
  BookingDetailResponseDto,
  BookingIdParamDto,
  BookingListQueryDto,
  BookingListResponseDto,
  BookingSessionParamDto,
  CancelBookingDto,
  CancelResultResponseDto,
  CancelSessionDto,
  ConfirmBookingDto,
  HoldBookingDto,
  RevOnlyDto,
  UpdateBookingDto,
  UpdateSessionDto,
} from './bookings.dto';
import { BookingsService } from './bookings.service';

/**
 * Bookings (docs/01 module 8). Venue scoped. Prices are `null` without `booking.view_prices`. Every action sends the booking's
 * `rev`; a stale one is 409 VERSION_CONFLICT.
 */
@ApiTags('bookings')
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @RequirePermission('booking.view')
  @ApiOperation({
    summary: 'List bookings and quotations, newest first',
    description:
      'Filters: status, venueId, customerId, leadId, from / to (a session starts in the range, workspace time zone), search (number, customer name or phone). Cursor pagination.',
  })
  @ApiOkResponse({ type: BookingListResponseDto })
  list(@Query() query: BookingListQueryDto): Promise<BookingListResponse> {
    return this.bookings.list(query);
  }

  @Get(':id')
  @RequirePermission('booking.view')
  @ApiOperation({
    summary: 'One booking: sessions, line items, versions and timeline',
    description: 'A booking of another venue or workspace is 404.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  get(@Param() params: BookingIdParamDto): Promise<BookingDetailDto> {
    return this.bookings.get(params.id);
  }

  @Patch(':id')
  @HttpCode(200)
  @RequirePermission('booking.edit')
  @ApiOperation({
    summary: 'Change notes, policy, discount or (a DRAFT) the sessions',
    description:
      '`rev` is required. A priced change writes a new quotation version (an unsent draft is re-priced in place); a held or confirmed booking is re-priced at its frozen rates unless `requote: CURRENT`. A discount above your role limit is 403 DISCOUNT_LIMIT.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  update(
    @Param() params: BookingIdParamDto,
    @Body() body: UpdateBookingDto,
  ): Promise<BookingDetailDto> {
    return this.bookings.update(params.id, body);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @RequirePermission('booking.hold')
  @ApiOperation({
    summary: 'Hold the dates: DRAFT -> TENTATIVE',
    description:
      'Blocks the calendar (every component of a combined space, with buffers), numbers the booking, starts the hold timer. A taken slot is 409 SLOT_TAKEN (the database decides). A broken venue rule is 422 LOCAL_RULE unless `overrideRules` with `booking.override_rules` and a reason.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  hold(
    @Param() params: BookingIdParamDto,
    @Body() body: HoldBookingDto,
  ): Promise<BookingDetailDto> {
    return this.bookings.hold(params.id, body);
  }

  @Post(':id/extend-hold')
  @HttpCode(200)
  @RequirePermission('booking.hold')
  @ApiOperation({
    summary: 'Extend the hold by the hold duration',
    description: 'Once for anyone who may hold; further extensions need `booking.extend_hold`.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  extend(@Param() params: BookingIdParamDto, @Body() body: RevOnlyDto): Promise<BookingDetailDto> {
    return this.bookings.extendHold(params.id, body);
  }

  @Post(':id/rehold')
  @HttpCode(200)
  @RequirePermission('booking.hold')
  @ApiOperation({
    summary: 'Hold an EXPIRED booking again',
    description: '409 SLOT_TAKEN when somebody took the slot meanwhile.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  rehold(@Param() params: BookingIdParamDto, @Body() body: RevOnlyDto): Promise<BookingDetailDto> {
    return this.bookings.rehold(params.id, body);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermission('booking.confirm')
  @ApiOperation({
    summary: 'Confirm: TENTATIVE -> CONFIRMED',
    description:
      'Needs the advance (cleared receipts of the advance percentage of the total): else 422 ADVANCE_REQUIRED, unless `override` with `booking.confirm_override` and a reason (audited). The lead becomes WON.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  confirm(
    @Param() params: BookingIdParamDto,
    @Body() body: ConfirmBookingDto,
  ): Promise<BookingDetailDto> {
    return this.bookings.confirm(params.id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('booking.cancel')
  @ApiOperation({
    summary: 'Cancel with a reason',
    description:
      'Frees the calendar. The answer carries the refund the cancellation policy snapshot suggests (executing refunds is the payments module).',
  })
  @ApiOkResponse({ type: CancelResultResponseDto })
  cancel(
    @Param() params: BookingIdParamDto,
    @Body() body: CancelBookingDto,
  ): Promise<CancelResultDto> {
    return this.bookings.cancel(params.id, body);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('booking.cancel')
  @ApiOperation({
    summary: 'Restore a CANCELLED booking to the status it was cancelled from',
    description: '409 SLOT_TAKEN when the slot is taken meanwhile.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  restore(@Param() params: BookingIdParamDto, @Body() body: RevOnlyDto): Promise<BookingDetailDto> {
    return this.bookings.restore(params.id, body);
  }

  @Post(':id/sessions')
  @RequirePermission('booking.edit')
  @ApiOperation({
    summary: 'Add a session',
    description:
      'Re-prices the booking (new version). Inside the guest lock window it needs `booking.edit_locked`.',
  })
  @ApiCreatedResponse({ type: BookingDetailResponseDto })
  addSession(
    @Param() params: BookingIdParamDto,
    @Body() body: AddSessionDto,
  ): Promise<BookingDetailDto> {
    return this.bookings.addSession(params.id, body);
  }

  @Patch(':id/sessions/:sessionId')
  @HttpCode(200)
  @RequirePermission('booking.edit')
  @ApiOperation({
    summary: 'Change a session (guests, add-ons, notes, date, space, slot)',
    description:
      'Re-prices at the frozen rates (guests below the guarantee never reduce the bill) unless `requote: CURRENT`. New dates or spaces must be free: 409 SLOT_TAKEN.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  updateSession(
    @Param() params: BookingSessionParamDto,
    @Body() body: UpdateSessionDto,
  ): Promise<BookingDetailDto> {
    return this.bookings.updateSession(params.id, params.sessionId, body);
  }

  @Post(':id/sessions/:sessionId/cancel')
  @HttpCode(200)
  @RequirePermission('booking.edit')
  @ApiOperation({
    summary: 'Cancel one session (soft: it stays on record)',
    description:
      'Releases its calendar slot and re-prices without it. The last session cannot be cancelled this way.',
  })
  @ApiOkResponse({ type: BookingDetailResponseDto })
  cancelSession(
    @Param() params: BookingSessionParamDto,
    @Body() body: CancelSessionDto,
  ): Promise<BookingDetailDto> {
    return this.bookings.cancelSession(params.id, params.sessionId, body);
  }
}
