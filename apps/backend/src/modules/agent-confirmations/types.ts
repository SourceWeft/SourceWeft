// The agent-confirmations module is a thin coordination layer that resolves
// human-in-the-loop (HITL) tool confirmations across MCP, connector, and
// sandbox domains.  It does not define its own domain types — all public
// types flow from @sourceweft/contracts and the connectors module.
//
// See runner.ts for the ToolConfirmationRunner implementation.
