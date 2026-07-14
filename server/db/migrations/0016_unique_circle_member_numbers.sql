ALTER TABLE incircle_circles
  ADD COLUMN IF NOT EXISTS next_member_no integer NOT NULL DEFAULT 1;

WITH ranked_members AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY circle_id
      ORDER BY COALESCE(joined_at, created_at), created_at, id
    ) AS member_no
  FROM incircle_circle_members
)
UPDATE incircle_circle_members member
SET member_id_text = 'M-' || CASE
  WHEN ranked.member_no < 1000 THEN lpad(ranked.member_no::text, 3, '0')
  ELSE ranked.member_no::text
END
FROM ranked_members ranked
WHERE member.id = ranked.id;

UPDATE incircle_circles circle
SET next_member_no = COALESCE((
  SELECT count(*)::integer + 1
  FROM incircle_circle_members member
  WHERE member.circle_id = circle.id
), 1);

ALTER TABLE incircle_circles
  DROP CONSTRAINT IF EXISTS chk_incircle_circle_next_member_no;
ALTER TABLE incircle_circles
  ADD CONSTRAINT chk_incircle_circle_next_member_no CHECK (next_member_no >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_circle_member_number
  ON incircle_circle_members(circle_id, lower(member_id_text))
  WHERE btrim(member_id_text) <> '';
