-- The account's device list replaced the per-gallery label: the mirror rows
-- now name their device by id, and the device's kind lives on `devices`. The
-- label carried the owner's ComputerName, so it goes — no name of any kind is
-- stored on the server.
ALTER TABLE device_galleries DROP COLUMN device_label;
