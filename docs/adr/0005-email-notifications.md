# ADR 0005 — Email-only notifications in the MVP

- Status: Accepted · 2026-11-23

## Context
WhatsApp Business API needs template approval, per-message cost and per-tenant setup. The
team wants to ship the MVP without that dependency.

## Decision
MVP notifications are email (AWS SES behind an `EmailProvider` interface). Quotations and
receipts also get a manual "Share on WhatsApp" button using a `wa.me` link (no API).
`message_templates.channel` stays generic so SMS/WhatsApp can be added without schema changes.

## Consequences
- No messaging cost or approval delays for the pilot.
- Some customers read email less; the wa.me share covers the gap.
