WITH ranked_system_docs AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY circle_id, payload->>'systemKey'
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_rank
  FROM incircle_docs
  WHERE COALESCE(payload->>'systemKey', '') <> ''
)
DELETE FROM incircle_docs docs
USING ranked_system_docs ranked
WHERE docs.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_incircle_docs_circle_system_key
ON incircle_docs(circle_id, (payload->>'systemKey'))
WHERE COALESCE(payload->>'systemKey', '') <> '';
