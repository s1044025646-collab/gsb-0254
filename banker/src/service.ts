import { checkSafety, computeAvailable } from "./algorithm";
import {
  builtinScenarioInput,
  evaluateComplete,
  evaluateRelease,
  evaluateRequest,
  importScenario,
  ScenarioInput,
} from "./operations";
import { Store } from "./store";
import { AppError, RequestDecision, SafetyResult, Scenario } from "./types";

export class BankerService {
  constructor(private store: Store) {}

  importScenario(input: ScenarioInput): { scenario: Scenario; safety: SafetyResult } {
    const scenario = importScenario(input);
    this.store.saveScenario(scenario);
    return { scenario, safety: checkSafety(scenario) };
  }

  loadBuiltin(): { scenario: Scenario; safety: SafetyResult } {
    return this.importScenario(builtinScenarioInput());
  }

  getScenario(): Scenario {
    const s = this.store.loadScenario();
    if (!s) throw new AppError("NO_SCENARIO", "尚未导入任何场景，请先 import 或 load-builtin");
    return s;
  }

  check(): { scenario: Scenario; available: number[]; safety: SafetyResult } {
    const scenario = this.getScenario();
    return { scenario, available: computeAvailable(scenario), safety: checkSafety(scenario) };
  }

  // 仅试算，不写库
  trial(processId: number, request: number[]) {
    const scenario = this.getScenario();
    return evaluateRequest(scenario, processId, request);
  }

  request(
    expectedVersion: number,
    processId: number,
    request: number[]
  ): { decision: RequestDecision; safety: SafetyResult } {
    const scenario = this.getScenario();
    const evalResult = evaluateRequest(scenario, processId, request);
    const decision = this.store.commitDecision({
      expectedVersion,
      opType: "request",
      processId,
      requested: request,
      outcome: evalResult.granted ? "granted" : "rejected",
      reasonCode: evalResult.reasonCode,
      reasonMessage: evalResult.reasonMessage,
      safetySequence: evalResult.safety.safe ? evalResult.safety.sequence : null,
      snapshot: scenario,
      newScenario: evalResult.granted ? evalResult.candidate : null,
    });
    return { decision, safety: evalResult.safety };
  }

  release(expectedVersion: number, processId: number, release: number[]): RequestDecision {
    const scenario = this.getScenario();
    const { candidate } = evaluateRelease(scenario, processId, release);
    return this.store.commitDecision({
      expectedVersion,
      opType: "release",
      processId,
      requested: release,
      outcome: "granted",
      reasonCode: null,
      reasonMessage: null,
      safetySequence: null,
      snapshot: scenario,
      newScenario: candidate,
    });
  }

  complete(expectedVersion: number, processId: number): {
    decision: RequestDecision;
    alreadyFinished: boolean;
  } {
    const scenario = this.getScenario();
    const { candidate, alreadyFinished } = evaluateComplete(scenario, processId);
    // 重复完成：记录决策但不改变状态（幂等，不增发资源）
    const decision = this.store.commitDecision({
      expectedVersion,
      opType: "complete",
      processId,
      requested: [],
      outcome: "granted",
      reasonCode: alreadyFinished ? "ALREADY_FINISHED" : null,
      reasonMessage: alreadyFinished ? "进程已完成，重复完成不重复返还资源" : null,
      safetySequence: null,
      snapshot: scenario,
      newScenario: alreadyFinished ? null : candidate,
    });
    return { decision, alreadyFinished };
  }

  listDecisions(limit?: number): RequestDecision[] {
    return this.store.listDecisions(limit);
  }
}
