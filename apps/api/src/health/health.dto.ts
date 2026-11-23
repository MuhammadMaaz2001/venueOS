import { HealthResponseSchema, ReadyResponseSchema } from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class HealthResponseDto extends createZodDto(HealthResponseSchema) {}
export class ReadyResponseDto extends createZodDto(ReadyResponseSchema) {}
