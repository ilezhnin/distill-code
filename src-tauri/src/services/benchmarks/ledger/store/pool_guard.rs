//! The check every pooled SQLite connection of the app passes on its way back
//! to its pool: the benchmark store's and the agent host's.
//!
//! sqlx 0.8.6 keeps its own count of a connection's open transactions and
//! lowers it only when its own COMMIT or ROLLBACK succeeds. When SQLite rolls
//! a transaction back by itself (SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM while
//! a write builds its record), the ROLLBACK that dropping the `Transaction`
//! queues fails with "no transaction is active", nobody hears of it, and the
//! connection goes back to the pool counted at depth 1 while SQLite sits in
//! autocommit. Every `begin_with("BEGIN IMMEDIATE")` that later draws it fails
//! with "attempted to call begin_with at non-zero transaction depth", about one
//! in four under load, until the pool retires the connection 30 minutes after
//! it opened (2026-11-24, 02:13 to 02:31 UTC: paid cells settled as
//! storage_unavailable and runs stopped). A `begin_with` future dropped after
//! SQLite ran its BEGIN leaves the opposite: depth 1 and a write transaction
//! open on an idle connection, which holds every other writer off and swallows
//! the plain writes that draw it.
//!
//! Both are caught here, once for every transaction of both databases: a
//! connection whose sqlx depth is not zero, or on which SQLite still has a
//! transaction open, is closed instead of being handed to the next caller, so
//! a failure costs the transaction it happened in and never a later one. A
//! release is the only way a used connection gets back into the idle queue
//! (sqlx-core 0.8.6 `Floating::return_to_pool`).
use sqlx::sqlite::{SqliteConnection, SqlitePoolOptions, SqliteTransactionManager};
use sqlx::TransactionManager;

/// `options` with the release check; `database` names the store in the log.
pub(crate) fn guard_transactions(
    options: SqlitePoolOptions,
    database: &'static str,
) -> SqlitePoolOptions {
    options.after_release(move |connection, _| {
        Box::pin(async move { released_clean(connection, database).await })
    })
}

/// Whether `connection` may go back to the idle queue: no transaction is
/// open, as sqlx counts it and as SQLite has it. False closes it.
async fn released_clean(
    connection: &mut SqliteConnection,
    database: &str,
) -> Result<bool, sqlx::Error> {
    // The handle is granted through the connection's command queue, behind
    // the ROLLBACK a dropped `Transaction` queued, so both states below are
    // read after that ROLLBACK ran. A worker that is gone errs here, and the
    // pool then closes the connection outright.
    let autocommit = {
        let mut handle = connection.lock_handle().await?;
        // SAFETY: the locked handle keeps the worker thread off this
        // connection, and sqlite3_get_autocommit only reads its state.
        unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) != 0 }
    };
    let depth = <SqliteTransactionManager as TransactionManager>::get_transaction_depth(connection);
    if depth == 0 && autocommit {
        return Ok(true);
    }
    log::warn!(
        "[sqlite] closing a pooled {database} connection that came back with sqlx transaction depth {depth} while SQLite {}; the next caller gets a new connection",
        if autocommit {
            "had already rolled its transaction back"
        } else {
            "still holds an open transaction"
        }
    );
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;
    use std::time::Duration;

    /// One write SQLite rolls back by itself: the database is full (a page
    /// cap on the connection), and `?` drops the transaction, as the stores do.
    async fn write_sqlite_rolls_back(pool: &SqlitePool) {
        let failed = async {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
            let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
                .fetch_one(&mut *tx)
                .await?;
            sqlx::query(&format!("PRAGMA max_page_count={pages}"))
                .execute(&mut *tx)
                .await?;
            let full = sqlx::query("INSERT INTO pool_guard_probe(v) VALUES(randomblob(1000000))")
                .execute(&mut *tx)
                .await;
            sqlx::query("PRAGMA max_page_count=4294967294")
                .execute(&mut *tx)
                .await?;
            full?;
            tx.commit().await
        }
        .await;
        let error = failed.unwrap_err().to_string();
        assert!(error.contains("full"), "{error}");
        // The dropped connection goes back on a task of its own.
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    /// The 2026-11-24 incident: every pooled connection open, one write SQLite
    /// rolled back by itself, then twelve BEGIN IMMEDIATE in a row. Before
    /// the guard every fourth failed: "attempted to call begin_with at
    /// non-zero transaction depth".
    async fn writers_after_a_rollback_sqlite_made(pool: &SqlitePool) -> Vec<&'static str> {
        sqlx::query("CREATE TABLE pool_guard_probe(v BLOB)")
            .execute(pool)
            .await
            .unwrap();
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(pool.acquire().await.unwrap());
        }
        drop(held);
        tokio::time::sleep(Duration::from_millis(200)).await;
        write_sqlite_rolls_back(pool).await;
        let mut writers = Vec::new();
        for _ in 0..12 {
            writers.push(match pool.begin_with("BEGIN IMMEDIATE").await {
                Ok(tx) => {
                    tx.commit().await.unwrap();
                    "ok"
                }
                Err(_) => "FAIL",
            });
        }
        writers
    }

    #[tokio::test]
    async fn a_rollback_sqlite_made_fails_no_later_writer_of_the_benchmark_store() {
        let dir = crate::test_support::TempRoot::new();
        let store = crate::services::benchmarks::store::Store::open(dir.path())
            .await
            .unwrap();
        dir.register(&store.pool);
        assert_eq!(
            writers_after_a_rollback_sqlite_made(&store.pool).await,
            vec!["ok"; 12]
        );
        dir.close().await;
    }

    #[tokio::test]
    async fn a_rollback_sqlite_made_fails_no_later_writer_of_the_agent_host() {
        let dir = crate::test_support::TempRoot::new();
        let store = crate::services::agent_host::store::SessionStore::open(
            &dir.path().join("agent-host.db"),
        )
        .await
        .unwrap();
        dir.register(store.pool());
        assert_eq!(
            writers_after_a_rollback_sqlite_made(store.pool()).await,
            vec!["ok"; 12]
        );
        dir.close().await;
    }

    /// A connection is closed only when its transaction state is wrong: one
    /// whose failed transaction SQLite kept open until the drop's ROLLBACK (a
    /// constraint) stays, with what the session put on it; one whose
    /// transaction SQLite rolled back by itself is replaced.
    #[tokio::test]
    async fn only_a_connection_left_in_a_wrong_transaction_state_is_closed() {
        let dir = crate::test_support::TempRoot::new();
        let pool = guard_transactions(SqlitePoolOptions::new().max_connections(1), "test")
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(dir.path().join("guard.db"))
                    .create_if_missing(true)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        dir.register(&pool);
        for statement in [
            "CREATE TABLE pool_guard_probe(v BLOB)",
            "CREATE TABLE taken(k TEXT UNIQUE)",
            "INSERT INTO taken(k) VALUES('taken')",
            // Temporary tables live as long as their connection.
            "CREATE TEMP TABLE same_connection(x)",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        async fn same_connection(pool: &SqlitePool) -> bool {
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM temp.sqlite_master WHERE name='same_connection'",
            )
            .fetch_one(pool)
            .await
            .unwrap()
                == 1
        }
        let refused = async {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
            sqlx::query("INSERT INTO taken(k) VALUES('taken')")
                .execute(&mut *tx)
                .await?;
            tx.commit().await
        }
        .await;
        assert!(refused.is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            same_connection(&pool).await,
            "a clean connection was closed"
        );
        write_sqlite_rolls_back(&pool).await;
        assert!(
            !same_connection(&pool).await,
            "the connection was handed out again"
        );
        let tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        tx.commit().await.unwrap();
        dir.close().await;
    }
}
