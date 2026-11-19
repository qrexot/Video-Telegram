alter table public.videos drop constraint videos_size_bytes_check;
alter table public.videos add constraint videos_size_bytes_check
  check (size_bytes between 1 and 536870912);
