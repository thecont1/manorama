-- Keep RevenueCat webhook application monotonic per account.
-- event IDs break ties when providers deliver multiple events at one timestamp.
ALTER TABLE users ADD COLUMN billing_event_timestamp_ms INTEGER DEFAULT NULL;
ALTER TABLE users ADD COLUMN billing_event_id TEXT DEFAULT NULL;
