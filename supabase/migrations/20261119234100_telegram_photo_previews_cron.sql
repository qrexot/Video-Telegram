select cron.schedule(
  'video-telegram-previews', '30 seconds',
  $job$
  select net.http_post(
    url := 'https://tilifwvlvomwnklviqtp.supabase.co/functions/v1/video?action=telegram-preview-job',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-video-sync', (select decrypted_secret from vault.decrypted_secrets where name = 'video_telegram_import_key')
    ),
    timeout_milliseconds := 55000
  );
  $job$
);
