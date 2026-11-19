alter table public.videos
  add column original_id uuid references public.videos(id) on delete cascade,
  add column quality_height integer,
  add constraint videos_variant_quality check (
    (original_id is null and quality_height is null) or
    (original_id is not null and quality_height is not null and quality_height in (360, 480, 720) and original_id <> id)
  ),
  add unique (original_id, quality_height);
