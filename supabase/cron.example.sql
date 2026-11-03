-- Schedules the background runner (job retries, dead letters, deletion purge, retention expiry) every minute.
-- Run once in the Supabase SQL editor AFTER deploying functions. Replace <PROJECT_REF> and <CRON_SECRET>.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('convosage-run-jobs', '* * * * *', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/api/v1/internal/run-jobs',
    headers := jsonb_build_object('authorization', 'Bearer <CRON_SECRET>', 'content-type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 55000);
$$);
