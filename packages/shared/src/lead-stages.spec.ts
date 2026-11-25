import { describe, expect, it } from 'vitest';
import {
  LEAD_STAGES,
  OPEN_LEAD_STAGES,
  checkLeadStageChange,
  isOpenLeadStage,
} from './lead-stages.js';

describe('lead stages', () => {
  it('lists the stages of docs/05 section 12 in order', () => {
    expect(LEAD_STAGES).toEqual([
      'NEW',
      'CONTACTED',
      'SITE_VISIT',
      'QUOTED',
      'NEGOTIATION',
      'WON',
      'LOST',
    ]);
    expect(OPEN_LEAD_STAGES.every(isOpenLeadStage)).toBe(true);
    expect(isOpenLeadStage('WON')).toBe(false);
    expect(isOpenLeadStage('LOST')).toBe(false);
  });

  it('moves between open stages in both directions', () => {
    expect(checkLeadStageChange('NEW', 'CONTACTED')).toEqual({ allowed: true, kind: 'move' });
    expect(checkLeadStageChange('NEW', 'NEGOTIATION')).toEqual({ allowed: true, kind: 'move' });
    expect(checkLeadStageChange('QUOTED', 'SITE_VISIT')).toEqual({ allowed: true, kind: 'move' });
  });

  it('closes an open lead as won or lost', () => {
    expect(checkLeadStageChange('NEGOTIATION', 'WON')).toEqual({ allowed: true, kind: 'close' });
    expect(checkLeadStageChange('NEW', 'LOST')).toEqual({ allowed: true, kind: 'close' });
  });

  it('reopens a lost lead to an open stage only', () => {
    expect(checkLeadStageChange('LOST', 'CONTACTED')).toEqual({ allowed: true, kind: 'reopen' });
    expect(checkLeadStageChange('LOST', 'WON')).toEqual({ allowed: false, reason: 'REOPEN_FIRST' });
  });

  it('refuses to change a won lead or to stay put', () => {
    for (const to of LEAD_STAGES.filter((s) => s !== 'WON')) {
      expect(checkLeadStageChange('WON', to)).toEqual({ allowed: false, reason: 'WON_IS_FINAL' });
    }
    expect(checkLeadStageChange('NEW', 'NEW')).toEqual({ allowed: false, reason: 'SAME_STAGE' });
    expect(checkLeadStageChange('WON', 'WON')).toEqual({ allowed: false, reason: 'SAME_STAGE' });
  });
});
