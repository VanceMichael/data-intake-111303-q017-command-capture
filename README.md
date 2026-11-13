# 授权设备命令的输出通道采集与批次判定

这是 command-capture 的 Node.js 项目。现有能力是本地资料源启动、来源检查和接口演练；资料接收工作流由单独的业务模块承载，当前版本不含该模块。

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

`npm test` 检查已有资料源与接口读取。`npm run build` 做全部 JavaScript 源码语法检查，不生成运行时依赖。`npm run source` 启动回环服务并打印地址，`SOURCE_CASE=1 npm run source` 可切换异常场景。

## 工作流接入

业务入口约定为 `src/workflow.mjs` 导出的异步 `run({ source, stateDir, input })`。source 是本地资料源地址，input 是业务输入，stateDir 是跨次执行保留的状态目录。调用结束返回结构化业务结果，并将相同结果持久化至 stateDir/result.json，其他持久状态布局由业务模块决定。不能依赖调用方持有的内存来完成恢复。

input.commands 只允许启动 fixtures/device.mjs，参数仅 mode；以 process.execPath 启动，禁用 shell。stdout 每行 JSON，最后一行为 {trailer:{count,sha256}}，摘要计算此前资料行原始字节。stderr 独立诊断，保存上限 4096 字节。记录 id、运行 uuid 和状态，输出 states/ids/childrenAlive/diagnosticsTruncated。

完整来源约定、输出示例与状态判定见 `docs/source-contract.md`。fixtures 下的资料只用于本地演练，代表不同供方响应或门户状态，不是资料接收器的实现。

## 业务核对与短演示

```sh
npm run acceptance
npm run demo
```

业务模块接入后运行上述命令。当前版本运行会明确报告业务模块不存在，不把来源测试通过当作接收工作流已完成。acceptance 检查结果、落盘内容和实际来源访问；demo 从干净临时状态启动本地服务，实际执行前三种情况并完整输出结果及请求，不回放记录。每种情形应在 15 秒内完成，整次演示在 75 秒超时后报失败退出，预留在 90 秒内展示的余量。

容器内执行基线检查：`docker run --rm --network none command-capture:local npm test`。工作流开发完成后执行 `docker run --rm --network none command-capture:local npm run demo`。容器内回环端口可用；正式核对过程不连接外部网络。
