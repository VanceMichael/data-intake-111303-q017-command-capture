# 来源与接收约定

input.commands 只允许启动 fixtures/device.mjs，参数仅 mode；以 process.execPath 启动，禁用 shell。stdout 每行 JSON，最后一行为 {trailer:{count,sha256}}，摘要计算此前资料行原始字节。stderr 独立诊断，保存上限 4096 字节。记录 id、运行 uuid 和状态，输出 states/ids/childrenAlive/diagnosticsTruncated。

## 采集判定规则（src/capture.mjs）

- 进程以 argv 数组、`shell:false`、独立进程组（detached）启动；白名单路径与 mode 在工作流入站时校验，非法请求状态为 rejected 且不启动进程。
- stdout 按字节逐帧解析，资料行原始字节流式写入 `runs/<runId>/records.ndjson` 并累计 sha256；stderr 与 stdout 完全独立，诊断只进 diagnostics.log，截断保留前 4096 字节并在 note 说明总字节数。
- 终态只有 complete / failed / timeout / rejected 四种。退出码为 0 仍须通过尾标存在、count 一致、sha256 常量时间比对一致才 complete；尾标后出现任何字节、坏 JSON、超长行、落盘失败、退出码非零均为 failed；超过 timeoutMs 为 timeout。
- 超时立即关闭提交闸门，之后到达的 stdout/stderr 一律不解析、不落盘；随后对整个进程组 SIGTERM、宽限 200ms 后 SIGKILL，并以 kill(pid,0) 轮询确认父进程与后代全部消失，childrenAlive 为复核结果而非假设。
- 运行身份是启动前生成的 runId(uuid)，pid 只用于信号回收；每次运行独占 runs/<runId>/ 目录，run.json 与 result.json 均临时文件+rename 原子写入。重启恢复只读取已落盘 run.json，损坏或缺失则忽略，不凭空补进度。
- 资料行落盘走可写流背压：writableNeedDrain 时等待 drain，消费慢会经管道反压到子进程。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 警告不否定完整资料

业务输入：
```json
{
  "commands": [
    {
      "device": "one",
      "mode": "warning"
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "one": "complete"
  },
  "ids": [
    "sample-1"
  ]
}
```

### 完整尾标后异常退出仍失败

业务输入：
```json
{
  "commands": [
    {
      "device": "one",
      "mode": "bad-exit"
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "one": "failed"
  },
  "ids": []
}
```

### 取消要结束后代进程

业务输入：
```json
{
  "commands": [
    {
      "device": "one",
      "mode": "descendant",
      "timeoutMs": 100
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "one": "timeout"
  },
  "ids": [],
  "childrenAlive": 0
}
```

### 交错诊断不进入数据通道

业务输入：
```json
{
  "commands": [
    {
      "device": "one",
      "mode": "interleave"
    }
  ]
}
```
结果必须包含：
```json
{
  "states": {
    "one": "complete"
  },
  "ids": [
    "sample-1"
  ],
  "diagnosticsTruncated": true
}
```
