-- Gallery source freshness: the timestamp of the last completed change
-- probe for this gallery's provider source. Owner Library loads fire probes
-- only for galleries whose check is older than the probe interval; a manual
-- refresh stamps it too, since a rescan is itself a source read.
-- NULL means the source has never been probed (or the row predates the
-- feature) — those galleries are due on the next Library load.
ALTER TABLE galleries ADD COLUMN last_source_check_at TEXT;
