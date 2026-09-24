# 沙箱执行（Alpha）

[English](sandbox-execution.md) | [简体中文](sandbox-execution.zh-CN.md)

SourceWeft 可以在隔离的临时沙箱中运行经批准的命令。沙箱用于临时计算，SourceWeft 的 `/work` 用于持久保存工作文件。

- `/work` 是 SourceWeft 工作空间的持久存储。
- 沙箱中的 `/workspace` 是临时目录，运行环境可被销毁。
- 任务需要时，选定的 `/work` 文件会复制到沙箱的 `/workspace/input` 或 `/workspace/work`。
- `/kb` 中的来源证据不会直接挂载或复制到沙箱。
- 设置 `SOURCEWEFT_SANDBOX_TOOL_APPROVAL_ENABLED=true` 后，每条沙箱命令都需要人工批准才会运行。复制文件进沙箱和收集产出不运行命令，不需要批准。
- 输出只有回收到 `/work` 或通过受支持的成果发布流程保存后，才会持久保留。
- 沙箱生成的内容需要对照可引用来源核实，不能自动成为可引用证据。

沙箱 Provider 属于部署配置；使用时应区分临时执行环境和持久工作文件。

基础部署参见 [Docker 安装说明](README.zh-CN.md)。沙箱执行是可选能力，需要配置执行环境。
