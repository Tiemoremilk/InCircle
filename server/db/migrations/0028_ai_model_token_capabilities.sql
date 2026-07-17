ALTER TABLE incircle_ai_settings
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_settings_output_tokens;

ALTER TABLE incircle_ai_settings
  ADD CONSTRAINT chk_incircle_ai_settings_output_tokens
  CHECK (max_output_tokens BETWEEN 128 AND 32768);

ALTER TABLE incircle_ai_models
  ADD COLUMN IF NOT EXISTS context_window_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS max_output_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_output_tokens_source text NOT NULL DEFAULT '';

UPDATE incircle_ai_models
SET context_window_source = CASE
  WHEN context_window <= 0 THEN ''
  WHEN source = 'manual' THEN 'manual'
  ELSE 'sync'
END
WHERE context_window_source = '';

ALTER TABLE incircle_ai_models
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_model_context_source,
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_model_output_tokens,
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_model_output_source;

ALTER TABLE incircle_ai_models
  ADD CONSTRAINT chk_incircle_ai_model_context_source
    CHECK (context_window_source IN ('', 'sync', 'manual')),
  ADD CONSTRAINT chk_incircle_ai_model_output_tokens
    CHECK (max_output_tokens = 0 OR max_output_tokens BETWEEN 128 AND 2000000),
  ADD CONSTRAINT chk_incircle_ai_model_output_source
    CHECK (max_output_tokens_source IN ('', 'sync', 'manual', 'compatibility'));
