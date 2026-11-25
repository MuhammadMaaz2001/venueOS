/** Keys in `Audit.actions.*`: dots are not allowed in message keys (`role.update` -> `role_update`). */
export const actionKey = (action: string): string => action.replaceAll('.', '_');

/** Every action the API writes today, in the order the filter lists them (a test keeps them in line with en.json). */
export const AUDIT_ACTIONS: readonly string[] = [
  'tenant.signup',
  'tenant.settings.update',
  'role.create',
  'role.update',
  'role.retire',
  'role.restore',
  'staff.invite',
  'staff.invite.accept',
  'staff.invite.revoke',
  'staff.update',
  'venue.create',
  'venue.update',
  'space.create',
  'space.update',
  'space.slot_prices.replace',
  'slot_template.create',
  'slot_template.update',
  'event_type.create',
  'event_type.update',
  'customer.create',
  'customer.update',
  'customer.deactivate',
  'customer.reactivate',
  'customer.reveal_sensitive',
  'lead.create',
  'lead.update',
  'lead.stage_change',
  'lead.assign',
];

/** The entity types of those actions, for the "what was changed" filter. */
export const AUDIT_ENTITY_TYPES: readonly string[] = [
  'tenant',
  'role',
  'membership',
  'invitation',
  'venue',
  'space',
  'slot_template',
  'event_type',
  'customer',
  'lead',
];
