//! Host transport for the dedicated repository-benchmark WSL distribution.
//! No candidate or check command is ever launched on Windows.

use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    io,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

mod answers;
mod cleanup;
mod host;
mod identity;
mod location;
mod record;
mod reservation;
mod status;
mod transport;
mod workspace;

pub use self::record::*;
pub(crate) use self::{
    answers::*, cleanup::*, host::*, identity::*, location::*, reservation::*, status::*,
    transport::*, workspace::*,
};

#[cfg(test)]
mod tests;
