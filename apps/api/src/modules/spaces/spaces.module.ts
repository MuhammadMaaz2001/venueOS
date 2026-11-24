import { Module } from '@nestjs/common';
import { SpaceSlotPricesService } from './space-slot-prices.service';
import { SpacesController } from './spaces.controller';
import { SpacesService } from './spaces.service';

@Module({ controllers: [SpacesController], providers: [SpacesService, SpaceSlotPricesService] })
export class SpacesModule {}
