-- The demo workspace was removed from the engine; workspaces no longer carry a demo flag.
alter table workspaces drop column if exists is_demo;
