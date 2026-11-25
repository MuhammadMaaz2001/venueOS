import {
  AddOnListQuerySchema,
  AddOnListResponseSchema,
  AddOnSchema,
  CreateAddOnSchema,
  CreateCustomFieldDefSchema,
  CreateMenuItemSchema,
  CreatePackageSchema,
  CustomFieldDefListQuerySchema,
  CustomFieldDefListResponseSchema,
  CustomFieldDefSchema,
  IdParamSchema,
  MenuItemListQuerySchema,
  MenuItemListResponseSchema,
  MenuItemSchema,
  PackageListQuerySchema,
  PackageListResponseSchema,
  PackageSchema,
  UpdateAddOnSchema,
  UpdateCustomFieldDefSchema,
  UpdateMenuItemSchema,
  UpdatePackageSchema,
} from '@venueos/shared';
import { createZodDto } from 'nestjs-zod';

export class CatalogueIdParamDto extends createZodDto(IdParamSchema) {}

export class MenuItemResponseDto extends createZodDto(MenuItemSchema) {}
export class MenuItemListResponseDto extends createZodDto(MenuItemListResponseSchema) {}
export class MenuItemListQueryDto extends createZodDto(MenuItemListQuerySchema) {}
export class CreateMenuItemDto extends createZodDto(CreateMenuItemSchema) {}
export class UpdateMenuItemDto extends createZodDto(UpdateMenuItemSchema) {}

export class PackageResponseDto extends createZodDto(PackageSchema) {}
export class PackageListResponseDto extends createZodDto(PackageListResponseSchema) {}
export class PackageListQueryDto extends createZodDto(PackageListQuerySchema) {}
export class CreatePackageDto extends createZodDto(CreatePackageSchema) {}
export class UpdatePackageDto extends createZodDto(UpdatePackageSchema) {}

export class AddOnResponseDto extends createZodDto(AddOnSchema) {}
export class AddOnListResponseDto extends createZodDto(AddOnListResponseSchema) {}
export class AddOnListQueryDto extends createZodDto(AddOnListQuerySchema) {}
export class CreateAddOnDto extends createZodDto(CreateAddOnSchema) {}
export class UpdateAddOnDto extends createZodDto(UpdateAddOnSchema) {}

export class CustomFieldDefResponseDto extends createZodDto(CustomFieldDefSchema) {}
export class CustomFieldDefListResponseDto extends createZodDto(CustomFieldDefListResponseSchema) {}
export class CustomFieldDefListQueryDto extends createZodDto(CustomFieldDefListQuerySchema) {}
export class CreateCustomFieldDefDto extends createZodDto(CreateCustomFieldDefSchema) {}
export class UpdateCustomFieldDefDto extends createZodDto(UpdateCustomFieldDefSchema) {}
