-- The owner's manual rank inside whichever Library section the gallery
-- sits in — written by a drag reorder, read by libraryLayout ahead of
-- the default order (pin date for strips, arrival for compact). NULL
-- keeps the default and sorts after every positioned sibling.
ALTER TABLE galleries ADD COLUMN position REAL;
