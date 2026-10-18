//! Shared computations behind the views' queries.

use super::types::Result;
use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

/// One computation per key at a time. A caller takes the result of a
/// computation that started after it asked; otherwise it waits for the one
/// running and starts the next, which every caller that asked meanwhile
/// shares. So a view asking again never overlaps its own superseded request,
/// and each caller still gets a result at least as new as its request. A
/// result is held only while a caller holds it.
#[derive(Default)]
pub struct Flights {
    slots: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<Last>>>>>,
}

struct Last {
    started: Instant,
    value: Weak<dyn Any + Send + Sync>,
}

impl Flights {
    pub async fn share<T, F, Fut>(&self, key: &str, compute: F) -> Result<Arc<T>>
    where
        T: Send + Sync + 'static,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let asked = Instant::now();
        let slot = self
            .slots
            .lock()
            .unwrap()
            .entry(key.to_owned())
            .or_default()
            .clone();
        let mut last = slot.lock().await;
        let fresh = last
            .as_ref()
            .filter(|last| last.started >= asked)
            .and_then(|last| last.value.upgrade())
            .and_then(|value| value.downcast::<T>().ok());
        if let Some(value) = fresh {
            return Ok(value);
        }
        let started = Instant::now();
        let value = Arc::new(compute().await?);
        let shared: Arc<dyn Any + Send + Sync> = value.clone();
        *last = Some(Last {
            started,
            value: Arc::downgrade(&shared),
        });
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn callers_that_ask_during_a_computation_share_the_next_one() {
        let flights = Arc::new(Flights::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let ask = |flights: Arc<Flights>| {
            let (runs, running, most) = (runs.clone(), running.clone(), most.clone());
            async move {
                flights
                    .share("query-data", || async move {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        running.fetch_sub(1, Ordering::SeqCst);
                        Ok(runs.fetch_add(1, Ordering::SeqCst) + 1)
                    })
                    .await
                    .unwrap()
            }
        };
        let first = tokio::spawn(ask(flights.clone()));
        tokio::time::sleep(Duration::from_millis(20)).await;
        // Four views ask while the first computation runs: none overlaps it,
        // and all four take the one computation that starts after it.
        let later: Vec<_> = (0..4).map(|_| tokio::spawn(ask(flights.clone()))).collect();
        assert_eq!(*first.await.unwrap(), 1);
        let mut values = Vec::new();
        for view in later {
            values.push(view.await.unwrap());
        }
        assert!(values.iter().all(|value| **value == 2));
        assert!(values
            .windows(2)
            .all(|pair| Arc::ptr_eq(&pair[0], &pair[1])));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(most.load(Ordering::SeqCst), 1);
        // A request after both finished computes again: nothing is served stale.
        let again = ask(flights.clone()).await;
        assert_eq!(*again, 3);
    }

    #[tokio::test]
    async fn keys_compute_independently_and_a_failure_is_not_shared() {
        let flights = Flights::default();
        let failed: Result<Arc<u32>> = flights
            .share("leaderboard\u{1f}a", || async {
                Err(super::super::types::BenchmarkError::new(
                    "storage_unavailable",
                    "invented",
                ))
            })
            .await;
        assert!(failed.is_err());
        let a = flights
            .share("leaderboard\u{1f}a", || async { Ok(1u32) })
            .await
            .unwrap();
        let b = flights
            .share("leaderboard\u{1f}b", || async { Ok(2u32) })
            .await
            .unwrap();
        assert_eq!((*a, *b), (1, 2));
    }
}
