import { ClsModule } from 'nestjs-cls';
import type { RequestWithId } from '../request-id/request-id';

/** Mounts the CLS middleware and seeds the (otherwise empty) `RequestContext`. */
export const contextModule = ClsModule.forRoot({
  global: true,
  middleware: {
    mount: true,
    setup: (cls, req: RequestWithId) => {
      cls.set('requestId', req.id ?? '');
      cls.set('ip', (req as { ip?: string }).ip);
    },
  },
});
