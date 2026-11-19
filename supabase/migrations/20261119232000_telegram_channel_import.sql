create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table public.photos
  add column telegram_original_thumb text,
  add column telegram_preview_thumb text,
  add column caption_pending boolean not null default false,
  add constraint photos_telegram_original_unique unique (telegram_original_id);
alter table public.videos
  add column telegram_cover_thumb text,
  add column caption_pending boolean not null default false;

create table public.video_telegram_import_state (
  singleton boolean primary key default true check (singleton),
  last_message_id integer not null,
  busy_until timestamptz not null default '-infinity'
);
alter table public.video_telegram_import_state enable row level security;
revoke all on public.video_telegram_import_state from public, anon, authenticated;
grant select, update on public.video_telegram_import_state to service_role;

insert into public.video_telegram_import_state (last_message_id)
select greatest(0,
  (select max(greatest(telegram_message_id, telegram_cover_id)) from public.videos),
  (select max(greatest(telegram_original_id, telegram_preview_id)) from public.photos)
);

select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'video_telegram_import_key');

create function public.video_telegram_import_authorized(candidate text)
returns boolean language sql security definer set search_path = ''
as $$
  select coalesce(length(candidate) = 64 and exists (
    select 1 from vault.decrypted_secrets
      where name = 'video_telegram_import_key' and decrypted_secret = candidate
  ), false)
$$;
revoke all on function public.video_telegram_import_authorized(text) from public, anon, authenticated;
grant execute on function public.video_telegram_import_authorized(text) to service_role;
