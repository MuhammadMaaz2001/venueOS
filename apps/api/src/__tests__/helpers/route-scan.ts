import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ModulesContainer } from '@nestjs/core';
import { IS_PUBLIC_KEY, PERMISSION_KEY } from '../../common/access/access.decorators';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

export interface ScannedRoute {
  controller: string;
  handler: string;
  httpMethod: string;
  isPublic: boolean;
  permission: unknown;
}

/** Every HTTP handler of every controller registered in the application, with its access metadata. */
export function scanRoutes(modules: ModulesContainer): ScannedRoute[] {
  const routes: ScannedRoute[] = [];
  const seen = new Set<unknown>();
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!controller || seen.has(controller)) continue;
      seen.add(controller);

      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
      const classPermission = Reflect.getMetadata(PERMISSION_KEY, controller) as unknown;

      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        // Only methods mapped to a route (@Get, @Post, ...) are endpoints.
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;

        routes.push({
          controller: controller.name,
          handler: name,
          httpMethod: method === undefined ? '?' : (HTTP_METHODS[method] ?? '?'),
          isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
          permission: (Reflect.getMetadata(PERMISSION_KEY, handler) as unknown) ?? classPermission,
        });
      }
    }
  }
  return routes;
}

/** Routes that break CLAUDE.md rule 2: exactly one of `@Public()` and `@RequirePermission()` is required. */
export function findAccessViolations(routes: readonly ScannedRoute[]): string[] {
  return routes.flatMap((r) => {
    const where = `${r.controller}.${r.handler} (${r.httpMethod})`;
    const hasPermission = r.permission !== undefined;
    if (!r.isPublic && !hasPermission)
      return [`${where}: neither @Public() nor @RequirePermission()`];
    if (r.isPublic && hasPermission) return [`${where}: both @Public() and @RequirePermission()`];
    return [];
  });
}
