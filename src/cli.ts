import * as fs from "node:fs";
import { Service } from "./service";
import { Store } from "./store";
import { demoScenario } from "./demo";
import { ApiError } from "./types";

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function fail(e: unknown): never {
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}] ${e.message}`);
    if (e.details) console.error(JSON.stringify(e.details));
  } else {
    console.error(String(e));
  }
  process.exit(1);
}

const usage = `用法: node dist/src/cli.js <命令> [参数]
  import <file.json>                导入场景
  list                              列出场景
  show <id>                         查看场景
  check <id>                        安全性检查（输出安全序列与向量变化）
  try <id> <process> <req...>       试算申请（不持久化）
  request <id> <process> <version> <req...>   正式申请（安全才保存）
  release <id> <process> <version> <rel...>   主动释放
  complete <id> <process> <version>           完成进程并返还资源
  report <id> [out.json]            导出报告
  demo                              运行内置演示
  serve                             启动 HTTP 服务（默认空闲端口，PORT 可配置）`;

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const svc = new Service(new Store());
  try {
    switch (cmd) {
      case "import": {
        const spec = JSON.parse(fs.readFileSync(args[0], "utf8"));
        out(svc.importScenario(spec));
        break;
      }
      case "list":
        out(svc.store.listScenarios());
        break;
      case "show":
        out(svc.getScenario(Number(args[0])));
        break;
      case "check":
        out(svc.check(Number(args[0])));
        break;
      case "try":
        out(svc.tryRequest(Number(args[0]), { process: args[1], request: args.slice(2).map(Number) }));
        break;
      case "request":
        out(
          svc.request(Number(args[0]), {
            process: args[1],
            version: Number(args[2]),
            request: args.slice(3).map(Number),
          })
        );
        break;
      case "release":
        out(
          svc.release(Number(args[0]), {
            process: args[1],
            version: Number(args[2]),
            release: args.slice(3).map(Number),
          })
        );
        break;
      case "complete":
        out(svc.complete(Number(args[0]), { process: args[1], version: Number(args[2]) }));
        break;
      case "report": {
        const r = svc.report(Number(args[0]));
        if (args[1]) {
          fs.writeFileSync(args[1], JSON.stringify(r, null, 2));
          console.log(`报告已写入 ${args[1]}`);
        } else out(r);
        break;
      }
      case "demo":
        runDemo(svc);
        break;
      case "serve": {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createServer } = require("./server");
        const server = createServer(svc);
        const port = process.env.PORT ? Number(process.env.PORT) : 0;
        server.listen(port, () => {
          const addr = server.address();
          console.log(`服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
        });
        return; // 不关闭 store
      }
      default:
        console.log(usage);
    }
  } catch (e) {
    fail(e);
  } finally {
    if (cmd !== "serve") svc.store.close();
  }
}

function runDemo(svc: Service) {
  console.log("== 1. 导入内置场景（3 类资源，5 个进程）==");
  const s = svc.importScenario(demoScenario);
  console.log(`场景 id=${s.id} version=${s.version} total=${JSON.stringify(s.total)}`);

  console.log("\n== 2. 当前状态安全性检查 ==");
  const rep = svc.check(s.id);
  console.log(`安全: ${rep.safe}, 安全序列: ${rep.sequence.join(" -> ")}`);
  for (const st of rep.steps) {
    console.log(
      `  ${st.process}: work ${JSON.stringify(st.workBefore)} + alloc ${JSON.stringify(st.allocation)} = ${JSON.stringify(st.workAfter)}`
    );
  }

  console.log("\n== 3. P4 申请 [3,3,0]：可用量足够，但暂分配后不安全，应被拒绝 ==");
  let v = svc.getScenario(s.id).version;
  const bad = svc.request(s.id, { process: "P4", version: v, request: [3, 3, 0] });
  console.log(`批准: ${bad.approved}, 原因: ${bad.reason ?? "-"}`);
  if (bad.report) {
    console.log(`卡住进程: ${bad.report.stuck.map((x) => x.process).join(", ") || "(无)"}`);
    console.log(`说明: ${bad.report.note ?? ""}`);
  }

  console.log("\n== 4. P4 调整为申请 [1,0,0]：安全，批准 ==");
  v = svc.getScenario(s.id).version;
  const ok = svc.request(s.id, { process: "P4", version: v, request: [1, 0, 0] });
  console.log(`批准: ${ok.approved}, 新版本: ${ok.version}`);

  console.log("\n== 5. 完成 P1，返还全部分配 ==");
  const done = svc.complete(s.id, { process: "P1", version: ok.version });
  console.log(`完成，新版本: ${done.version}`);
  const after = svc.getScenario(s.id);
  console.log(`P1 状态: completed=${after.processes.find((p) => p.name === "P1")!.completed}`);

  console.log("\n== 6. 再次检查安全性 ==");
  const rep2 = svc.check(s.id);
  console.log(`安全: ${rep2.safe}, 安全序列: ${rep2.sequence.join(" -> ")}`);
  console.log("\n演示完成。可用 `npm run cli -- report " + s.id + "` 导出完整报告。");
}

main();
