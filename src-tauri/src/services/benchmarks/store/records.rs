//! Catalog entries, releases, reservations, schedules and usage samples.
use super::*;

impl Store {
    /// Every catalog entry, newest effective date first. Each vendor seed set
    /// is added once, together with the record that it was, so a set shipped
    /// later reaches an existing catalog and a seed the user deleted never
    /// comes back.
    pub async fn catalog_entries(&self) -> Result<Vec<CatalogEntry>> {
        let seeded: Vec<String> = sqlx::query_scalar("SELECT id FROM catalog_seed_sets")
            .fetch_all(&self.pool)
            .await?;
        for (set, entries) in crate::services::benchmarks::model_catalog::seed_sets() {
            if seeded.iter().any(|id| id == set) {
                continue;
            }
            let mut tx = self.pool.begin().await?;
            let recorded = sqlx::query(
                "INSERT INTO catalog_seed_sets(id,seeded_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING",
            )
            .bind(set)
            .bind(now())
            .execute(&mut *tx)
            .await?
            .rows_affected();
            // Another caller seeded it meanwhile.
            if recorded == 0 {
                continue;
            }
            for entry in entries {
                sqlx::query("INSERT INTO catalog_entries(id,kind,effective_from,created_at,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING")
                    .bind(&entry.id)
                    .bind(&entry.kind)
                    .bind(entry.effective_from)
                    .bind(entry.created_at)
                    .bind(serde_json::to_string(&entry)?)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
        }
        self.json_rows(
            "SELECT data_json FROM catalog_entries ORDER BY effective_from DESC, created_at DESC",
        )
        .await
    }

    pub async fn save_catalog_entry(&self, entry: &CatalogEntry) -> Result<()> {
        sqlx::query("INSERT INTO catalog_entries(id,kind,effective_from,created_at,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,effective_from=excluded.effective_from,data_json=excluded.data_json")
            .bind(&entry.id)
            .bind(&entry.kind)
            .bind(entry.effective_from)
            .bind(entry.created_at)
            .bind(serde_json::to_string(entry)?)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_catalog_entry(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM catalog_entries WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Every pool release, oldest first.
    pub async fn releases(&self) -> Result<Vec<PoolRelease>> {
        self.json_rows("SELECT data_json FROM pool_releases ORDER BY created_at, rowid")
            .await
    }

    /// Every family and split group an evaluation reserves, as (kind, value),
    /// whoever owns it. Suites no longer read reservations; tests use this to
    /// prove a retired holdout's rows block nothing.
    #[cfg(test)]
    pub async fn evaluation_reservations(&self) -> Result<Vec<(String, String)>> {
        // Reservations of the retired executor holdout are history: they
        // never hold a case back from a suite, lane or run.
        sqlx::query("SELECT DISTINCT kind, value FROM evaluation_reservations WHERE owner_kind<>'executor_holdout'")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|row| Ok((row.try_get("kind")?, row.try_get("value")?)))
            .collect()
    }

    pub async fn save_release(&self, release: &PoolRelease) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO pool_releases(id,name,created_at,data_json) VALUES(?,?,?,?)")
            .bind(&release.id)
            .bind(&release.name)
            .bind(release.created_at)
            .bind(serde_json::to_string(release)?)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, &release.id, "release_created").await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn schedules(&self) -> Result<Vec<Schedule>> {
        self.json_rows("SELECT data_json FROM schedules ORDER BY rowid DESC")
            .await
    }

    pub async fn usage_samples(&self) -> Result<Vec<UsageSample>> {
        // Quota samples of the retired Usage Bench, kept as data and read
        // only by the export, in bounded batches.
        let mut samples = Vec::new();
        let mut before = i64::MAX;
        loop {
            let rows=sqlx::query("SELECT rowid,data_json FROM usage_observations WHERE rowid<? ORDER BY rowid DESC LIMIT 1000")
                .bind(before).fetch_all(&self.pool).await?;
            let count = rows.len();
            for row in rows {
                before = row.get(0);
                samples.push(serde_json::from_str(row.get(1))?);
            }
            if count < 1000 {
                break;
            }
        }
        Ok(samples)
    }

    pub(super) async fn json_rows<T: serde::de::DeserializeOwned>(
        &self,
        sql: &str,
    ) -> Result<Vec<T>> {
        sqlx::query_scalar::<_, String>(sql)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(|v| serde_json::from_str(&v).map_err(Into::into))
            .collect()
    }

    pub async fn save_schedule(&self, s: &Schedule) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO schedules(id,enabled,next_due_at,data_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,next_due_at=excluded.next_due_at,data_json=excluded.data_json").bind(&s.id).bind(s.enabled).bind(s.next_due_at).bind(serde_json::to_string(s)?).execute(&mut *tx).await?;
        event(&mut tx, &s.id, "schedule_changed").await?;
        tx.commit().await?;
        Ok(())
    }
}
