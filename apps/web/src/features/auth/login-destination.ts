/** Where a successful login goes: the page the user wanted, else the workspace picker (no active workspace). */
export function loginDestination(result: { activeTenantId: string | null }, next: string): string {
  // Pages that need a login but no workspace (accepting an invitation) may be reached straight away.
  if (result.activeTenantId || next.startsWith('/accept-invite')) return next;
  return `/select-workspace?next=${encodeURIComponent(next)}`;
}
