import * as http from "node:http";
import { Service } from "./service";
import { Store } from "./store";
import { ApiError } from "./types";

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = url.pathname.match(/^\/scenarios(?:\/(\d+)(?:\/(check|try|request|release|complete|report))?)?$/);
      const body = await readBody(req);

      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/scenarios") {
        return send(200, service.store.listScenarios());
      }
      if (!m) return send(404, { error: { code: "NOT_FOUND", message: "未知路由" } });

      if (req.method === "POST" && !m[1]) {
        return send(201, service.importScenario(body));
      }
      const id = Number(m[1]);
      const action = m[2];
      if (req.method === "GET" && id && !action) return send(200, service.getScenario(id));
      if (req.method === "POST" && action === "check") return send(200, service.check(id));
      if (req.method === "POST" && action === "try") return send(200, service.tryRequest(id, body));
      if (req.method === "POST" && action === "request") return send(200, service.request(id, body));
      if (req.method === "POST" && action === "release") return send(200, service.release(id, body));
      if (req.method === "POST" && action === "complete") return send(200, service.complete(id, body));
      if (req.method === "GET" && action === "report") return send(200, service.report(id));
      return send(404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof ApiError) {
        const status =
          e.code === "NOT_FOUND" ? 404
          : e.code === "VERSION_CONFLICT" ? 409
          : e.code === "UNSAFE" ? 422
          : 400;
        return send(status, { error: { code: e.code, message: e.message, details: e.details } });
      }
      return send(500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("VALIDATION_ERROR", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

if (require.main === module) {
  const service = new Service(new Store());
  const server = createServer(service);
  // 默认 0：由操作系统选择空闲端口；可用 PORT 环境变量指定。
  const port = process.env.PORT ? Number(process.env.PORT) : 0;
  server.listen(port, () => {
    const addr = server.address();
    console.log(`银行家算法模拟服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
  });
}
