CREATE TABLE executor_decisions (
    request_key TEXT PRIMARY KEY NOT NULL,
    input_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decision_json TEXT NOT NULL
);

CREATE TABLE executor_observations (
    request_key TEXT NOT NULL REFERENCES executor_decisions(request_key),
    phase TEXT NOT NULL CHECK (phase IN ('started', 'terminal')),
    created_at INTEGER NOT NULL,
    observation_json TEXT NOT NULL,
    artifact_hash TEXT NOT NULL,
    PRIMARY KEY (request_key, phase)
);
