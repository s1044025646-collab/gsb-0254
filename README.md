# 银行家算法资源安全申请模拟后端

操作系统教学用的资源分配模拟服务。仅提供 HTTP API 与 CLI，不启动真实子进程、
不实现分布式锁/租约/任务队列，也不涉及任何银行业务。

- TypeScript + Node.js（>= 22，使用内置 `node:sqlite`，无原生依赖）
- SQLite 持久化：场景版本、每次申请决定（含拒绝）与当时场景快照、每次安全检查过程
- Windows 本地运行，不依赖 Docker / WSL / 在线服务

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部单元测试
npm run demo       # 运行内置演示（导入场景 -> 检查 -> 拒绝 -> 批准 -> 完成）
npm start          # 启动 HTTP 服务（默认由系统分配空闲端口）
```

端口通过环境变量 `PORT` 指定；不设置时传 0，由操作系统选择空闲端口并打印实际端口。
数据目录默认为项目内 `data/`，可用环境变量 `BANKER_DATA_DIR` 覆盖。

## 核心概念

- 场景（scenario）：资源总量向量 `total` + 若干命名进程，每个进程有最大需求 `max`
  与当前已分配 `alloc`，均为同维度非负整数向量。
- 安全性检查：计算 `available = total - Σalloc`，每轮按进程编号升序选择第一个
  剩余需求 `need = max - alloc <= available` 的未完成进程，假设其完成并归还全部
  分配，直到全部完成（安全，返回该确定序列及每步向量变化）或无法继续
  （不安全，列出卡住进程及每类不足资源）。不安全不等于此刻已发生真实死锁。
- 申请流程：校验（非负整数向量、维度、进程存在、request <= need、
  request <= available）-> 暂分配 -> 完整安全性检查。只有安全才在事务中原子
  保存新状态并推进版本；拒绝时所有数量与版本保持不变（仅记录决定）。
  绝不用“总量足够”或“当前请求可满足”替代安全性检查。
- 乐观并发：所有变更操作必须携带当前 `version`，不匹配返回 `VERSION_CONFLICT`，
  状态不变。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/scenarios` | 列出场景 |
| POST | `/scenarios` | 导入场景 `{name, total[], processes:[{name,max[],alloc[]}]}` |
| GET | `/scenarios/:id` | 查看场景 |
| POST | `/scenarios/:id/check` | 安全性检查（记录检查过程） |
| POST | `/scenarios/:id/try` | 试算申请 `{process, request[]}`，不持久化 |
| POST | `/scenarios/:id/request` | 正式申请 `{process, request[], version}` |
| POST | `/scenarios/:id/release` | 主动释放 `{process, release[], version}` |
| POST | `/scenarios/:id/complete` | 完成进程 `{process, version}`，返还全部分配 |
| GET | `/scenarios/:id/report` | 导出报告（场景、决定、检查历史） |

### 错误码

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 非法输入（负数、非整数、alloc>max、释放超过已分配等） |
| `DIMENSION_MISMATCH` | 400 | 向量维度与资源种类数不一致 |
| `NOT_FOUND` | 404 | 场景或进程不存在 |
| `REQUEST_EXCEEDS_NEED` | 400 | 申请超过剩余最大需求 |
| `REQUEST_EXCEEDS_AVAILABLE` | 400 | 申请超过当前可用量 |
| `VERSION_CONFLICT` | 409 | 陈旧版本，操作被拒绝且状态不变 |
| `ALREADY_COMPLETED` | 400 | 进程已完成（重复完成不会重复增发资源） |

安全性拒绝不属于错误：`request` 返回 200 且 `approved: false`、`reason: "UNSAFE"`，
并附完整检查报告（含卡住进程与不足资源），与输入错误明确区分。

## CLI

```powershell
npm run cli -- import scenario.json     # 导入场景
npm run cli -- list                     # 列出场景
npm run cli -- show <id>                # 查看场景
npm run cli -- check <id>               # 安全性检查
npm run cli -- try <id> <进程> <r...>            # 试算（不持久化）
npm run cli -- request <id> <进程> <版本> <r...> # 正式申请
npm run cli -- release <id> <进程> <版本> <r...> # 主动释放
npm run cli -- complete <id> <进程> <版本>       # 完成进程
npm run cli -- report <id> [out.json]   # 导出报告
npm run cli -- demo                     # 内置演示
npm run cli -- serve                    # 启动 HTTP 服务
```

## 内置演示场景

经典教科书场景：3 类资源 `total=[10,5,7]`，进程 P0–P4。`npm run demo` 依次展示：

1. 当前状态安全，序列 `P1 -> P3 -> P0 -> P2 -> P4`（含每步可用向量变化）；
2. P4 申请 `[3,3,0]`：可用量足够，但暂分配后不安全，被拒绝且状态不变；
3. P4 调整为 `[1,0,0]`：安全，批准；
4. 完成 P1，返还其全部分配；
5. 再次检查仍安全。

## 测试

`npm test` 覆盖：零需求、零申请、已分配超过最大值、总量不足、多个安全序列、
没有可完成进程、维度错误；300 组随机小规模场景与“枚举全部完成顺序”的独立
基准交叉核对，并逐步验证报告中的可用向量与资源守恒；拒绝与陈旧版本不改持久化
状态；重复完成不增发资源；关闭并重新打开数据库后可读取先前决定与当时场景快照。

`node test/api.smoke.cjs` 为 HTTP 端到端冒烟脚本（需先 `npm run build`）。

## 已知限制

- 进程只是数据记录，不模拟并发执行；安全性是静态快照判断。
- 单文件 SQLite、单进程服务，未做鉴权与多用户隔离。
- `node:sqlite` 在 Node 25 仍标记为实验特性，启动时会有 ExperimentalWarning。
