CREATE INDEX IF NOT EXISTS idx_incircle_ai_model_catalog_global_active_model
  ON incircle_ai_model_capability_catalog(model_id_normalized)
  WHERE status = 'active';
