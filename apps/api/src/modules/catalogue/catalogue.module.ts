import { Module } from '@nestjs/common';
import { AddOnsController } from './add-ons.controller';
import { AddOnsService } from './add-ons.service';
import { CustomFieldsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { MenuItemsController } from './menu-items.controller';
import { MenuItemsService } from './menu-items.service';
import { PackagesController } from './packages.controller';
import { PackagesService } from './packages.service';

/** Module 3, catalogue: menu items, packages, add-ons and custom field definitions (all tenant-wide). */
@Module({
  controllers: [MenuItemsController, PackagesController, AddOnsController, CustomFieldsController],
  providers: [MenuItemsService, PackagesService, AddOnsService, CustomFieldsService],
})
export class CatalogueModule {}
