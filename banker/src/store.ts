// 使用 Node 内置 node:sqlite（Node 22+/25 可用），无需任何原生编译依赖。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppError, RequestDecision, Scenario } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenario (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scenario_version INTEGER NOT NULL,
  op_type TEXT NOT NULL,
  process_id INTEGER NOT NULL,
  requested TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  reason_message TEXT,
  safety_sequence TEXT,
  snapshot TEXT NOT NULL,
  evaluated_at TEXT NOT NULL
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  saveScenario(s: Scenario): void {
    const data = JSON.stringify(s);
    this.db
      .prepare(
        `INSERT INTO scenario (id, data, version, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data=excluded.data, version=excluded.version, updated_at=excluded.updated_at`
      )
      .run(data, s.version, s.updatedAt);
  }

  loadScenario(): Scenario | null {
    const row = this.db.prepare("SELECT data FROM scenario WHERE id = 1").get() as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Scenario) : null;
  }

  // 在一个事务内：校验版本 -> 条件性落库新状态 -> 记录决策。
  // 拒绝 / 版本陈旧时不修改场景数据。
  commitDecision(params: {
    expectedVersion: number;
    opType: "request" | "release" | "complete";
    processId: number;
    requested: number[];
    outcome: "granted" | "rejected";
    reasonCode: string | null;
    reasonMessage: string | null;
    safetySequence: number[] | null;
    snapshot: Scenario;
    newScenario: Scenario | null; // 仅 granted 时非空
  }): RequestDecision {
    const current = this.loadScenario();
    if (!current) throw new AppError("NO_SCENARIO", "尚未导入任何场景");
    if (current.version !== params.expectedVersion) {
      throw new AppError(
        "STALE_VERSION",
        `版本陈旧：请求基于版本 ${params.expectedVersion}，当前版本为 ${current.version}`
      );
    }

    const insertDecision = this.db.prepare(
      `INSERT INTO decisions
       (scenario_version, op_type, process_id, requested, outcome, reason_code, reason_message, safety_sequence, snapshot, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.exec("BEGIN IMMEDIATE");
    let id: number;
    try {
      if (params.outcome === "granted" && params.newScenario) {
        this.saveScenario(params.newScenario);
      }
      const info = insertDecision.run(
        params.expectedVersion,
        params.opType,
        params.processId,
        JSON.stringify(params.requested),
        params.outcome,
        params.reasonCode,
        params.reasonMessage,
        params.safetySequence ? JSON.stringify(params.safetySequence) : null,
        JSON.stringify(params.snapshot),
        new Date().toISOString()
      );
      id = Number(info.lastInsertRowid);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getDecision(id)!;
  }

  getDecision(id: number): RequestDecision | null {
    const row = this.db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(id) as DecisionRow | undefined;
    return row ? rowToDecision(row) : null;
  }

  listDecisions(limit = 100): RequestDecision[] {
    const rows = this.db
      .prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as DecisionRow[];
    return rows.map(rowToDecision);
  }

  close(): void {
    this.db.close();
  }
}

interface DecisionRow {
  id: number;
  scenario_version: number;
  op_type: string;
  process_id: number;
  requested: string;
  outcome: string;
  reason_code: string | null;
  reason_message: string | null;
  safety_sequence: string | null;
  snapshot: string;
  evaluated_at: string;
}

function rowToDecision(r: DecisionRow): RequestDecision {
  return {
    id: r.id,
    scenarioVersion: r.scenario_version,
    type: r.op_type as RequestDecision["type"],
    processId: r.process_id,
    requested: JSON.parse(r.requested),
    outcome: r.outcome as RequestDecision["outcome"],
    reasonCode: r.reason_code,
    reasonMessage: r.reason_message,
    safetySequence: r.safety_sequence ? JSON.parse(r.safety_sequence) : null,
    evaluatedAt: r.evaluated_at,
    snapshot: JSON.parse(r.snapshot),
  };
}
