create table public.video_telegram_setup (
  user_id uuid primary key references auth.users (id) on delete cascade,
  encrypted_state text not null,
  revision integer not null default 0
);

alter table public.video_telegram_setup enable row level security;
revoke all on public.video_telegram_setup from public, anon, authenticated;
grant select, insert, update on public.video_telegram_setup to service_role;
