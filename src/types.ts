export interface ProcessSpec {
  name: string;
  max: number[];
  alloc: number[];
  completed?: boolean;
}

export interface ScenarioSpec {
  name: string;
  total: number[];
  processes: ProcessSpec[];
}

export interface ProcessState extends ProcessSpec {
  index: number;
  completed: boolean;
}

export interface ScenarioState {
  id: number;
  name: string;
  total: number[];
  version: number;
  processes: ProcessState[];
}

export interface SafetyStep {
  process: string;
  index: number;
  workBefore: number[];
  allocation: number[];
  workAfter: number[];
}

export interface StuckProcess {
  process: string;
  index: number;
  need: number[];
  work: number[];
  deficient: { resource: number; needed: number; available: number }[];
}

export interface SafetyReport {
  safe: boolean;
  sequence: string[];
  steps: SafetyStep[];
  stuck: StuckProcess[];
  initialAvailable: number[];
  total: number[];
  note?: string;
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DIMENSION_MISMATCH"
  | "REQUEST_EXCEEDS_NEED"
  | "REQUEST_EXCEEDS_AVAILABLE"
  | "VERSION_CONFLICT"
  | "ALREADY_COMPLETED"
  | "UNSAFE";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}
