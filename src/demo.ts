import { ScenarioSpec } from "./types";

/** 经典教科书场景：3 类资源、5 个进程，可手算。 */
export const demoScenario: ScenarioSpec = {
  name: "demo-3x5",
  total: [10, 5, 7],
  processes: [
    { name: "P0", max: [7, 5, 3], alloc: [0, 1, 0] },
    { name: "P1", max: [3, 2, 2], alloc: [2, 0, 0] },
    { name: "P2", max: [9, 0, 2], alloc: [3, 0, 2] },
    { name: "P3", max: [2, 2, 2], alloc: [2, 1, 1] },
    { name: "P4", max: [4, 3, 3], alloc: [0, 0, 2] },
  ],
};
