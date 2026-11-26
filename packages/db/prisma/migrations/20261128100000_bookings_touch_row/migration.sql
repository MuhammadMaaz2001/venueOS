-- The worker stamps `bookings.hold_warned_at` when it sends the "hold expiring soon" email. That is bookkeeping, not an edit:
-- like `leads.follow_up_notified_for`, it must not bump `rev` or `updated_at`, or the booking somebody has open would go
-- stale (409 VERSION_CONFLICT) because of an email. Every other change still bumps both.

CREATE OR REPLACE FUNCTION touch_row_bookings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := COALESCE(NEW.updated_at, now());
  ELSIF (to_jsonb(NEW) - 'hold_warned_at' - 'rev' - 'updated_at')
        IS NOT DISTINCT FROM (to_jsonb(OLD) - 'hold_warned_at' - 'rev' - 'updated_at') THEN
    NEW.rev := OLD.rev;
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.rev := OLD.rev + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS touch_row ON "bookings";
CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION touch_row_bookings();
