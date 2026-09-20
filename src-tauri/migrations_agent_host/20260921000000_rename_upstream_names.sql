-- Distill was renamed from its upstream's name, and three things older builds
-- stored in a transcript are read back by name: the origin that marks a message
-- one session sent another, the metadata keys such a message carries, and the
-- scheme of a link to a session. The renamed build looks for the new spellings
-- only, so the stored ones move with it — otherwise a cross-session message
-- loses its sender's label on reload and a session link in an old reply stops
-- opening anything.
--
-- The quoted patterns match structure only: inside a JSON string a quote is
-- stored escaped, so prose that merely mentions these names is left as written.
-- The link scheme is prose on purpose; that is where agents write links.
UPDATE session_events
SET payload_json = replace(replace(replace(replace(payload_json,
        '"berdctl_cross_session"', '"distillctl_cross_session"'),
        '"berdDeliveryId":', '"distillDeliveryId":'),
        '"berdSenderLabel":', '"distillSenderLabel":'),
        'berd://session/', 'distill://session/')
WHERE payload_json LIKE '%berd%';
