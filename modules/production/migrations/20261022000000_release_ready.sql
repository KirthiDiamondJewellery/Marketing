-- Production: an approved video can wait as "ready" (approved, not scheduled). It shows on the calendar under
-- "Ready to post" until the owner schedules it, downloads it to post by hand, or leaves it.
alter table production_releases drop constraint if exists production_releases_status_check;
alter table production_releases add constraint production_releases_status_check
  check (status in ('proposed', 'ready', 'approved', 'scheduling', 'scheduled', 'partial', 'failed'));
