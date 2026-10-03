#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeAvailable, existsSafeSequenceByEnumeration } from "./algorithm";
import { builtinScenarioInput } from "./operations";
import { createHttpServer, listen } from "./server";
import { Store } from "./store";
import { BankerService } from "./service";
import { AppError, SafetyResult } from "./types";

interface CliOptions {
  db: string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = "true";
    } else positional.push(a);
  }
  return { positional, flags };
}

function printSafety(safety: SafetyResult): void {
  if (safety.safe) {
    console.log(`安全: 是`);
    console.log(`安全序列: ${safety.sequenceNames.join(" -> ")}`);
    for (const st of safety.steps) {
      console.log(
        `  步骤${st.order} ${st.processName}: work ${JSON.stringify(st.availableBefore)} ` +
          `需求 ${JSON.stringify(st.needBefore)} 归还 ${JSON.stringify(st.released)} -> ${JSON.stringify(st.availableAfter)}`
      );
    }
  } else {
    console.log(`安全: 否（当前不安全，并不等于此刻已经发生真实死锁）`);
    console.log(`已完成部分序列: ${safety.sequenceNames.join(" -> ") || "(空)"}`);
    for (const b of safety.blocked) {
      console.log(
        `  卡住 ${b.processName}: 需求 ${JSON.stringify(b.need)} 可用 ${JSON.stringify(b.available)} ` +
          `缺口 ${JSON.stringify(b.shortfall)}`
      );
    }
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const command = positional[0] ?? "help";
  const dbPath = resolve(flags.db ?? "data/banker.sqlite");
  const store = new Store(dbPath);
  const service = new BankerService(store);

  try {
    switch (command) {
      case "import": {
        const file = positional[1];
        if (!file) throw new AppError("USAGE", "用法: cli import <scenario.json>");
        const input = JSON.parse(readFileSync(file, "utf-8"));
        const { scenario, safety } = service.importScenario(input);
        console.log(`已导入场景，版本 ${scenario.version}，可用 ${JSON.stringify(computeAvailable(scenario))}`);
        printSafety(safety);
        break;
      }
      case "load-builtin": {
        const { scenario, safety } = service.loadBuiltin();
        console.log(`已加载内置场景，版本 ${scenario.version}`);
        printSafety(safety);
        break;
      }
      case "check": {
        const { available, safety } = service.check();
        console.log(`当前版本 ${service.getScenario().version}，可用 ${JSON.stringify(available)}`);
        printSafety(safety);
        break;
      }
      case "trial":
      case "request": {
        const processId = Number(positional[1]);
        const vector = JSON.parse(positional[2] ?? "[]");
        if (command === "trial") {
          const r = service.trial(processId, vector);
          console.log(r.granted ? "试算: 可批准（安全）" : `试算: 拒绝 [${r.reasonCode}] ${r.reasonMessage}`);
          printSafety(r.safety);
        } else {
          const version = Number(flags.version ?? service.getScenario().version);
          const { decision, safety } = service.request(version, processId, vector);
          console.log(`决定 #${decision.id}: ${decision.outcome}${decision.reasonCode ? " [" + decision.reasonCode + "]" : ""}`);
          if (decision.reasonMessage) console.log(decision.reasonMessage);
          printSafety(safety);
        }
        break;
      }
      case "release": {
        const processId = Number(positional[1]);
        const vector = JSON.parse(positional[2] ?? "[]");
        const version = Number(flags.version ?? service.getScenario().version);
        const d = service.release(version, processId, vector);
        console.log(`释放决定 #${d.id}: ${d.outcome}`);
        break;
      }
      case "complete": {
        const processId = Number(positional[1]);
        const version = Number(flags.version ?? service.getScenario().version);
        const { decision, alreadyFinished } = service.complete(version, processId);
        console.log(`完成决定 #${decision.id}: ${alreadyFinished ? "进程此前已完成（幂等，未重复返还）" : "已完成并返还资源"}`);
        break;
      }
      case "decisions": {
        for (const d of service.listDecisions()) {
          console.log(
            `#${d.id} v${d.scenarioVersion} ${d.type} pid=${d.processId} req=${JSON.stringify(d.requested)} ` +
              `${d.outcome}${d.reasonCode ? " " + d.reasonCode : ""} @${d.evaluatedAt}`
          );
        }
        break;
      }
      case "report": {
        const report = {
          ...service.check(),
          enumBenchmarkSafe: existsSafeSequenceByEnumeration(service.getScenario()),
          decisions: service.listDecisions(),
        };
        const out = flags.out ? resolve(flags.out) : null;
        const text = JSON.stringify(report, null, 2);
        if (out) {
          writeFileSync(out, text, "utf-8");
          console.log(`报告已导出到 ${out}`);
        } else console.log(text);
        break;
      }
      case "serve": {
        const server = createHttpServer(service);
        const port = flags.port ? Number(flags.port) : undefined;
        const { port: actual } = await listen(server, port);
        console.log(`银行家模拟服务已启动: http://127.0.0.1:${actual}`);
        console.log(`数据库: ${dbPath}`);
        await new Promise(() => {});
        break;
      }
      case "demo": {
        await runDemo(service);
        break;
      }
      case "help":
      default:
        console.log(
          [
            "银行家算法资源安全申请模拟 - CLI",
            "用法: banker <命令> [参数] [--db data/banker.sqlite]",
            "命令:",
            "  import <file.json>            导入场景",
            "  load-builtin                  加载内置教学场景",
            "  check                         安全性检查",
            "  trial <pid> [a,b,c]           只试算不落库",
            "  request <pid> [a,b,c] --version N   原子申请（带版本）",
            "  release <pid> [a,b,c] --version N   主动释放",
            "  complete <pid> --version N    完成并归还（幂等）",
            "  decisions                     列出历史决定",
            "  report [--out report.json]    导出报告（含枚举基准）",
            "  serve [--port 7070]           启动 HTTP API（默认空闲端口）",
            "  demo                          运行完整教学演示",
          ].join("\n")
        );
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

// 教学演示：安全序列 -> 资源足够但暂分配后不安全被拒 -> 调整后成功 -> 完成进程释放
async function runDemo(service: BankerService): Promise<void> {
  console.log("=== 1. 加载内置场景 ===");
  const { scenario } = service.loadBuiltin();
  console.log(`资源总量 ${JSON.stringify(scenario.total)}`);
  console.log("初始安全检查:");
  printSafety(service.check().safety);

  console.log("\n=== 2. 一笔资源当前足够、但暂分配后不安全的申请（P0 请求 [0,0,2]）===");
  let v = service.getScenario().version;
  let r = service.request(v, 0, [0, 0, 2]);
  console.log(`结果: ${r.decision.outcome} [${r.decision.reasonCode}] ${r.decision.reasonMessage ?? ""}`);
  printSafety(r.safety);
  console.log(`拒绝后版本仍为 ${service.getScenario().version}，数量未变化`);

  console.log("\n=== 3. 调整申请：P0 改为 [0,0,1]，应成功 ===");
  v = service.getScenario().version;
  r = service.request(v, 0, [0, 0, 1]);
  console.log(`结果: ${r.decision.outcome}，新版本 ${service.getScenario().version}`);

  console.log("\n=== 4. 完成 P3，返还其全部资源 ===");
  v = service.getScenario().version;
  const c = service.complete(v, 3);
  console.log(c.alreadyFinished ? "已完成过" : "P3 已完成并归还");
  console.log("完成后安全检查:");
  printSafety(service.check().safety);

  console.log("\n=== 5. 重复完成 P3（幂等，不增发资源）===");
  v = service.getScenario().version;
  const c2 = service.complete(v, 3);
  console.log(c2.alreadyFinished ? "确认：重复完成未重复返还" : "异常");
  console.log(`可用资源: ${JSON.stringify(computeAvailable(service.getScenario()))}`);
}

void main();
