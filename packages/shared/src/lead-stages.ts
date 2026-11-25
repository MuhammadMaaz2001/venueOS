import { z } from 'zod';

// Lead stages and their rules (docs/05 section 12). Pure functions, shared by the API and the web app, and reused by the
// quotation module (creating a quotation moves the lead to QUOTED) and the booking module (confirming moves it to WON).

export const LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'SITE_VISIT',
  'QUOTED',
  'NEGOTIATION',
  'WON',
  'LOST',
] as const;
export const LeadStageSchema = z.enum(LEAD_STAGES);
export type LeadStage = z.infer<typeof LeadStageSchema>;

/** The stages a lead is being worked in: they need a next follow-up. */
export const OPEN_LEAD_STAGES = [
  'NEW',
  'CONTACTED',
  'SITE_VISIT',
  'QUOTED',
  'NEGOTIATION',
] as const;
export type OpenLeadStage = (typeof OPEN_LEAD_STAGES)[number];

export const isOpenLeadStage = (stage: LeadStage): stage is OpenLeadStage =>
  stage !== 'WON' && stage !== 'LOST';

/** Where the inquiry came from (docs/01 module 5: phone, walk-in, WhatsApp, web form). */
export const LEAD_SOURCES = ['walk_in', 'phone', 'whatsapp', 'web', 'referral', 'other'] as const;
export const LeadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export type LeadStageChange =
  | { allowed: true; kind: 'move' | 'close' | 'reopen' }
  | { allowed: false; reason: 'SAME_STAGE' | 'WON_IS_FINAL' | 'REOPEN_FIRST' };

/**
 * Whether a lead may go from one stage to another.
 *
 * - Between open stages in any direction (the board lets a card go back as well as forward).
 * - To `LOST` from any open stage (needs a reason, checked by the caller) and to `WON` from any open stage. `WON` and
 *   `QUOTED` are set by the booking and quotation modules once they exist; until then staff set them by hand.
 * - `LOST` can be reopened to an open stage (the customer came back); it cannot jump to `WON`.
 * - `WON` is final: a booking exists, so it is not reopened or lost.
 */
export function checkLeadStageChange(from: LeadStage, to: LeadStage): LeadStageChange {
  if (from === to) return { allowed: false, reason: 'SAME_STAGE' };
  if (from === 'WON') return { allowed: false, reason: 'WON_IS_FINAL' };
  if (from === 'LOST') {
    return isOpenLeadStage(to)
      ? { allowed: true, kind: 'reopen' }
      : { allowed: false, reason: 'REOPEN_FIRST' };
  }
  return { allowed: true, kind: isOpenLeadStage(to) ? 'move' : 'close' };
}

/** The sentence the API answers (422) for a refused change. */
export const LEAD_STAGE_CHANGE_MESSAGES = {
  SAME_STAGE: 'The lead is already in this stage.',
  WON_IS_FINAL: 'A won lead cannot change stage.',
  REOPEN_FIRST: 'Reopen a lost lead before changing its stage again.',
} as const;

/** English names for emails (the web app has its own translated labels). */
export const LEAD_STAGE_LABELS: Readonly<Record<LeadStage, string>> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  SITE_VISIT: 'Site visit',
  QUOTED: 'Quoted',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
};

export const LEAD_SOURCE_LABELS: Readonly<Record<LeadSource, string>> = {
  walk_in: 'Walk-in',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  web: 'Web form',
  referral: 'Referral',
  other: 'Other',
};
