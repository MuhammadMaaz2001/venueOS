# ADR 0006 — PDFs rendered from HTML with headless Chromium

- Status: Accepted · 2026-11-23

## Context
Quotations, receipts and event sheets must render Urdu (complex script shaping, RTL) and
English reliably.

## Decision
Templates are HTML/CSS in `packages/templates`; the worker renders them to PDF with
Playwright's Chromium and bundled Urdu fonts. Generation is a queued job; files go to S3.

## Consequences
- Correct Urdu shaping and familiar HTML/CSS for designers.
- The worker image is larger (Chromium); PDF generation is asynchronous.
