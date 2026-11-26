import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

/** Module 6: the availability calendar. */
@Module({ controllers: [AvailabilityController], providers: [AvailabilityService] })
export class AvailabilityModule {}
