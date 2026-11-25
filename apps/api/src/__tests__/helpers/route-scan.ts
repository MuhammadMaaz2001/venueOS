import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ModulesContainer } from '@nestjs/core';
import {
  IS_AUTHENTICATED_ONLY_KEY,
  IS_PUBLIC_KEY,
  PERMISSION_KEY,
} from '../../common/access/access.decorators';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

export interface ScannedRoute {
  controller: string;
  handler: string;
  httpMethod: string;
  /** Path below the global `/v1` prefix, e.g. `/venues/:id` (the first path if a handler has several). */
  path: string;
  isPublic: boolean;
  isAuthenticatedOnly: boolean;
  permission: unknown;
}

const firstPath = (value: unknown): string =>
  (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')).replace(/^\/+|\/+$/g, '');

function joinPaths(controllerPath: unknown, handlerPath: unknown): string {
  return `/${[firstPath(controllerPath), firstPath(handlerPath)].filter(Boolean).join('/')}`;
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
      const classAuthOnly = Reflect.getMetadata(IS_AUTHENTICATED_ONLY_KEY, controller) === true;
      const classPermission = Reflect.getMetadata(PERMISSION_KEY, controller) as unknown;

      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        // Read the descriptor: touching a getter on the prototype (a controller's private accessor) would run it.
        const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)
          ?.value as unknown;
        if (typeof handler !== 'function') continue;
        // Only methods mapped to a route (@Get, @Post, ...) are endpoints.
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;

        routes.push({
          controller: controller.name,
          handler: name,
          httpMethod: method === undefined ? '?' : (HTTP_METHODS[method] ?? '?'),
          path: joinPaths(
            Reflect.getMetadata(PATH_METADATA, controller) as unknown,
            Reflect.getMetadata(PATH_METADATA, handler) as unknown,
          ),
          isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true,
          isAuthenticatedOnly:
            classAuthOnly || Reflect.getMetadata(IS_AUTHENTICATED_ONLY_KEY, handler) === true,
          permission: (Reflect.getMetadata(PERMISSION_KEY, handler) as unknown) ?? classPermission,
        });
      }
    }
  }
  return routes;
}

/**
 * Routes that break CLAUDE.md rule 2: exactly one of `@Public()`, `@AuthenticatedOnly()` and
 * `@RequirePermission()` is required.
 */
export function findAccessViolations(routes: readonly ScannedRoute[]): string[] {
  return routes.flatMap((r) => {
    const where = `${r.controller}.${r.handler} (${r.httpMethod})`;
    const markers = [
      r.isPublic ? '@Public()' : null,
      r.isAuthenticatedOnly ? '@AuthenticatedOnly()' : null,
      r.permission !== undefined ? '@RequirePermission()' : null,
    ].filter((m): m is string => m !== null);
    if (markers.length === 0) {
      return [`${where}: none of @Public(), @AuthenticatedOnly(), @RequirePermission()`];
    }
    if (markers.length > 1) return [`${where}: more than one of ${markers.join(', ')}`];
    return [];
  });
}
