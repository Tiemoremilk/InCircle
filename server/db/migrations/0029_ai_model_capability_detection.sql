ALTER TABLE incircle_ai_models
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_model_context_source,
  DROP CONSTRAINT IF EXISTS chk_incircle_ai_model_output_source;

ALTER TABLE incircle_ai_models
  ADD CONSTRAINT chk_incircle_ai_model_context_source
    CHECK (context_window_source IN ('', 'sync', 'catalog', 'manual')),
  ADD CONSTRAINT chk_incircle_ai_model_output_source
    CHECK (max_output_tokens_source IN ('', 'sync', 'catalog', 'probe', 'manual', 'compatibility'));
