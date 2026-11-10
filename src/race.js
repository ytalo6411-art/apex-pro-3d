import { beginVisualStep, endVisualStep, resetVisualHistory } from "./graphics/VehicleMotion.js";
import { StrategyDirector } from "./strategy/StrategyDirector.js";
import { RaceControl } from "./regulations/RaceControl.js";
import { RaceTiming } from "./racing/Timing.js";
import { assignStrategy, defaultStrategy } from "./strategy/RaceStrategy.js";
import { liveries } from "./data/liveries.js";
import { updateFlags } from "./racing/Flags.js";
import { updateBattles } from "./ai/Rivalries.js";
import { driverCatalog, pilotPersonality, pilotStats } from "./data/drivers.js";
import { initializeResources, updateResources } from "./strategy/Resources.js";
import { pitInput } from "./strategy/PitStop.js";
import { createDriver, stepCar, collisions, BASE } from "./physics.js";
import { botInput } from "./ai.js";
import { length, activeTrack, TRACK_WIDTH } from "./track.js";

export const drivers = [
  "Você",
  ...driverCatalog.slice(1, 6).map((d) => d.name),
];
export const points = [25, 18, 15, 12, 10, 8];

export const RACE_DISTANCE_PRESETS = {
  short: { id: "short", name: "Curta (Sprint)", laps: 8 },
  medium: { id: "medium", name: "Média (GP Padrão)", laps: 8 },
  long: { id: "long", name: "Longa (GP Completo)", laps: 9 },
  endurance: { id: "endurance", name: "Endurance", laps: 14 },
  custom: { id: "custom", name: "Personalizada", laps: null },
};

export function collisionParticipants(cars) {
  return cars;
}

function rivalMachineryStats(playerStats = BASE, difficulty = "normal", slot = 1) {
  if (!playerStats || playerStats === BASE) return { ...BASE };
  const diffScale =
    { easy: 0.48, normal: 0.82, hard: 0.96, elite: 1.03 }[difficulty] ?? 0.82;
  const teamFactor = Math.max(0.75, 1 - (slot - 1) * 0.032) * diffScale;
  return {
    ...BASE,
    maxSpeed: BASE.maxSpeed + Math.max(0, (playerStats.maxSpeed - BASE.maxSpeed) * teamFactor),
    acceleration:
      BASE.acceleration +
      Math.max(0, (playerStats.acceleration - BASE.acceleration) * teamFactor),
    handling:
      BASE.handling + Math.max(0, (playerStats.handling - BASE.handling) * teamFactor),
    braking:
      BASE.braking + Math.max(0, (playerStats.braking - BASE.braking) * teamFactor),
    grip: BASE.grip + Math.max(0, (playerStats.grip - BASE.grip) * teamFactor),
  };
}

export function updateProgress(car, dt, raceTime, laps) {
  const old = car.previousS,
    s = car.s;
  let delta = s - old;
  if (delta > length / 2) delta -= length;
  if (delta < -length / 2) delta += length;
  if (Math.abs(delta) > 20) {
    car.previousS = s;
    return;
  } // Large displacements never award progress.
  car.progress += delta;
  car.lapTime += dt;
  const next = ((car.checkpoint + 1) * length) / 4;
  if (
    car.checkpoint < 3 &&
    old < next &&
    s >= next &&
    delta > 0 &&
    (Math.abs(car.lateral) < TRACK_WIDTH / 2 + 2 ||
      (car.pit?.state !== "track" && car.pit?.state))
  )
    car.checkpoint++;
  if (
    old > length * 0.85 &&
    s < length * 0.15 &&
    delta > 0 &&
    (Math.abs(car.lateral) < TRACK_WIDTH / 2 + 2 ||
      (car.pit?.state !== "track" && car.pit?.state))
  ) {
    if (!car.startedLap) {
      car.startedLap = true;
      car.lapTime = 0;
    }
    if (car.checkpoint === 3) {
      car.lap++;
      car.lastLap = car.lapTime;
      if (!car.lapInvalid)
        car.bestLap =
          car.bestLap === null
            ? car.lapTime
            : Math.min(car.bestLap, car.lapTime);
      car.lapInvalid = false;
      car.lapTime = 0;
      car.checkpoint = 0;
      if (car.lap >= laps) {
        car.finished = true;
        car.finishTime = raceTime;
        car.speed = 0;
      }
    }
  }
  car.previousS = s;
}

export class Race {
  constructor({
    difficulty = "normal",
    laps = 3,
    stats = BASE,
    championship = false,
    realism = "arcade",
    weather = "dry",
    tire = "medium",
    mode = "quick",
    botCount = 5,
    pilot = 0,
    rivalries = {},
    crewLevel = 0,
    strategy = defaultStrategy(),
    ruleSet,
    weatherProgram = "fixed",
    mechanicalRate = 0,
    seed = 17,
    delegated = false,
    management = false,
    managerOptions = {},
    gridOrder = null,
    roster = null,
    teamIds = null,
    specStats = null,
    sessionType = "race",
    modelIndex = null,
    training = 0,
    teamOrder = "race",
  } = {}) {
    this.localCarId = 0;
    this.trackId = activeTrack.id;
    this.trackName = activeTrack.name;
    this.trackLength = length;
    this.realism = realism;
    this.weather = weather;
    this.mode = mode;
    this.delegated = delegated;
    this.manualControl = null;
    this.weatherProgram = weatherProgram;
    this.sessionType = sessionType;
    this.teamOrder = teamOrder;
    this.flag = "green";
    this.events = [];
    this.eventSerial = 0;
    this.difficulty = difficulty;
    this.laps = laps;
    this.championship = championship;
    this.state = "countdown";
    this.countdown = 5;
    this.time = 0;
    this.finishWait = 0;
    this.done = false;
    this.replayFrames = [];
    this._nextReplaySample = 0;
    Object.defineProperties(this, {
      _standingsCacheKey: { value: null, writable: true, enumerable: false },
      _standingsCache: { value: null, writable: true, enumerable: false },
      _physicalOrderCacheKey: { value: null, writable: true, enumerable: false },
      _physicalOrderCache: { value: null, writable: true, enumerable: false },
    });

    this.cars = drivers
      .slice(0, ["time-trial", "practice"].includes(mode) ? 1 : botCount + 1)
      .map((name, i) => {
        const grid = gridOrder ? gridOrder.indexOf(i) : i === 0 ? 5 : i - 1,
          s = length - 15 - Math.floor(grid / 2) * 10,
          baseStats =
            i === 0
              ? stats
              : rivalMachineryStats(stats, difficulty, i),
          car = createDriver(
            i,
            name,
            s,
            grid % 2 ? 2.8 : -2.8,
            baseStats,
          );
        car.progress = s - length;
        car.number = liveries[i]?.number ?? (i + 1) * 7;
        car.gridPosition = grid + 1;
        car.driverId =
          roster?.[i] ??
          (i === 0 ? pilot : mode === "mega" && i === 1 ? 30 : i);
        car.personality = pilotPersonality(car.driverId);
        if (i !== 0) car.name = driverCatalog[car.driverId]?.name || name;
        car.stats = specStats
          ? { ...BASE, ...specStats }
          : pilotStats(car.stats, car.driverId, mode, realism);
        if (modelIndex !== null) car.modelIndex = modelIndex;
        if (i === 0)
          car.personality.consistency = Math.min(
            0.99,
            car.personality.consistency + Math.min(5, training) * 0.02,
          );
        car.personality.aggression = Math.min(
          0.99,
          car.personality.aggression +
            (rivalries[car.driverId]?.score || 0) * 0.01,
        );
        // 1 active driver per team across the 6 teams (unless explicit teamIds override is passed)
        car.teamId = teamIds && Number.isInteger(teamIds[i]) ? teamIds[i] : i % 6;
        car.teammate = i !== 0 && car.teamId === (teamIds?.[0] ?? 0);
        car.engineTemp = 88;
        initializeResources(car, { laps, realism, weather, tire });
        return car;
      });
    assignStrategy(this, strategy);
    this.timing = new RaceTiming(this.cars, length);
    Object.defineProperty(this, "control", {
      value: new RaceControl(this, {
        ruleSet,
        weatherProgram,
        mechanicalRate,
        seed,
      }),
    });
    if (management) this.enableManagement(managerOptions);
  }
  enableManagement(options = {}) {
    if (!this.manager) this.manager = new StrategyDirector(this, options);
    return this.manager;
  }
  get localCar() {
    return this.cars.find((car) => car.id === this.localCarId) || this.cars[0];
  }
  isLocalCar(car) {
    return car?.id === 0;
  }
  isDelegated() {
    return this.manualControl === null
      ? this.delegated || this.mode === "manager"
      : !this.manualControl;
  }
  emit(type, car = 0, detail = "") {
    this.events.push({
      id: ++this.eventSerial,
      type,
      car,
      detail,
      time: this.time,
    });
    this.control?.log(this.events[this.events.length - 1]);
    if (this.events.length > 150)
      this.events.splice(0, this.events.length - 150);
  }
  invalidateStandingsCache() {
    this._standingsCacheKey = null;
    this._physicalOrderCacheKey = null;
  }
  step(dt, input, autopilot = false) {
    if (!Number.isFinite(dt) || dt <= 0 || this.state === "paused" || this.state === "results") return;
    const previousState = this.state;
    for (const car of this.cars) beginVisualStep(car);
    this.advanceSimulation(dt, input, autopilot);
    for (const car of this.cars) endVisualStep(car, dt);
    if (previousState !== this.state)
      for (const car of this.cars) resetVisualHistory(car);
  }
  advanceSimulation(dt, input, autopilot = false) {
    if (this.state === "paused" || this.state === "results") return;
    this.invalidateStandingsCache();
    if (this.state === "red") {
      this.control.redStep(dt);
      return;
    }
    if (this.state === "countdown") {
      const localCar = this.localCar;
      const canDriveLocal = !this.isDelegated();
      if (
        !autopilot &&
        canDriveLocal &&
        (Number(input?.throttle) > 0 || localCar.speed > 0)
      ) {
        stepCar(localCar, input, dt);
        let d = localCar.s - localCar.previousS;
        if (d < -length / 2) d += length;
        if (d > length / 2) d -= length;
        localCar.progress += d;
        localCar.previousS = localCar.s;
        collisions(this.control.traffic);
      }
      this.control.gridCheck();
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = "racing";
        this.countdown = 0;
        this.emit("start");
        for (const c of this.cars) if (c.s < length * 0.15) c.startedLap = true;
      }
      return;
    }
    this.time += dt;
    const flag = this.flag;
    updateFlags(this, dt);
    if (this.state === "red") return;
    if (flag !== this.flag) this.emit("flag", null, this.flag);
    this.manager?.step(dt);
    this.cars.forEach((c, i) => {
      if (c.finished || c.retired) return;
      c.simTime = this.time;
      const lap = c.lap,
        best = c.bestLap,
        pitState = c.pit.state,
        invalid = c.lapInvalid;
      const guided = i !== 0 || autopilot || this.isDelegated();
      const pit = pitInput(c, dt, guided, this.control.traffic);
      let inp = pit || (guided
        ? botInput(
            c,
            this.control.traffic,
            this.time,
            i === 0 && autopilot ? "hard" : this.difficulty,
          )
        : input || {});
      if (guided && this.time < (1 - (c.personality.startSkill ?? 0.75)) * 0.6)
        inp = { throttle: 0, brake: 1, steer: 0 };
      inp = this.control.constrain(c, inp, dt);
      if (!["service", "release"].includes(c.pit.state)) stepCar(c, inp, dt);
      if (c.pit.state !== "track") c.offroad = false;
      updateResources(c, dt);
      updateProgress(
        c,
        dt,
        this.time,
        this.mode === "practice" ? 999 : this.laps,
      );
      this.timing.update(c, dt, this.time, invalid);
      if (c.lap > lap) {
        this.invalidateStandingsCache();
        this.emit("lap", c.id, c.lastLap);
        if (c.lap === this.laps - 1) this.emit("last-lap", c.id);
        if (c.finished) this.emit("finish", c.id);
      }
      if (c.bestLap !== best && c.bestLap !== null)
        this.emit("personal-best", c.id, c.lastLap);
      if (c.pit.state !== pitState) this.emit("pit", c.id, c.pit.state);
      if (c.penalty !== (c.eventPenalty || 0)) {
        if (c.penalty > (c.eventPenalty || 0))
          this.emit("penalty", c.id, c.penalty);
        c.eventPenalty = c.penalty;
      }
    });
    collisions(this.control.traffic);
    updateBattles(this);
    this.invalidateStandingsCache();
    if (this.time >= this._nextReplaySample && this.replayFrames.length < 180) {
      this._nextReplaySample = this.time + 1.5;
      const order = this.standings();
      this.replayFrames.push({
        t: Number(this.time.toFixed(1)),
        flag: this.flag,
        leader: order[0]?.id ?? 0,
        playerPos: order.findIndex((c) => this.isLocalCar(c)) + 1,
        playerSpeed: Math.round((this.localCar?.speed || 0) * 3.6),
        cars: this.cars.map((c) => ({
          id: c.id,
          x: Math.round(c.x),
          z: Math.round(c.z),
          lap: c.lap,
          pit: c.pit?.state !== "track",
        })),
      });
    }
    if (this.localCar.finished || this.localCar.retired) {
      this.state = "finishing";
      this.finishWait += dt;
      if (
        this.cars.every((c) => c.finished || c.retired) ||
        this.finishWait > Math.max(90, length / 20 + 25)
      ) {
        for (const c of this.cars)
          if (!c.finished && !c.retired) {
            c.retired = true;
            c.retirement = "Tempo limite de encerramento";
            c.speed = c.vx = c.vz = 0;
          }
        this.state = "results";
        this.done = true;
        this.invalidateStandingsCache();
      }
    }
  }
  physicalOrder() {
    let sum = 0;
    for (let i = 0; i < this.cars.length; i++) sum += this.cars[i].progress * (i + 1);
    const key = `${this.time}:${sum}`;
    if (this._physicalOrderCacheKey === key && this._physicalOrderCache)
      return this._physicalOrderCache;
    const sorted = [...this.cars].sort(
      (a, b) => b.progress - a.progress || a.gridPosition - b.gridPosition,
    );
    this._physicalOrderCacheKey = key;
    this._physicalOrderCache = sorted;
    return sorted;
  }
  standings() {
    let sum = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      sum +=
        (c.progress + (c.finishTime || 0) * 10 + (c.bestLap || 0) + c.penalty) *
        (i + 1);
    }
    const key = `${this.sessionType}:${this.time}:${sum}`;
    if (this._standingsCacheKey === key && this._standingsCache)
      return this._standingsCache;
    let sorted;
    if (
      ["practice", "qualifying", "time-attack"].includes(this.sessionType) &&
      this.cars.some((c) => c.bestLap !== null)
    ) {
      sorted = [...this.cars].sort(
        (a, b) =>
          (a.disqualified ? 1 : 0) - (b.disqualified ? 1 : 0) ||
          (a.bestLap ?? Infinity) - (b.bestLap ?? Infinity) ||
          a.gridPosition - b.gridPosition,
      );
    } else {
      sorted = [...this.cars].sort((a, b) =>
        a.disqualified !== b.disqualified
          ? a.disqualified
            ? 1
            : -1
          : a.finished && b.finished
            ? a.finishTime + a.penalty - (b.finishTime + b.penalty)
            : a.finished
              ? -1
              : b.finished
                ? 1
                : b.progress - a.progress || a.gridPosition - b.gridPosition,
      );
    }
    this._standingsCacheKey = key;
    this._standingsCache = sorted;
    return sorted;
  }
  lapsBehind(leader, car) {
    if (!leader || !car || leader === car) return 0;
    const diffMeters = (leader.progress || 0) - (car.progress || 0);
    if (diffMeters < this.trackLength * 0.95) return 0;
    return Math.max(1, Math.floor(diffMeters / this.trackLength));
  }
  results() {
    const order = this.standings();
    const leader = order[0];
    return order.map((c, i) => ({
      id: c.id,
      name: c.name,
      position: i + 1,
      time: c.finishTime === null ? null : c.finishTime + c.penalty,
      penalty: c.penalty,
      bestLap: c.bestLap,
      finished: c.finished,
      lapsBehind: this.lapsBehind(leader, c),
      points: c.finished && !c.disqualified ? points[i] : 0,
      stops: c.pit.stops,
      pitSeconds: c.pit.lifetimeLaneTime || 0,
      driverId: c.driverId,
      teamId: c.teamId,
      gridPosition: c.gridPosition,
      retirement: c.retirement || null,
      disqualified: !!c.disqualified,
      serviceSeconds: c.pit.history.reduce((n, h) => n + h.service, 0),
    }));
  }
  pause() {
    for (const car of this.cars) resetVisualHistory(car);
    if (this.state === "paused") {
      this.state = this.previousState;
      return;
    }
    if (["countdown", "racing", "finishing", "red"].includes(this.state)) {
      this.previousState = this.state;
      this.state = "paused";
    }
  }
}
