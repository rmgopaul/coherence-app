-- Task 5.2 — bind invites to a permission preset. When the invitee
-- accepts via Google OAuth, the accept flow snapshots the preset's
-- `permissionsJson` into `solarRecUserModulePermissions`. Nullable so
-- admins can invite without a preset and dial permissions manually.
-- No backfill: existing pending invites stay unbound.

ALTER TABLE `solarRecInvites` ADD `presetId` varchar(64);
