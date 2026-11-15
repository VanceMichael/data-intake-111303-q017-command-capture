# 命令采集能力设计

接收部分把“只能跑一个导出命令的旧设备”变成可生产的采集能力：只按白名单清单启动本地合成设备进程，不做远程登录，不做任何命令探测。stdout 是资料，stderr 是诊断，两路从不清混。

## 模块划分

- `manifest/commands.json`：白名单命令清单。唯一命令 `device.export`，以 `process.execPath` 启动 `fixtures/device.mjs`，参数仅 `mode`（枚举），并声明成帧方式与全部限量。
- `src/manifest.mjs`：加载并校验清单，按参数结构构造启动规格。清单之外的命令、参数取值、脚本路径一律拒绝。
- `src/framing.mjs`：`ndjson-trailer-v1` 成帧解析器。
- `src/diagnostics.mjs`：stderr 限量收集与截断记账。
- `src/runner.mjs`：单次运行引擎（背压、超时、取消、进程树清理、判定）。
- `src/journal.mjs`：运行日志落盘与执行器重启扫描。
- `src/workflow.mjs`：批次编排、同设备去重、结果聚合与持久化。

## 启动纪律

`spawn(command, args, { shell: false, detached: true })`：参数永远是数组，绝不拼接 shell；`detached` 让子进程独立成组，取消/超时时按进程组清理整棵进程树。启动前先完成全部命令的纯校验，任何一条越界都不会产生任何子进程。

## 成帧与判定

stdout 每行一个 JSON；资料行在前，最后一行必须是 `{"trailer":{"count":N,"sha256":"..."}}`。摘要 = 此前全部资料行原始字节（含行尾换行）的 sha256。解析是严格模式：非 JSON 行、尾标后还有数据、结尾残留半行（输出截断）都判成帧失败，绝不退化成“在日志里找 JSON”。

最终判定矩阵（先到先生效）：

| 条件 | 判定 |
| --- | --- |
| 超时 | `timeout`，杀进程组，迟到输出不提交 |
| 调用方取消 | `cancelled`，杀进程组 |
| 成帧核验失败（含退出码为 0） | `failed`，reason 为 `framing-*` |
| 尾标与摘要相符但退出码非零/有信号 | `failed`，reason 为 `exit-code-N` / `signal-X` |
| 成帧核验通过且退出码为 0 | `complete`，资料交付 |

诊断里出现 `warning` 行不否定资料：警告只进 `diagnostics.warnings`，不影响判定。资料（`ids`/`records`）只在 `complete` 时交付；失败运行保留 `recordCount` 与观察到的 `trailer` 供排查，但不提交。

## stderr 诊断

独立通道，保存上限 4096 字节（清单 `stderrMaxBytes`）：超出部分丢弃但持续排空（否则子进程阻塞在写管道上），截断处回退到 UTF-8 字符边界。`bytesCaptured`/`bytesDropped`/`truncated` 精确记账，二者之和等于设备实际写出量。

## 背压

stdout 用拉取式消费（`for await`）：`onRecord` 未返回前不再读取，管道缓冲区填满后子进程自然阻塞在写操作上。消费慢不会撑大内存，压力沿管道传回设备。

## 超时、取消与进程树

超时或取消时：先 `SIGTERM` 整个进程组，宽限 `killGraceMs` 后未退出则 `SIGKILL`。子进程已退出但 stdio 被后代持有（后代泄漏）时同样强杀整组，收尾有硬上限，绝不悬挂。判定落定后，迟到的 stdout 不再解析、不再交付；stderr 在限量内继续记账到进程关闭。运行结束后按诊断中声明的 `childPid` 逐个探测，输出 `childrenAlive`/`descendantsAlive`。

## 运行身份

- 身份只用 `runId`（uuid）。`pid` 仅是观察信息，进程号复用不影响身份。
- 每条运行落盘 `stateDir/runs/<runId>.json`，带 `bootId`（执行器进程诞生标识）。执行器重启后，上一 boot 的未完结运行在扫描阶段判定 `aborted`（`executor-restart`），恢复只依赖落盘记录。
- 同一设备同一时刻至多一个真实运行：相同参数的重复请求共享同一 `runId`（`deduped`，不重复交付）；参数冲突的重复请求明确 `rejected`，不占用设备状态位。

## 批次与结果脚本

同一批次的设备命令并发运行，部分成功单独交付：`states` 按设备给最终判定，`ids` 只聚合 `complete` 运行的资料，`runs` 给出每个运行的完整细节（资料、诊断截断说明、退出信息、判定与原因、时间）。返回结果与 `stateDir/result.json` 一致（临时文件改名落盘）。
