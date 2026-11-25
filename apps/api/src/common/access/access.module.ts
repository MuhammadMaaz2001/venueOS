import { Global, Module } from '@nestjs/common';
import { Caller } from './caller.service';
import { PlanLimits } from './plan-limits.service';
import { VenueScope } from './venue-scope.service';

/**
 * Providers the guards and services share. The guards themselves are registered, in order, in
 * AppModule. The AuthContextProvider (session cookie) is provided by the AuthModule.
 */
@Global()
@Module({
  providers: [VenueScope, PlanLimits, Caller],
  exports: [VenueScope, PlanLimits, Caller],
})
export class AccessModule {}
