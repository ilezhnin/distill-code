//! What the run listing (`Store::runs`) reads from the attempts of each of the
//! newest runs, kept between listings.
//!
//! A run's figures (its counts, the selections its turns ran with, its open
//! cells, its issues, its workflow result and its cells) come from its
//! attempts' JSON records, which also carry each answer and its evidence.
//! Reading them for the 100 newest runs on every listing parsed about 44,000
//! records of the 5 GB store, a median of 2.6 s and up to 12.3 s, 2,432
//! times in 41 hours (2026-11-23..25), while the app polled the listing.
//!
//! A run's figures change only when one of its attempts, its state or its
//! request does, and every write of an attempt commits a `benchmark_events`
//! row naming the attempt's run in the same transaction (see `store::event`):
//! starting a run, inserting, saving and superseding an attempt, sealing a
//! sitting, rebinding pending work and moving a run's state. SQLite has one
//! writer, so events commit in the order of their sequence, and the events a
//! listing's snapshot shows are exactly those up to the newest one in it. A
//! listing therefore reads again only the runs it kept nothing for, the runs
//! an event named since the listing before, and the runs whose state or
//! request differ from what it kept; it takes the others from memory.
use sqlx::{Row, SqliteConnection};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// One run as the listing shows it: its plan as stored now, and the figures
/// of its attempts.
pub(super) struct Listed {
    pub(super) id: String,
    pub(super) state: String,
    pub(super) revision: i64,
    pub(super) created_at: i64,
    pub(super) updated_at: i64,
    pub(super) request_json: String,
    pub(super) baked_at: Option<i64>,
    pub(super) paused_ms: i64,
    pub(super) paused_since: Option<i64>,
    pub(super) figures: Arc<Figures>,
}

/// What the listing reads from one run's attempts, as SQL gives it.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Figures {
    pub(super) attempt_count: i64,
    pub(super) settled_count: i64,
    pub(super) observed_selections: Option<String>,
    pub(super) open_cells: Option<String>,
    pub(super) issues: Option<String>,
    pub(super) workflow_result: Option<String>,
    pub(super) cell_count: i64,
    pub(super) settled_cells: String,
}

/// The figures of the runs the last listing showed, and the newest event they
/// include.
#[derive(Default)]
pub(super) struct Kept {
    seen: Option<i64>,
    runs: HashMap<String, KeptRun>,
}

struct KeptRun {
    /// The run's state and request its figures were read under: some figures
    /// are read only in some states, and a workflow result only for a
    /// workflow request.
    state: String,
    request_json: String,
    figures: Arc<Figures>,
}

/// How many runs the listing shows, newest first.
const LISTED: i64 = 100;

/// The figures of the run `?1`. The statement is the listing's as it read all
/// 100 runs at once, restricted to one run, so its attempts are found through
/// the `(run_id, phase)` index instead of a scan of every attempt. The last
/// column lists the run's attempts in no defined order, as it always did (an
/// automatic index ordered them before); `settled_cells` only counts them.
const FIGURES: &str = "WITH recent_runs AS MATERIALIZED (
        SELECT * FROM run_plans WHERE id=?1
     ), recent_attempts AS MATERIALIZED (
        SELECT a.id,a.run_id,a.configuration_id,a.version_id,a.phase,a.rowid,
            json_extract(a.data_json,'$.outcome') AS outcome,
            json_extract(a.data_json,'$.reason') AS reason,
            json_extract(a.data_json,'$.observed.effort') AS observed_effort,
            json_extract(a.data_json,'$.observed.fastMode') AS observed_fast,
            json_extract(a.data_json,'$.observed.modelId') AS observed_model,
            json_extract(a.data_json,'$.configuration.modelId') AS configured_model,
            json_extract(a.data_json,'$.finishedAt') AS finished_at,
            EXISTS(SELECT 1 FROM json_each(a.data_json,'$.evaluations') e
                WHERE e.type='object' AND json_extract(e.value,'$.provenance')='human'
                    AND json_extract(e.value,'$.score') IS NOT NULL) AS has_human_score,
            CASE WHEN a.phase='terminal' AND json_extract(a.data_json,'$.outcome')='pending_review'
                THEN json_extract(a.data_json,'$.evaluations') END AS pending_evaluations
        FROM attempts a WHERE a.run_id=?1
     ) SELECT
        (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id
            AND COALESCE(a.outcome,'')<>'superseded'),
        (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id AND a.phase='terminal'
            AND COALESCE(a.outcome,'')<>'superseded'),
        CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
        (SELECT json_group_array(json_array(o.configuration_id,
                o.observed_effort,o.observed_fast))
            FROM (SELECT a.configuration_id,a.observed_effort,a.observed_fast
                FROM recent_attempts a WHERE a.run_id=r.id AND a.phase<>'pending'
                    AND a.observed_model=a.configured_model
                    AND COALESCE(a.outcome,'')<>'selection_changed'
                ORDER BY a.phase,a.rowid) o)
        END,
        CASE WHEN r.state NOT IN ('completed','cancelled','cancelling') THEN
        (SELECT json_group_array(json_array(o.configuration_id,o.version_id,o.running))
            FROM (SELECT a.configuration_id,a.version_id,MAX(a.phase<>'pending') AS running FROM recent_attempts a
                WHERE a.run_id=r.id AND a.phase<>'terminal'
                GROUP BY a.configuration_id,a.version_id ORDER BY MIN(a.rowid)) o)
        END,
        CASE WHEN r.state IN ('running','pausing','paused','needs_attention','completed') THEN
        (SELECT json_group_array(json_array(issue.outcome,issue.reason,issue.id,issue.finished_at))
         FROM (SELECT a.outcome,a.reason,a.id,a.finished_at
            FROM recent_attempts a WHERE a.run_id=r.id
                AND COALESCE(a.reason,'')<>''
                AND ((a.phase='terminal' AND a.outcome='pending_review'
                    AND a.has_human_score=0)
                OR (a.phase='pending' AND CASE WHEN json_valid(a.reason)
                    THEN json_extract(a.reason,'$.data.kind')='account_quota_wait'
                        OR json_extract(a.reason,'$.data.type')='account_quota_wait'
                    ELSE 0 END)
                OR ((r.state='needs_attention' OR (a.phase='terminal' AND a.outcome IS NOT NULL)) AND COALESCE(a.outcome,'') NOT IN
                    ('pass','fail','judged','pending_review','completed','budget_reached','budget_timeout',
                     'excluded','selection_changed','unsupported','cancelled','superseded')))
            ORDER BY (a.reason LIKE 'Waiting for local resources%') ASC,
                (a.phase='pending') DESC,
                (a.reason LIKE 'No judge panel:%') DESC,
                COALESCE(a.finished_at,0) DESC, a.rowid DESC
            ) issue)
        END,
        CASE WHEN json_extract(r.request_json,'$.workflowPolicy') IS NOT NULL
            AND (SELECT COUNT(*) FROM recent_attempts a WHERE a.run_id=r.id
                AND COALESCE(a.outcome,'')<>'superseded')=1
        THEN (SELECT json_object('outcome',a.outcome,
                'reason',a.reason)
            FROM recent_attempts a WHERE a.run_id=r.id AND a.phase='terminal'
                AND a.outcome IS NOT NULL
                AND a.outcome<>'superseded')
        END,
        (SELECT COUNT(*) FROM (SELECT 1 FROM recent_attempts a WHERE a.run_id=r.id
            AND COALESCE(a.outcome,'')<>'superseded'
            GROUP BY a.configuration_id,a.version_id)),
        (SELECT json_group_array(json_array(a.configuration_id,a.version_id,a.phase,a.outcome,
            json(a.pending_evaluations))) FROM recent_attempts a WHERE a.run_id=r.id
            AND COALESCE(a.outcome,'')<>'superseded'
        )
     FROM recent_runs r";

/// The 100 newest runs with their figures, read on `connection` inside the
/// caller's transaction, so every row and every figure come from one
/// snapshot. `kept` is what the last listing left; it is replaced only once
/// the whole listing has been read.
pub(super) async fn newest(
    connection: &mut SqliteConnection,
    kept: &mut Kept,
) -> sqlx::Result<Vec<Listed>> {
    let sequence: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM benchmark_events")
            .fetch_one(&mut *connection)
            .await?;
    // Nothing kept, or a store whose events went back (a restored copy):
    // every run is read again.
    let current = kept.seen.is_some_and(|seen| seen <= sequence);
    let named: HashSet<String> = match kept.seen {
        Some(seen) if current && seen < sequence => sqlx::query_scalar(
            "SELECT DISTINCT entity_id FROM benchmark_events WHERE sequence>? AND sequence<=?",
        )
        .bind(seen)
        .bind(sequence)
        .fetch_all(&mut *connection)
        .await?
        .into_iter()
        .collect(),
        _ => HashSet::new(),
    };
    let rows = sqlx::query(
        "SELECT id,state,revision,created_at,updated_at,request_json,baked_at,paused_ms,paused_since
         FROM run_plans ORDER BY created_at DESC,id LIMIT ?",
    )
    .bind(LISTED)
    .fetch_all(&mut *connection)
    .await?;
    let mut listed = Vec::with_capacity(rows.len());
    let mut runs = HashMap::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get(0);
        let state: String = row.get(1);
        let request_json: String = row.get(5);
        let unchanged = kept.runs.get(&id).filter(|run| {
            current
                && !named.contains(&id)
                && run.state == state
                && run.request_json == request_json
        });
        let figures = match unchanged {
            Some(run) => run.figures.clone(),
            None => Arc::new(figures(connection, &id).await?),
        };
        runs.insert(
            id.clone(),
            KeptRun {
                state: state.clone(),
                request_json: request_json.clone(),
                figures: figures.clone(),
            },
        );
        listed.push(Listed {
            id,
            state,
            revision: row.get(2),
            created_at: row.get(3),
            updated_at: row.get(4),
            request_json,
            baked_at: row.get(6),
            paused_ms: row.get(7),
            paused_since: row.get(8),
            figures,
        });
    }
    kept.seen = Some(sequence);
    kept.runs = runs;
    Ok(listed)
}

/// Reads the figures of run `id` from its attempts.
async fn figures(connection: &mut SqliteConnection, id: &str) -> sqlx::Result<Figures> {
    let row = sqlx::query(FIGURES)
        .bind(id)
        .fetch_one(&mut *connection)
        .await?;
    Ok(Figures {
        attempt_count: row.get(0),
        settled_count: row.get(1),
        observed_selections: row.get(2),
        open_cells: row.get(3),
        issues: row.get(4),
        workflow_result: row.get(5),
        cell_count: row.get(6),
        settled_cells: row.get(7),
    })
}
