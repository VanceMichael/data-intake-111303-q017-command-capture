# 来源与接收约定

input.commands 只允许启动 fixtures/device.mjs，参数仅 mode；以 process.execPath 启动，禁用 shell。stdout 每行 JSON，最后一行为 {trailer:{count,sha256}}，摘要计算此前资料行原始字节。stderr 独立诊断，保存上限 4096 字节。记录 id、运行 uuid 和状态，输出 states/ids/childrenAlive/diagnosticsTruncated。

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
