-- Add raw_phone and raw_name columns to event_log so the dashboard can
-- display contact details without relying on PII sent to ad platforms.
ALTER TABLE event_log ADD COLUMN raw_phone TEXT;
ALTER TABLE event_log ADD COLUMN raw_name  TEXT;
