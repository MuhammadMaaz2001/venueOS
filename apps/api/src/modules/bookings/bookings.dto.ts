import {
  AddSessionSchema,
  BookingDetailSchema,
  BookingListQuerySchema,
  BookingListResponseSchema,
  BookingSessionParamSchema,
  CancelBookingSchema,
  CancelResultSchema,
  CancelSessionSchema,
  ConfirmBookingSchema,
  HoldBookingSchema,
  IdParamSchema,
  RevOnlySchema,
  UpdateBookingSchema,
  UpdateSessionSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class BookingIdParamDto extends createZodDto(IdParamSchema) {}
export class BookingSessionParamDto extends createZodDto(BookingSessionParamSchema) {}
export class BookingDetailResponseDto extends createZodDto(BookingDetailSchema) {}
export class BookingListQueryDto extends createZodDto(BookingListQuerySchema) {}
export class BookingListResponseDto extends createZodDto(BookingListResponseSchema) {}
export class UpdateBookingDto extends createZodDto(UpdateBookingSchema) {}
export class HoldBookingDto extends createZodDto(HoldBookingSchema) {}
export class RevOnlyDto extends createZodDto(RevOnlySchema) {}
export class ConfirmBookingDto extends createZodDto(ConfirmBookingSchema) {}
export class CancelBookingDto extends createZodDto(CancelBookingSchema) {}
export class CancelResultResponseDto extends createZodDto(CancelResultSchema) {}
export class AddSessionDto extends createZodDto(AddSessionSchema) {}
export class UpdateSessionDto extends createZodDto(UpdateSessionSchema) {}
export class CancelSessionDto extends createZodDto(CancelSessionSchema) {}
