import { Module } from '@nestjs/common';
import { CancellationPoliciesController } from './cancellation-policies.controller';
import { CancellationPoliciesService } from './cancellation-policies.service';
import { PriceRulesController } from './price-rules.controller';
import { PriceRulesService } from './price-rules.service';
import { RentPreviewService } from './rent-preview.service';
import { TaxRatesController } from './tax-rates.controller';
import { TaxRatesService } from './tax-rates.service';

/** Module 3, pricing: price rules, rent preview, tax rates and cancellation policies. */
@Module({
  controllers: [PriceRulesController, TaxRatesController, CancellationPoliciesController],
  providers: [PriceRulesService, RentPreviewService, TaxRatesService, CancellationPoliciesService],
})
export class PricingModule {}
