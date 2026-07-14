UPDATE incircle_ai_messages
SET status = 'failed', error_code = 'AI_LEGACY_STREAM_INTERRUPTED'
WHERE role = 'assistant'
  AND status = 'cancelled'
  AND error_code IN ('', 'AI_CANCELLED')
  AND updated_at < now() - interval '5 minutes';
