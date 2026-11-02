-- A Visionary owner can pin galleries to the top of the Library; the
-- timestamp (not a flag) carries pin order, oldest pin first. NULL means
-- unpinned and stays the default.
ALTER TABLE galleries ADD COLUMN pinned_at TEXT DEFAULT NULL;
