import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, actionKey } from './labels';

const actions = en.Audit.actions as Record<string, string>;
const entityTypes = en.Audit.entityTypes as Record<string, string>;

describe('audit labels', () => {
  it('every action the filter offers has a human label, and nothing is labelled twice', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(actions[actionKey(action)], action).toBeTruthy();
      expect(actions[actionKey(action)], action).not.toBe(action);
    }
    expect(Object.keys(actions).sort()).toEqual(AUDIT_ACTIONS.map(actionKey).sort());
  });

  it('every entity type of the filter has a label', () => {
    for (const type of AUDIT_ENTITY_TYPES) expect(entityTypes[type], type).toBeTruthy();
  });

  it('action keys contain no dots', () => {
    for (const action of AUDIT_ACTIONS) expect(actionKey(action)).not.toContain('.');
  });
});
