//! Proof that the listener on the discovery file's port is the broker that
//! wrote the file, checked before anything that matters is sent to it.
//!
//! A discovery file can outlive its app (a crash leaves it until the next
//! start sweeps it), and the port of an app that quit is free for any local
//! process to take. Generation and protocol version prove nothing: any
//! account can read both from a live broker. So the ping carries a fresh
//! random nonce and the broker answers with the lowercase hex SHA-256 of
//! `<token>:<nonce>`, which only a holder of the file's token can compute and
//! which is worth nothing for any other nonce. A listener that cannot prove
//! itself has been sent the nonce and nothing else.
//!
//! The broker computes the proof in its own crate, which the CLI does not
//! depend on. The plugin crate's tests compile this file next to the real
//! broker, so the two sides cannot drift apart: keep it free of `crate::`
//! paths and of anything the plugin does not have (serde, sha2, getrandom).

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The request header the ping carries the nonce in.
pub const NONCE_HEADER: &str = "x-flock-nonce";

/// Bytes of OS randomness in a nonce (sent as 64 hex digits; the broker
/// takes 32 to 128): nobody can guess one or have a proof for it already.
const NONCE_BYTES: usize = 32;

/// What the broker answers a ping with.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResponse {
    pub generation: u64,
    pub protocol_version: u32,
    /// The broker's proof for the nonce the ping carried. Absent when the
    /// ping carried none, and from a listener that is not a broker.
    #[serde(default)]
    pub proof: Option<String>,
}

/// A fresh nonce for one ping: hex of OS randomness, never reused, so a
/// proof the listener has shown before proves nothing now.
pub fn new_nonce() -> Result<String, String> {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut bytes = [0u8; NONCE_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|err| format!("no random nonce could be drawn from the OS ({err})"))?;
    let mut nonce = String::with_capacity(NONCE_BYTES * 2);
    for byte in bytes {
        nonce.push(char::from(DIGITS[usize::from(byte >> 4)]));
        nonce.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    Ok(nonce)
}

/// The proof only the holder of `token` can give for `nonce`.
pub fn expected_proof(token: &str, nonce: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{token}:{nonce}")))
}

/// Whether `proof` shows the listener holds `token`. Missing proves
/// nothing, and neither does an empty token: anyone can hash that.
pub fn proves_token(token: &str, nonce: &str, proof: Option<&str>) -> bool {
    match proof {
        Some(proof) if !token.is_empty() => {
            same_bytes(expected_proof(token, nonce).as_bytes(), proof.as_bytes())
        }
        _ => false,
    }
}

/// Compares without stopping at the first difference, so the time a check
/// takes says nothing about how much of a forged proof was right.
fn same_bytes(expected: &[u8], given: &[u8]) -> bool {
    expected.len() == given.len()
        && expected
            .iter()
            .zip(given)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
