# Sandbox Execution (Alpha)

[English](sandbox-execution.md) | [简体中文](sandbox-execution.zh-CN.md)

SourceWeft can optionally run approved commands in an isolated, temporary sandbox runtime. The sandbox is a scratch execution environment; SourceWeft `/work` remains the durable working-file area.

Mental model:

- `/work` is durable SourceWeft workspace storage.
- Sandbox `/workspace` is temporary and disposable.
- Selected `/work` files may be copied into sandbox `/workspace/input` or `/workspace/work` when a task needs them.
- `/kb` source evidence is not mounted or copied directly into the sandbox.
- With `SOURCEWEFT_SANDBOX_TOOL_APPROVAL_ENABLED=true`, every sandbox command needs human approval before it runs. Copying files in and collecting outputs back do not run commands and need no approval.
- Outputs are not durable until collected back into `/work` or published through a supported artifact pipeline.
- Sandbox-generated outputs are not citable evidence unless verified against citable sources.

The sandbox provider is an operator detail; users should think in terms of an isolated temporary execution environment rather than a specific provider.

See the [Docker installation guide](README.md) for the base deployment. Sandbox execution is optional and requires a configured execution runtime.
