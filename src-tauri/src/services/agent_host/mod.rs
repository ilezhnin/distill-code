//! The agent host replaces the `goose serve` sidecar: it exposes one local ACP
//! WebSocket to the renderer, spawns the external agent bridges
//! (claude-agent-acp, codex-acp, ...) on demand, and keeps sessions, history,
//! defaults, MCP configuration, and skill/agent/project files itself.

pub mod bridge;
mod ext;
pub mod harness;
mod harness_env;
mod legacy_import;
pub mod protocol;
pub mod router;
mod session_title;
pub mod sources;
pub mod store;

pub use router::AgentHost;
