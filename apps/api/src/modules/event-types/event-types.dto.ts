import {
  CreateEventTypeSchema,
  EventTypeListQuerySchema,
  EventTypeListResponseSchema,
  EventTypeSchema,
  IdParamSchema,
  UpdateEventTypeSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class EventTypeResponseDto extends createZodDto(EventTypeSchema) {}
export class EventTypeListResponseDto extends createZodDto(EventTypeListResponseSchema) {}
export class EventTypeListQueryDto extends createZodDto(EventTypeListQuerySchema) {}
export class EventTypeIdParamDto extends createZodDto(IdParamSchema) {}
export class CreateEventTypeDto extends createZodDto(CreateEventTypeSchema) {}
export class UpdateEventTypeDto extends createZodDto(UpdateEventTypeSchema) {}
