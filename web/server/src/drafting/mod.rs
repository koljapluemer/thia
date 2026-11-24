//! Working on a draft with an agent, whoever runs the agent's loop. The draft's tools and the contract are one
//! ([`contract`], [`workbench`]); what differs is the driver's: who owns the loop, how the person is asked, where the
//! files come from and go, who records the run. Those differences are named once, here ([`Driver`]), and read by the
//! code that runs a driver, rather than spread through it.

pub mod contract;
pub mod workbench;

pub use contract::{KindRef, Reference};
pub use workbench::{ToolOut, Workspace};

/// How a driver asks the person something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asking {
    /// with thia's `ask` tool: the card is the page's, and the answer the next turn's
    Tool,
    /// in the host's own conversation: no `ask` tool
    Host,
}

/// Where the draft's files come from and when changes are saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Saving {
    /// the page sends the files with the turn and saves what comes back at its end (through sync)
    PageAtTheEnd,
    /// the server's own ymls, each write validated and saved as it's made
    EachWrite,
}

/// Who writes the run's record (`runs/`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recording {
    /// the page that started the turn, with the events the driver sends it
    Page,
    /// the server, as it sees the tool calls (`runs::ServerRun`)
    Server,
}

/// What follows from who runs the agent's loop. A new driver (another chat host, a page-driven agent the server
/// records) is another of these, not another code path.
#[derive(Debug, Clone, Copy)]
pub struct Driver {
    /// the backend's id in the runs' record
    pub id: &'static str,
    pub asking: Asking,
    pub saving: Saving,
    pub recording: Recording,
    /// whether the model's tokens are known here, and counted against the account's budget
    pub usage_known: bool,
}

/// The server's own agent: thia runs the loop on its API key, a turn at a time (`agent.rs`).
pub const SERVER_AGENT: Driver = Driver { id: "server", asking: Asking::Tool, saving: Saving::PageAtTheEnd, recording: Recording::Page, usage_known: true };

/// A chat host over MCP (claude.ai): the host runs the loop, on the person's own plan (`mcp/`).
pub const MCP: Driver = Driver { id: "mcp", asking: Asking::Host, saving: Saving::EachWrite, recording: Recording::Server, usage_known: false };
