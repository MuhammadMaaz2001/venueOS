import { Global, Module } from '@nestjs/common';
import { AuthContextProvider, NoAuthContextProvider } from './auth-context.provider';
import { VenueScope } from './venue-scope.service';

/**
 * Providers the guards and services share. The guards themselves are registered, in order, in
 * AppModule. P0-4 replaces `NoAuthContextProvider` here with the session-based provider.
 */
@Global()
@Module({
  providers: [{ provide: AuthContextProvider, useClass: NoAuthContextProvider }, VenueScope],
  exports: [AuthContextProvider, VenueScope],
})
export class AccessModule {}
