import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  QuotationDto,
  QuotationListResponse,
  QuotationPdfDto,
  QuotationWhatsAppDto,
  QuotePreviewDto,
  SendQuotationResultDto,
} from '@venueos/shared';
import { RequirePermission } from '../../common/access/access.decorators';
import {
  CreateQuotationDto,
  QuotationIdParamDto,
  QuotationListQueryDto,
  QuotationListResponseDto,
  QuotationPdfResponseDto,
  QuotationResponseDto,
  QuotationWhatsAppResponseDto,
  QuoteInputDto,
  QuotePreviewResponseDto,
  SendQuotationDto,
  SendQuotationResponseDto,
} from './quotations.dto';
import { QuotationsService } from './quotations.service';

/** Quotations (docs/01 module 7). A priced document: callers need `booking.view_prices` as well as the permission of the route. */
@ApiTags('quotations')
@Controller('quotations')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  // Fixed paths before `:id`.
  @Post('preview')
  @HttpCode(200)
  @RequirePermission('quotation.manage')
  @ApiOperation({
    summary: 'Price a quotation without saving it',
    description:
      'The live breakdown of the builder: rent and price rules, package, add-ons, discount (within your role limit, else 403 DISCOUNT_LIMIT) and tax, with warnings for taken slots and broken venue rules. The client sends ids and quantities only.',
  })
  @ApiOkResponse({ type: QuotePreviewResponseDto })
  preview(@Body() body: QuoteInputDto): Promise<QuotePreviewDto> {
    return this.quotations.preview(body);
  }

  @Post()
  @RequirePermission('quotation.manage')
  @ApiOperation({
    summary: 'Create a quotation (a DRAFT booking with its first version)',
    description:
      'Give a customer or a lead (which moves to QUOTED). Numbered {prefix}-Q-{year}-{seq}; the PDF is rendered in the background (`pdfReady`).',
  })
  @ApiCreatedResponse({ type: QuotationResponseDto })
  create(@Body() body: CreateQuotationDto): Promise<QuotationDto> {
    return this.quotations.create(body);
  }

  @Get()
  @RequirePermission('quotation.manage')
  @ApiOperation({ summary: 'List quotation versions, newest first' })
  @ApiOkResponse({ type: QuotationListResponseDto })
  list(@Query() query: QuotationListQueryDto): Promise<QuotationListResponse> {
    return this.quotations.list(query);
  }

  @Get(':id')
  @RequirePermission('quotation.manage')
  @ApiOkResponse({ type: QuotationResponseDto })
  get(@Param() params: QuotationIdParamDto): Promise<QuotationDto> {
    return this.quotations.get(params.id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @RequirePermission('quotation.send')
  @ApiOperation({
    summary: 'Email the quotation with its PDF attached',
    description:
      'To the customer address, or `to`. Only the newest version; 422 while the PDF is still being prepared.',
  })
  @ApiOkResponse({ type: SendQuotationResponseDto })
  send(
    @Param() params: QuotationIdParamDto,
    @Body() body: SendQuotationDto,
  ): Promise<SendQuotationResultDto> {
    return this.quotations.send(params.id, body);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermission('quotation.manage')
  @ApiOperation({ summary: 'Record that the customer accepted this version' })
  @ApiOkResponse({ type: QuotationResponseDto })
  accept(@Param() params: QuotationIdParamDto): Promise<QuotationDto> {
    return this.quotations.accept(params.id);
  }

  @Get(':id/pdf')
  @RequirePermission('quotation.manage')
  @ApiOperation({
    summary: 'A pre-signed link to the PDF (valid 5 minutes)',
    description: '422 while the PDF is still being prepared.',
  })
  @ApiOkResponse({ type: QuotationPdfResponseDto })
  pdf(@Param() params: QuotationIdParamDto): Promise<QuotationPdfDto> {
    return this.quotations.pdf(params.id);
  }

  @Get(':id/whatsapp')
  @RequirePermission('quotation.send')
  @ApiOperation({
    summary: 'A wa.me link with a text summary',
    description: 'Text only: no link to the PDF, which stays private.',
  })
  @ApiOkResponse({ type: QuotationWhatsAppResponseDto })
  whatsapp(@Param() params: QuotationIdParamDto): Promise<QuotationWhatsAppDto> {
    return this.quotations.whatsapp(params.id);
  }
}
