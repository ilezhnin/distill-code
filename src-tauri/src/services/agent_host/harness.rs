//! The external agent harnesses the host knows how to drive. Each one is an
//! ACP agent speaking JSON-RPC over stdio; the host spawns it on demand and
//! multiplexes every session for that harness over the one process.

#[derive(Debug, Clone, Copy)]
pub struct HarnessSpec {
    /// Stable id used by the frontend (`providerId` / `harnessId`).
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    /// Executable name resolved on the extended PATH (managed shims first).
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// Environment variables stripped before spawning.
    pub env_remove: &'static [&'static str],
    /// Berd agent mode → the bridge's ACP session mode id.
    pub modes: &'static [(&'static str, &'static str)],
}

pub const HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude-acp",
        label: "Claude Code",
        description:
            "Claude Code through the claude-agent-acp bridge, billed to your Claude subscription.",
        command: "claude-agent-acp",
        args: &[],
        // Prevent nested-session detection inside the wrapped Claude Code.
        env_remove: &["CLAUDECODE"],
        modes: &[
            ("auto", "bypassPermissions"),
            ("approve", "default"),
            ("smartApprove", "acceptEdits"),
            ("chat", "plan"),
        ],
    },
    HarnessSpec {
        id: "codex-acp",
        label: "Codex",
        description:
            "OpenAI Codex CLI through the codex-acp bridge, billed to your ChatGPT subscription.",
        command: "codex-acp",
        args: &[],
        env_remove: &[],
        modes: &[
            ("auto", "agent-full-access"),
            ("approve", "read-only"),
            ("smartApprove", "agent"),
            ("chat", "read-only"),
        ],
    },
    HarnessSpec {
        id: "grok-acp",
        label: "Grok",
        description: "xAI's Grok CLI in ACP mode.",
        command: "grok",
        args: &["agent", "stdio"],
        env_remove: &[],
        modes: &[],
    },
    HarnessSpec {
        id: "copilot-acp",
        label: "GitHub Copilot",
        description: "GitHub Copilot CLI in ACP mode.",
        command: "copilot",
        args: &["--acp"],
        env_remove: &[],
        modes: &[
            ("auto", "agent"),
            ("approve", "agent"),
            ("smartApprove", "agent"),
            ("chat", "plan"),
        ],
    },
    HarnessSpec {
        id: "amp-acp",
        label: "Amp",
        description: "Sourcegraph Amp through the amp-acp bridge.",
        command: "amp-acp",
        args: &[],
        env_remove: &[],
        modes: &[
            ("auto", "bypass"),
            ("approve", "default"),
            ("smartApprove", "default"),
            ("chat", "default"),
        ],
    },
];

pub const DEFAULT_AGENT_MODE: &str = "auto";

pub fn harness(id: &str) -> Option<&'static HarnessSpec> {
    HARNESSES.iter().find(|spec| spec.id == id)
}

pub fn bridge_mode(spec: &HarnessSpec, agent_mode: &str) -> Option<&'static str> {
    spec.modes
        .iter()
        .find(|(berd_mode, _)| *berd_mode == agent_mode)
        .map(|(_, bridge_mode)| *bridge_mode)
}
