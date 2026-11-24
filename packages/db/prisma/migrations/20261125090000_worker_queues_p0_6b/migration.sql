-- P0-6b: the queues of the jobs added in this task (pdf.render, auth.purge, ops.dead-letter-check).
-- Same convention as 20261123120000_pgboss_jobs_and_email_queue: queues are created by the migrator,
-- never by the worker or the API. No new grants are needed: venueos_jobs already has read/write on every
-- pgboss table (including pgboss.schedule), and venueos_app can enqueue into any queue.
--
-- Dead letters are kept 30 days and never retried; they are inspected and redriven with the reviewed
-- ops script packages/db/scripts/dead-letters.mjs (docs/08-deployment-and-ops.md).
--
-- `short` policy: at most one QUEUED job per singleton key. pdf.render uses `kind:entityId`; the system
-- jobs use a time-slot key so two worker instances never both run the same daily/5-minute pass.

SELECT pgboss.create_queue('pdf.render.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('pdf.render', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":180,"deadLetter":"pdf.render.dead"}'::jsonb);

SELECT pgboss.create_queue('auth.purge.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('auth.purge', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"retryDelayMax":3600,"expireInSeconds":900,"deadLetter":"auth.purge.dead"}'::jsonb);

SELECT pgboss.create_queue('ops.dead-letter-check.dead', '{"policy":"standard","retryLimit":0,"retentionSeconds":2592000,"deleteAfterSeconds":2592000}'::jsonb);
SELECT pgboss.create_queue('ops.dead-letter-check', '{"policy":"short","retryLimit":2,"retryDelay":30,"retryBackoff":true,"retryDelayMax":300,"expireInSeconds":300,"deadLetter":"ops.dead-letter-check.dead"}'::jsonb);
