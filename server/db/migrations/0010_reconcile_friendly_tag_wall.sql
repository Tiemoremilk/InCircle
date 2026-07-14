WITH promoted_tags AS (
  SELECT
    votes.target_member_card_id,
    jsonb_agg(to_jsonb(votes.tag) ORDER BY votes.tag) AS tags
  FROM (
    SELECT target_member_card_id, tag
    FROM incircle_member_tag_votes
    GROUP BY target_member_card_id, tag
    HAVING count(DISTINCT voter_user_id) >= 2
  ) votes
  GROUP BY votes.target_member_card_id
), reconciled_cards AS (
  SELECT
    card.id,
    (
      SELECT COALESCE(jsonb_agg(to_jsonb(tag_values.value) ORDER BY tag_values.value), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(card.tags) = 'array' THEN card.tags ELSE '[]'::jsonb END
        ) AS value
        UNION
        SELECT jsonb_array_elements_text(promoted.tags) AS value
      ) tag_values
    ) AS tags,
    (
      SELECT COALESCE(jsonb_agg(to_jsonb(tag_values.value) ORDER BY tag_values.value), '[]'::jsonb)
      FROM (
        SELECT jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(card.payload->'autoFriendlyTags') = 'array'
              THEN card.payload->'autoFriendlyTags'
            ELSE '[]'::jsonb
          END
        ) AS value
        UNION
        SELECT jsonb_array_elements_text(promoted.tags) AS value
      ) tag_values
    ) AS auto_tags
  FROM incircle_member_cards card
  JOIN promoted_tags promoted ON promoted.target_member_card_id = card.id
)
UPDATE incircle_member_cards card
SET tags = reconciled.tags,
    payload = jsonb_set(
      jsonb_set(
        CASE WHEN jsonb_typeof(card.payload) = 'object' THEN card.payload ELSE '{}'::jsonb END,
        '{autoFriendlyTags}',
        reconciled.auto_tags,
        true
      ),
      '{safetyNote}',
      to_jsonb('已按圈友认可人数同步标签墙。'::text),
      true
    ),
    updated_at = now()
FROM reconciled_cards reconciled
WHERE card.id = reconciled.id
  AND (
    card.tags IS DISTINCT FROM reconciled.tags
    OR card.payload->'autoFriendlyTags' IS DISTINCT FROM reconciled.auto_tags
  );
