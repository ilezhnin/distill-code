-- Page boundaries use whole user turns. Only index the small prompt subset;
-- tool outputs and token deltas stay in the existing append-only log.
CREATE INDEX session_events_prompts ON session_events(session_id, id)
WHERE json_valid(payload_json)
  AND json_extract(payload_json, '$.update.sessionUpdate') = 'user_message_chunk';
