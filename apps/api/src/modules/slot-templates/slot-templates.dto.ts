import {
  CreateSlotTemplateSchema,
  IdParamSchema,
  SlotTemplateListQuerySchema,
  SlotTemplateListResponseSchema,
  SlotTemplateSchema,
  UpdateSlotTemplateSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class SlotTemplateResponseDto extends createZodDto(SlotTemplateSchema) {}
export class SlotTemplateListResponseDto extends createZodDto(SlotTemplateListResponseSchema) {}
export class SlotTemplateListQueryDto extends createZodDto(SlotTemplateListQuerySchema) {}
export class SlotTemplateIdParamDto extends createZodDto(IdParamSchema) {}
export class CreateSlotTemplateDto extends createZodDto(CreateSlotTemplateSchema) {}
export class UpdateSlotTemplateDto extends createZodDto(UpdateSlotTemplateSchema) {}
