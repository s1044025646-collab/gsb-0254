import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AppError } from "./types";
import { BankerService } from "./service";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    m: RegExpMatchArray
  ) => unknown;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new AppError("BODY_TOO_LARGE", "请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new AppError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createHttpServer(service: BankerService): Server {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/api\/scenarios\/import$/,
      handler: (_req, _res, body) => {
        const b = body as { total: number[]; processes: unknown };
        return service.importScenario({ total: b.total, processes: b.processes as never });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/scenarios\/builtin$/,
      handler: () => service.loadBuiltin(),
    },
    {
      method: "GET",
      pattern: /^\/api\/scenarios\/current$/,
      handler: () => service.check(),
    },
    {
      method: "POST",
      pattern: /^\/api\/safety\/check$/,
      handler: () => service.check(),
    },
    {
      method: "POST",
      pattern: /^\/api\/requests\/trial$/,
      handler: (_req, _res, body) => {
        const b = body as { processId: number; request: number[] };
        return service.trial(b.processId, b.request);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/requests$/,
      handler: (_req, _res, body) => {
        const b = body as { version: number; processId: number; request: number[] };
        return service.request(b.version, b.processId, b.request);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/releases$/,
      handler: (_req, _res, body) => {
        const b = body as { version: number; processId: number; release: number[] };
        return service.release(b.version, b.processId, b.release);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/processes\/(\d+)\/complete$/,
      handler: (_req, _res, body, m) => {
        const b = body as { version: number };
        return service.complete(b.version, Number(m[1]));
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/decisions$/,
      handler: (req) => {
        const url = new URL(req.url!, "http://localhost");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return service.listDecisions(Number.isFinite(limit) ? limit : 100);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/report$/,
      handler: () => {
        const check = service.check();
        return { ...check, decisions: service.listDecisions() };
      },
    },
  ];

  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true });
      }
      const url = (req.url ?? "").split("?")[0];
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url));
      if (!route) return send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${url}` } });
      const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readBody(req) : {};
      const result = route.handler(req, res, body, url.match(route.pattern)!);
      return send(res, 200, { ok: true, data: result });
    } catch (err) {
      if (err instanceof AppError) {
        const status =
          err.code === "STALE_VERSION"
            ? 409
            : err.code === "NOT_FOUND" || err.code === "PROCESS_NOT_FOUND" || err.code === "NO_SCENARIO"
              ? 404
              : 400;
        return send(res, status, { ok: false, error: { code: err.code, message: err.message, details: err.details } });
      }
      console.error(err);
      return send(res, 500, { ok: false, error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

// 选择空闲端口：端口 0 让操作系统分配；若显式指定则使用指定端口。
export function listen(server: Server, preferredPort?: number): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve({ port: addr.port });
      else reject(new Error("无法确定监听端口"));
    });
  });
}
