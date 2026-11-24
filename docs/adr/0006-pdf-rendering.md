# ADR 0006 — PDFs rendered from HTML with headless Chromium

- Status: Accepted · 2026-11-23

## Context
Quotations, receipts and event sheets must render English reliably now (the MVP is English-only) and complex scripts with RTL
(Arabic, for the Gulf market) later. An earlier version of this ADR named Urdu; Urdu was dropped from the MVP.

## Decision
Templates are HTML/CSS in `packages/templates`; the worker renders them to PDF with
Playwright's Chromium and bundled fonts (Noto Sans now; an Arabic family when Arabic is added). Generation is a queued job; files go to S3.

## Consequences
- Correct complex-script shaping (Arabic later) and familiar HTML/CSS for designers.
- The worker image is larger (Chromium); PDF generation is asynchronous.
