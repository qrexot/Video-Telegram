alter table public.photos
  add column preview_after timestamptz not null default '-infinity',
  add column preview_attempts integer not null default 0;

create function public.claim_telegram_photo_preview()
returns table (id uuid, size_bytes integer)
language sql set search_path = ''
as $$
  with pending as (
    select p.id from public.photos p
    where p.telegram_original_id = p.telegram_preview_id
      and p.telegram_preview_thumb is null
      and p.preview_attempts < 5
      and p.preview_after <= now()
      and p.deleted_at is null
    order by p.preview_after, p.created_at desc
    limit 1
    for update skip locked
  )
  update public.photos p
    set preview_after = now() + interval '5 minutes', preview_attempts = p.preview_attempts + 1
    from pending
    where p.id = pending.id
  returning p.id, p.size_bytes;
$$;
revoke all on function public.claim_telegram_photo_preview() from public, anon, authenticated;
grant execute on function public.claim_telegram_photo_preview() to service_role;
