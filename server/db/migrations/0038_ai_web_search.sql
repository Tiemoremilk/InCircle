ALTER TABLE incircle_platform_settings
  ADD COLUMN IF NOT EXISTS web_search_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE incircle_ai_messages
  ADD COLUMN IF NOT EXISTS search_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
