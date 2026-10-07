#!/usr/bin/env bash
set -euo pipefail
psql -v ON_ERROR_STOP=1 <<'SQL'
GRANT SELECT ON public.outbox_events TO hotel_booking_cdc;
REVOKE UPDATE ON public.outbox_events FROM hotel_booking_app;
SELECT 'CREATE PUBLICATION anhbnb_outbox_publication FOR TABLE public.outbox_events WITH (publish = ''insert'')'
WHERE NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'anhbnb_outbox_publication')
\gexec
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'anhbnb_outbox_publication') <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'anhbnb_outbox_publication' AND schemaname = 'public' AND tablename = 'outbox_events')
  THEN RAISE EXCEPTION 'Refusing existing publication with unexpected CDC scope'; END IF;
END $$;
SQL
