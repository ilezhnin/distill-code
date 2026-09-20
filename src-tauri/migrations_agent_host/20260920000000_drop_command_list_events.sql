-- An `available_commands_update` is a harness restating its slash-command
-- list. It says nothing about the conversation, the renderer never read one
-- back, and the host no longer stores them (`Inner::is_command_list_update`).
-- While it did, grok sent one to every open session each time its skill watcher
-- fired — every ten minutes on a machine where something syncs into
-- `~/.claude/skills` — at ~16 KB apiece, replayed on every load of the chat.
--
-- `json_extract` raises on text that is not JSON and SQLite promises no
-- evaluation order for AND, so the read sits in a CASE, which does promise
-- one. The LIKE keeps the JSON parser off the rows that cannot match.
DELETE FROM session_events
WHERE CASE
        WHEN payload_json LIKE '%"available_commands_update"%' AND json_valid(payload_json)
        THEN json_extract(payload_json, '$.update.sessionUpdate')
    END = 'available_commands_update';
