import {
  CreateSpaceSchema,
  IdParamSchema,
  ReplaceSpaceSlotPricesSchema,
  SpaceListQuerySchema,
  SpaceListResponseSchema,
  SpaceSchema,
  SpaceSlotPricesResponseSchema,
  UpdateSpaceSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class SpaceResponseDto extends createZodDto(SpaceSchema) {}
export class SpaceListResponseDto extends createZodDto(SpaceListResponseSchema) {}
export class SpaceListQueryDto extends createZodDto(SpaceListQuerySchema) {}
export class SpaceIdParamDto extends createZodDto(IdParamSchema) {}
export class CreateSpaceDto extends createZodDto(CreateSpaceSchema) {}
export class UpdateSpaceDto extends createZodDto(UpdateSpaceSchema) {}
export class SpaceSlotPricesResponseDto extends createZodDto(SpaceSlotPricesResponseSchema) {}
export class ReplaceSpaceSlotPricesDto extends createZodDto(ReplaceSpaceSlotPricesSchema) {}
