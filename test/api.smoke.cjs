// API 冒烟测试：node test/api.smoke.cjs（需先 npm run build）
process.env.BANKER_DATA_DIR = require("node:path").join(__dirname, "..", "data-smoke");
const { Service } = require("../dist/src/service");
const { Store } = require("../dist/src/store");
const { createServer } = require("../dist/src/server");

async function main() {
  const svc = new Service(new Store());
  const server = createServer(svc);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const sc = await call("POST", "/scenarios", {
    name: "api",
    total: [3],
    processes: [{ name: "A", max: [2], alloc: [1] }],
  });
  console.log("import:", sc.status, "id=", sc.body.id);
  const id = sc.body.id;
  console.log("check:", (await call("POST", `/scenarios/${id}/check`)).body.safe);
  const req = await call("POST", `/scenarios/${id}/request`, { process: "A", version: 0, request: [1] });
  console.log("request:", req.status, req.body.approved, "version", req.body.version);
  const stale = await call("POST", `/scenarios/${id}/complete`, { process: "A", version: 0 });
  console.log("stale:", stale.status, stale.body.error.code);
  const done = await call("POST", `/scenarios/${id}/complete`, { process: "A", version: 1 });
  console.log("complete:", done.status, "version", done.body.version);
  const bad = await call("POST", `/scenarios/${id}/request`, { process: "A", version: 2, request: [1, 2] });
  console.log("bad-dim:", bad.status, bad.body.error.code);
  server.close();
  svc.store.close();
  require("node:fs").rmSync(process.env.BANKER_DATA_DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
