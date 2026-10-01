-- External CLI logins no longer identify Distill accounts. Preserve each
-- transcript and let the user explicitly choose its next connected account.
UPDATE sessions SET account_id = NULL
WHERE (harness = 'codex-acp' AND account_id = 'system:codex-acp')
   OR (harness = 'claude-acp' AND account_id = 'system:claude-acp');
