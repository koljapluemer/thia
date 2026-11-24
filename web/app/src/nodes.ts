/** The Claude bridge on this computer (`installables/claude-bridge`), which runs the agents: Claude Code, with this app's tools. */
export const AGENT_NODE: string = import.meta.env.VITE_AGENT_NODE ?? 'http://127.0.0.1:7737';

/** The Ollama bridge on this computer (`installables/ollama-bridge`, experimental): a local model, with this app's tools. */
export const OLLAMA_NODE: string = import.meta.env.VITE_OLLAMA_NODE ?? 'http://127.0.0.1:7738';

/** The Codex bridge on this computer, which runs the signed-in Codex CLI with this app's tools. */
export const CODEX_NODE: string = import.meta.env.VITE_CODEX_NODE ?? 'http://127.0.0.1:7739';
