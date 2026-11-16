# 授权设备命令的输出通道采集与批次判定

这是 command-capture 的 Node.js 项目。能力包括本地资料源启动、来源检查、接口演练，以及生产级的本地合成设备命令采集（`src/capture.mjs`）与批次接收工作流（`src/workflow.mjs`）。不做远程登录或任何命令探测，所有进程均为本地受控启动。

## 环境

使用 Node.js 22，最低 22.20.0；Docker 基础镜像按摘要固定，依赖已在 package-lock.json 固定。资料源仅使用本地接口或本地合成设备进程。不需要真实账户、新闻站点连接或生产数据。

开发环境首次安装执行 `npm ci --ignore-scripts --no-audit --no-fund`。构建镜像执行 `docker build -t command-capture:local .`，依赖准备只在这一步进行；正式运行不下载包、浏览器或数据。

## 常用操作

```sh
npm test
npm run build
npm run inspect
npm run source
```

`npm test` 检查资料源、合成设备输出与命令采集器的全部生产能力（白名单、成帧、摘要核对、背压、超时回收、批次身份、落盘恢复）。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

input.commands 只允许启动 fixtures/device.mjs，参数仅 mode；以 process.execPath 启动，禁用 shell。stdout 每行 JSON，最后一行为 {trailer:{count,sha256}}，摘要计算此前资料行原始字节。stderr 独立诊断，保存上限 4096 字节。记录 id、运行 uuid 和状态，输出 states/ids/childrenAlive/diagnosticsTruncated。

### 采集器保证（src/capture.mjs）

- 白名单与参数结构：路径经 `resolveDeviceCommand` 限定为仓库内 fixtures/device.mjs，mode 经 `assertAllowedMode` 限定；`spawn(execPath, argv, { shell: false, detached: true })`，argv 固定为 `[设备路径, mode]`，不存在 shell 拼接面。
- 通道隔离：stdout 按字节逐帧切分（不切断多字节字符），仅资料行进 ndjson 与 sha256；stderr 独立累计、按 4096 字节限量保留前段，截断时在 diagnostics.note 给出总字节与保留字节说明。warning 不参与资料判定。
- 完整性：即使退出码为 0，也必须同时通过尾标存在、count 与实际行数一致、sha256（常量时间比较）与资料行原始字节摘要一致三项核对才判 complete；尾标后任何迟到字节均判失败且不交付。
- 背压：资料行流式写入运行目录，写入侧 `drain` 未排空时读取侧等待，背压经管道传导到子进程，不靠无限内存缓冲。
- 超时与取消：超时关闭提交闸门（迟到输出不再提交），向整个进程组先发 SIGTERM、宽限后 SIGKILL，并轮询确认父进程与设备申报的后代均消失，结果给出 childrenAlive 与 kill 证据。
- 运行身份：启动前分配 runId（uuid），pid 仅用于信号回收；进程号复用、执行器重启、同一设备重复请求都由独立 runId 与独立 runs/<runId>/ 目录隔离。
- 持久化：每次运行完成即原子写 runs/<runId>/run.json；失败/超时另写 records.ndjson.incomplete 标记不交付；result.json 以临时文件 rename 原子落盘，重启只复用可追溯的已落盘运行。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

业务模块已接入，`npm run acceptance` 校验四个契约场景的结果、落盘内容与实际来源访问；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none command-capture:local npm test`。工作流开发完成后执行 `docker run --rm --network none command-capture:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
