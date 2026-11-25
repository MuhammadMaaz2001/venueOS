import { Module } from '@nestjs/common';
import { SlotTemplatesController } from './slot-templates.controller';
import { SlotTemplatesService } from './slot-templates.service';

@Module({ controllers: [SlotTemplatesController], providers: [SlotTemplatesService] })
export class SlotTemplatesModule {}
