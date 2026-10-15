// Turns a raw Litter-Robot 4 record into the readable status Lifeboard shows and alerts on.
// The status rules are pylitterbot's LitterRobot4.status (robot/litterrobot4.py).

export interface LitterRobotStatus {
  name: string;
  serial: string;
  online: boolean;
  status: string;
  /** Waste drawer, 0–100. */
  drawerLevel: number;
  drawerFull: boolean;
  /** Litter, 0–100. */
  litterLevel: number;
  /** Last recorded cat weight, lb. */
  catWeight: number;
  laserDirty: boolean;
  lastSeen: string;
}

export const LITTER_ROBOT_STATUSES = [
  "Ready", "Offline", "Off", "Drawer full", "Cat detected", "Cleaning", "Emptying", "Paused",
  "Cat sensor interrupted", "Cat sensor timing", "Bonnet removed", "Powering up", "Powering down", "Unknown",
];

const ROBOT_STATUS: Record<string, string> = {
  ROBOT_BONNET: "Bonnet removed",
  ROBOT_CAT_DETECT: "Cat detected",
  ROBOT_CAT_DETECT_DELAY: "Cat sensor timing",
  ROBOT_CLEAN: "Cleaning",
  ROBOT_EMPTY: "Emptying",
  ROBOT_FIND_DUMP: "Cleaning",
  ROBOT_IDLE: "Ready",
  ROBOT_POWER_DOWN: "Powering down",
  ROBOT_POWER_OFF: "Off",
  ROBOT_POWER_UP: "Powering up",
};

const CYCLE_STATE_STATUS: Record<string, string> = {
  CYCLE_STATE_CAT_DETECT: "Cat sensor interrupted",
  CYCLE_STATE_PAUSE: "Paused",
};

export function litterRobotStatus(robot: Record<string, any>): LitterRobotStatus {
  return {
    name: robot.name ?? "Litter-Robot",
    serial: robot.serial ?? "",
    online: robot.isOnline === true,
    status: statusText(robot),
    drawerLevel: Number(robot.DFILevelPercent ?? 0),
    drawerFull: robot.isDFIFull === true,
    litterLevel: Math.round(Number(robot.litterLevelPercentage ?? 0) * 100),
    catWeight: Number(robot.catWeight ?? 0),
    laserDirty: robot.isLaserDirty === true,
    lastSeen: robot.lastSeen ?? "",
  };
}

function statusText(robot: Record<string, any>): string {
  if (robot.isOnline !== true) return "Offline";
  if (robot.unitPowerStatus !== "ON") return "Off";
  const cycle = CYCLE_STATE_STATUS[robot.robotCycleState];
  if (cycle) return cycle;
  const status = ROBOT_STATUS[robot.robotStatus] ?? "Unknown";
  if (status === "Ready") {
    if (robot.displayCode === "DC_CAT_DETECT") return "Cat detected";
    if (robot.isDFIFull === true) return "Drawer full";
  }
  return status;
}
