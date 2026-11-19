alter table public.videos
  add column hidden boolean not null default false,
  add column deleted_at timestamptz,
  add column has_cover boolean not null default false;

create table public.photos (
  id uuid primary key,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1200),
  filename text not null,
  mime_type text not null,
  size_bytes integer not null check (size_bytes between 1 and 26214400),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  hidden boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.photos enable row level security;
revoke all on public.photos from public, anon, authenticated;
grant select, insert, update on public.photos to service_role;
create index photos_recent_idx on public.photos (created_at desc, id desc);
insert into storage.buckets (id, name, public, file_size_limit)
values ('video-library-media', 'video-library-media', false, 26214400);
