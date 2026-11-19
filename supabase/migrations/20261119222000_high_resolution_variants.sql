alter table public.videos
  drop constraint videos_variant_quality,
  add constraint videos_variant_quality check (
    (original_id is null and quality_height is null) or
    (original_id is not null and quality_height is not null and quality_height in (360, 480, 720, 1080, 2160) and original_id <> id)
  );
