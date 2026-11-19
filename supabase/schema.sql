begin;

create table public.video_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'viewer'))
);

create table public.videos (
  id uuid primary key,
  uploader_id uuid references auth.users (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1200),
  mime_type text not null check (mime_type in ('video/mp4', 'video/webm')),
  size_bytes integer not null check (size_bytes between 1 and 2000000000),
  telegram_message_id integer unique check (telegram_message_id > 0),
  original_id uuid references public.videos(id) on delete cascade,
  quality_height integer,
  constraint videos_variant_quality check (
    (original_id is null and quality_height is null) or
    (original_id is not null and quality_height is not null and quality_height in (360, 480, 720, 1080, 2160) and original_id <> id)
  ),
  unique (original_id, quality_height),
  created_at timestamptz not null default now()
);

create index videos_recent_idx on public.videos (created_at desc, id desc)
  where telegram_message_id is not null;

alter table public.video_members enable row level security;
alter table public.videos enable row level security;
revoke all on public.video_members, public.videos from public, anon, authenticated;
grant select, insert, update, delete on public.video_members, public.videos to service_role;

commit;
