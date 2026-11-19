alter table public.photos
  add column telegram_original_id integer check (telegram_original_id > 0),
  add column telegram_preview_id integer check (telegram_preview_id > 0);
alter table public.videos
  add column telegram_cover_id integer check (telegram_cover_id > 0);
