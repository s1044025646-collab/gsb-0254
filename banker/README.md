# 银行家算法资源安全申请模拟后端

操作系统教学用的**资源分配模拟服务**。用整数向量描述多类资源总量、各命名进程的最大需求 `max` 与当前已分配 `allocation`，判断当前分配是否存在让所有活动进程依次完成的**安全序列**，并模拟一次资源申请是否可以批准。

- 技术栈：TypeScript + Node.js，数据库使用 Node **内置 `node:sqlite`**（无需 C++ 编译、无需 better-sqlite3）。
- 形态：仅 HTTP API + CLI，无前端、无 Docker/WSL、无外部在线服务。
- 进程只是数据记录：不启动真实子进程，不做分布式锁/租约/任务队列，与银行业务无关。
- 数据目录位于项目内 `data/`。

## 环境要求

- Windows 本地，Node.js **22.5+ / 24 / 25**（内置 `node:sqlite`，本项目实测 Node v25.5.0）。
- npm。`node:sqlite` 运行时会打印一条 ExperimentalWarning，属正常现象，不影响功能。

## 安装、构建、测试、启动、演示

```powershell
cd banker
npm install        # 仅安装 typescript / tsx / @types/node，无原生依赖
npm run build      # 编译到 dist/
npm test           # 运行 15 个 node:test 用例
npm start          # 启动 HTTP API（默认让系统分配空闲端口）
npm run demo       # 直接用 tsx 运行完整教学演示（也可 node dist/cli.js demo）
```

指定端口与数据文件：

```powershell
node dist/cli.js serve --port 7070 --db data/banker.sqlite
```

不传 `--port` 时监听端口 `0`，由操作系统选择空闲端口，启动时打印实际地址。

## 银行家安全性检查（核心）

每轮：

1. 计算可用向量 `available = total - Σ allocation`，剩余需求 `need = max - allocation`。
2. 在所有未完成进程中，选择满足 `need <= available` 的进程；**固定选择规则：编号最小者**（编号在导入时从 0 顺序分配，保证结果确定可复现）。
3. 假设该进程完成，归还其 `allocation` 到 `available`，记录该步的 `availableBefore / needBefore / released / availableAfter`。
4. 直到全部活动进程完成（安全），或一轮中找不到可运行进程（不安全）。

不安全时返回：

- 已完成的部分序列；
- 每个卡住进程的 `need`、当前 `available` 与逐类资源的 `shortfall` 缺口。

> 注意：**不安全状态不等于此刻已经发生真实死锁**，只表示不存在能保证所有进程完成的顺序。“资源总量足够”或“本次请求当前可满足”都**不能**替代完整安全性检查——本实现始终在暂分配后重跑完整检查。

## 申请处理流程

按顺序校验，错误输入与安全性拒绝用**不同错误码**区分：

1. 申请是非负整数向量，维度与资源数一致（`INVALID_REQUEST` / `DIMENSION_MISMATCH`）；
2. 进程存在且未完成（`PROCESS_NOT_FOUND` / `PROCESS_FINISHED`）；
3. 请求不超过剩余需求（`REQUEST_EXCEEDS_NEED`）；
4. 请求不超过当前可用（返回拒绝 `REQUEST_EXCEEDS_AVAILABLE`，非异常）；
5. **暂分配**后运行完整安全性检查：不安全则拒绝（`UNSAFE_AFTER_GRANT`）；
6. 只有安全时，在一个 SQLite 事务中**原子保存**新状态（版本 +1）并写入决定；拒绝时数量与版本保持不变。

请求必须携带 `version`（乐观并发/陈旧操作检测）。版本不符返回 HTTP **409 `STALE_VERSION`**，且不写库。

其他操作：

- `release`：主动释放不超过持有量的资源（`RELEASE_EXCEEDS_ALLOCATION`）。
- `complete`：完成进程，返还全部持有量并标记 `finished`；**重复完成幂等，不重复返还**（决定中标记 `ALREADY_FINISHED`）。

## 持久化

SQLite 文件默认 `data/banker.sqlite`（开启 WAL）。表：

- `scenario`：当前场景（单行），含 `version` 与完整 JSON；
- `decisions`：每次申请/释放/完成的决定、原因码、安全序列、评估时间，以及**决策当时的完整场景快照 `snapshot`**。

服务重启后可读取先前场景、历史决定与当时快照。提交逻辑为单事务：版本检查 → 条件更新场景 → 写决定。

## HTTP API

统一返回 `{ ok: true, data: ... }`，错误返回 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/scenarios/import` | 导入场景 `{total, processes:[{name,max,allocation?}]}` |
| POST | `/api/scenarios/builtin` | 加载内置 3 类资源 5 进程场景 |
| GET | `/api/scenarios/current` | 当前场景 + 可用向量 + 安全检查 |
| POST | `/api/safety/check` | 重新执行安全性检查 |
| POST | `/api/requests/trial` | 只试算 `{processId, request}`，不落库 |
| POST | `/api/requests` | 原子申请 `{version, processId, request}` |
| POST | `/api/releases` | 释放 `{version, processId, release}` |
| POST | `/api/processes/:id/complete` | 完成 `{version}` |
| GET | `/api/decisions?limit=100` | 历史决定 |
| GET | `/api/report` | 场景 + 逐步安全检查 + 历史决定 |

示例（PowerShell）：

```powershell
Invoke-RestMethod http://127.0.0.1:7070/api/scenarios/builtin -Method Post
Invoke-RestMethod http://127.0.0.1:7070/api/requests -Method Post `
  -ContentType 'application/json' `
  -Body '{"version":1,"processId":0,"request":[0,0,2]}'
```

## CLI

```powershell
node dist/cli.js help
node dist/cli.js load-builtin
node dist/cli.js check
node dist/cli.js trial 0 [0,0,2]
node dist/cli.js request 0 [0,0,1] --version 1
node dist/cli.js release 1 [1,0,0] --version 2
node dist/cli.js complete 3 --version 3
node dist/cli.js decisions
node dist/cli.js report --out data/report.json
node dist/cli.js import examples/scenario.json
node dist/cli.js demo
```

## 内置教学场景与演示结论

资源总量 `[10,5,7]`，进程 P0–P4（见 `examples/scenario.json`）。初始可用 `[3,3,2]`，确定性安全序列：

```
P1 -> P3 -> P0 -> P2 -> P4
```

`demo` 命令依次展示：

1. 初始安全序列与每步向量变化；
2. **P0 请求 `[0,0,2]`：当前可用 `[3,3,2]` 足以支付，但暂分配后无安全序列 → 拒绝 `UNSAFE_AFTER_GRANT`**，状态不变；
3. 调整为 P0 请求 `[0,0,1]` → 安全，批准，版本 +1；
4. 完成 P3 → 返还 `[2,1,1]`；
5. 再次完成 P3 → 幂等，可用量不二次增加。

## 测试覆盖

`test/banker.test.ts`（15 个用例）：

- 安全序列与逐步 work 向量、资源守恒（归还后 work 最终等于总量）；
- 零需求进程、零申请；
- 已分配超过最大需求、总量不足、维度错误、负数向量；
- 多个安全序列（验证确定性选编号最小）、没有任何可完成进程；
- “资源足够但暂分配后不安全”的拒绝；
- 独立基准：小规模**枚举全部完成顺序** `existsSafeSequenceByEnumeration` 与贪心结论交叉核对，并用 200 组随机小场景验证一致性与守恒；
- 拒绝与陈旧版本不改变持久化状态；重复完成不增发资源；重启后可读取决定与当时快照。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_TOTAL` / `INVALID_PROCESSES` / `INVALID_MAX` / `INVALID_ALLOCATION` | 导入数据非法 |
| `DIMENSION_MISMATCH` | 向量维度与资源数不一致 |
| `ALLOCATION_EXCEEDS_MAX` | 已分配超过最大需求 |
| `TOTAL_RESOURCES_INSUFFICIENT` | 分配之和超过资源总量 |
| `PROCESS_NOT_FOUND` / `PROCESS_FINISHED` | 进程不存在 / 已完成 |
| `INVALID_REQUEST` / `INVALID_RELEASE` | 非非负整数向量 |
| `REQUEST_EXCEEDS_NEED` | 申请超过剩余需求 |
| `REQUEST_EXCEEDS_AVAILABLE` | 申请超过当前可用（拒绝，非异常） |
| `UNSAFE_AFTER_GRANT` | 暂分配后不安全（安全性拒绝） |
| `RELEASE_EXCEEDS_ALLOCATION` | 释放超过持有量 |
| `STALE_VERSION` (HTTP 409) | 请求基于过期版本 |
| `NO_SCENARIO` (HTTP 404) | 尚未导入场景 |
| `INVALID_JSON` / `BODY_TOO_LARGE` / `NOT_FOUND` | 请求格式 / 路由错误 |

## 合理假设

- 所有资源为可重用的整数计数资源，申请/释放按整类计数，不区分单个实例。
- 编号在导入时从 0 顺序分配并作为稳定身份；完成后编号保留、状态置 `finished`。
- 释放/完成恒使状态更宽松，故直接放行并记录（仍做不变量校验）；申请是唯一可能引入不安全的操作，因此走完整暂分配 + 安全性检查。
- 单进程本地使用，版本号用于拒绝陈旧的客户端操作而非多用户高并发锁。
