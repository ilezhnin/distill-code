-- A chat runs on four selections: provider, model, reasoning effort and fast
-- mode. The first two have had columns since the table was created; these are
-- the other two, so a session re-attached with no renderer present (a
-- background attach, berdctl, the title summariser, an app restart) can be put
-- back on what the operator chose instead of on the bridge's default.
--
-- Additive by design: `row_to_session` reads every column by name, so an older
-- build ignores these and a newer one reads NULL for every existing row.
ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;

-- 0 | 1, or NULL when nobody has chosen and for a model with no fast mode.
ALTER TABLE sessions ADD COLUMN fast_mode INTEGER;

-- The model id as it was stored before the effort was split out of it
-- (`gpt-5.6-sol[xhigh]`). Kept forever: it is the record of what a chat ran on
-- before Distill stopped folding an effort into a model id, and the condition
-- for retiring the legacy reader is that no rows carry one.
ALTER TABLE sessions ADD COLUMN legacy_model_id TEXT;
