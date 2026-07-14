ALTER TABLE incircle_ai_settings
  ALTER COLUMN max_output_tokens SET DEFAULT 4096;

UPDATE incircle_ai_settings
SET max_output_tokens = 4096
WHERE max_output_tokens = 2048;

UPDATE incircle_ai_messages
SET status = 'failed', error_code = 'AI_STALE_GENERATION'
WHERE role = 'assistant' AND status = 'generating'
  AND updated_at < now() - interval '10 minutes';
