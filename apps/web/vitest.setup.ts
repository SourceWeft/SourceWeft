import { registerBuiltinAgentTools } from "./lib/register-builtin-agent-tools";

registerBuiltinAgentTools();

// React only honours act() when the environment opts in. Set it once here
// instead of in every component test; a test that needs the real scheduler
// (long-reply-rendering) turns it off for its own duration.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
