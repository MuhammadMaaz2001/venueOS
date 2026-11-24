import {
  CreateVenueSchema,
  IdParamSchema,
  UpdateVenueSchema,
  VenueListQuerySchema,
  VenueListResponseSchema,
  VenueSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class VenueResponseDto extends createZodDto(VenueSchema) {}
export class VenueListResponseDto extends createZodDto(VenueListResponseSchema) {}
export class VenueListQueryDto extends createZodDto(VenueListQuerySchema) {}
export class VenueIdParamDto extends createZodDto(IdParamSchema) {}
export class CreateVenueDto extends createZodDto(CreateVenueSchema) {}
export class UpdateVenueDto extends createZodDto(UpdateVenueSchema) {}
