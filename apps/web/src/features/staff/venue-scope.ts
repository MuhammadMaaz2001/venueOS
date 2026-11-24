/**
 * The venue scope an invitation carries: the inviter's own, always.
 *
 * `[]` means "all venues", so it is sent only by an inviter who has all venues. Someone limited to venues A and
 * B sends exactly `[A, B]`, never `[]`: the API refuses a wider scope (403) and so must the form never offer it
 * (docs/04-security.md section 2: nobody grants more than they hold).
 */
export function inviteVenueScope(inviterVenueIds: readonly string[]): string[] {
  return [...new Set(inviterVenueIds)];
}
