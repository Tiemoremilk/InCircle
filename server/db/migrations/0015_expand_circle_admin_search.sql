DROP INDEX IF EXISTS idx_incircle_circles_admin_search_trgm;

CREATE INDEX idx_incircle_circles_admin_search_trgm
  ON incircle_circles USING gin (
    (COALESCE(name, '') || ' ' || COALESCE(slogan, '') || ' ' || COALESCE(notice, '') || ' ' || COALESCE(join_code, '')) gin_trgm_ops
  );
