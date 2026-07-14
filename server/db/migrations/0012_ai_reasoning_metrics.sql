ALTER TABLE incircle_ai_messages
  ADD COLUMN IF NOT EXISTS reasoning_duration_ms integer NOT NULL DEFAULT 0
  CHECK (reasoning_duration_ms >= 0 AND reasoning_duration_ms <= 3600000);

ALTER TABLE incircle_ai_settings
  ALTER COLUMN max_output_tokens SET DEFAULT 8192;

UPDATE incircle_ai_settings
SET max_output_tokens = 8192
WHERE max_output_tokens = 4096;
