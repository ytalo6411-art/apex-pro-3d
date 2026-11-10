import { recordManager } from "../strategy/ManagerHistory.js";
import { managerAction, managerChange } from "./ManagerActions.js";
import { driverCatalog } from "../data/drivers.js";
import { competitionAction, finishCompetition } from "./CompetitionActions.js";
import { careerTeams } from "../championships/Catalog.js";
import { assignStrategy, validateStrategy } from "../strategy/RaceStrategy.js";
import { liveries } from "../data/liveries.js";
import { setPlan } from "../strategy/PitStrategy.js";
import { assignTeam } from "../career/TeamManager.js";
import { FixedStep } from "./GameLoop.js";
import { configureTrack, activeTrack } from "../track.js";
import { trackById } from "../data/tracks.js";
import { nextCamera } from "../camera/CameraManager.js";
import { requestPit } from "../strategy/PitStop.js";
import { RaceEngineer } from "../audio/RaceEngineer.js";
import { AdminPanel } from "../admin/AdminPanel.js";
import { handleExtraAction } from "./ExtraActions.js";
import { World } from "../renderer.js";
import { Controls } from "../controls.js";
import { Race } from "../race.js";
import { recover } from "../physics.js";
import { MIN_RACE_LAPS, clampRaceLaps } from "../racing/RaceConfig.js";
import { load, save as persist } from "../save.js";
import { performance as carStats, purchase } from "../garage.js";
import { rewardRace, unlock } from "../progression.js";
import { rounds, resetSeason } from "../championship.js";
import { UI } from "../ui.js";
import { AudioEngine } from "../audio.js";
export class Game {
  constructor() {
    this.save = load();
    configureTrack(this.save.settings.track);
    this.loop = new FixedStep();
    this.admin = new AdminPanel();
    this.engineer = new RaceEngineer();
    this.engineer.configure(this.save.settings);
    this.fps = 60;
    this.lastRender = 0;
    this.renderElapsed = 0;
    this.errors = [];
    window.addEventListener("error", (e) => {
      this.errors.push(String(e.message).slice(0, 200));
      this.errors = this.errors.slice(-20);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.errors.push(String(e.reason).slice(0, 200));
      this.errors = this.errors.slice(-20);
    });
    this.race = null;
    this.lastReward = null;
    this.world = new World(document.querySelector("#world"));
    this.world.quality(this.save.settings);
    this.world.setPreview(this.save.selectedCar);
    this.world.setPaint(this.save.selectedPaint);
    this.world.customization = this.save.customizations[this.save.selectedCar];
    this.world.pilotColor = this.save.selectedDriver;
    this.audio = new AudioEngine();
    this.audio.configure(this.save.settings);
    this.controls = new Controls(
      (blur) => this.pause(blur),
      () => {
        if (this.race?.state === "racing" && !this.race.isDelegated()) {
          recover(this.race.localCar || this.race.cars[0]);
          this.ui.toast("Carro recuperado. Volte à disputa.");
        }
      },
    );
    this.controls.options = {
      active: () =>
        !!this.race &&
        this.ui?.page === "race" &&
        !this.ui?.modal &&
        !this.loadingTrack,
      camera: () => this.ui.toast(nextCamera(this.world)),
      pit: () => this.action("pit"),
      radio: () => this.engineer.report(this.race),
    };
    this.controls.configure(this.save.settings);
    this.ui = new UI(this);
    this.ui.render();
    this.last = performance.now();
    this.acc = 0;
    this.pendingSaveError = false;
    requestAnimationFrame((t) => this.frame(t));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause(true);
      this.audio.setHidden(document.hidden);
      if (document.hidden) this.engineer.stop();
      this.last = performance.now();
      this.acc = 0;
      this.loop.reset();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && this.ui.modal) {
        const nodes = [
          ...document.querySelectorAll(
            "#modal button:not(:disabled),#modal input,#modal select",
          ),
        ];
        const first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });
  }
  store() {
    if (this.admin.active) {
      try {
        localStorage.setItem("apex-dynasty-lab-v1", JSON.stringify(this.save));
      } catch {}
      return;
    }
    if (!persist(this.save) && !this.pendingSaveError) {
      this.pendingSaveError = true;
      this.ui.toast(
        "O cache local está indisponível. Verifique o navegador e tente novamente.",
      );
    }
  }
  start(champ = false) {
    if (this.loadingTrack) return;
    if (champ && this.save.championship.results.length >= 3) return;
    this.ui.closeModal();
    this.controls.clear();
    const ctx = this.launchContext;
    this.simulating = !!ctx?.fast;
    const track = ctx
      ? ctx.track
      : champ
        ? rounds[this.save.championship.results.length].track
        : this.save.settings.track;
    this.switchTrack(track);
    const laps = champ
      ? rounds[this.save.championship.results.length].laps
      : this.save.settings.mode === "endurance"
        ? Math.max(MIN_RACE_LAPS, clampRaceLaps(this.save.settings.laps))
        : clampRaceLaps(this.save.settings.laps);
    this.race = new Race({
      difficulty: this.save.settings.difficulty,
      laps,
      stats: carStats(this.save),
      championship: champ,
      realism: this.save.settings.realism,
      weather: this.save.settings.weather,
      tire: this.save.settings.tire,
      mode: champ ? "quick" : this.save.settings.mode,
      botCount: champ ? 5 : this.save.settings.bots,
      teamIds: [0, 1, 2, 3, 4, 5],
      pilot: this.save.selectedDriver,
      rivalries: this.save.rivalries,
      crewLevel: this.save.team.development,
      training: this.save.career.training,
      strategy: this.save.settings.aiStrategy,
      delegated: this.save.settings.controlMode !== "manual",
      weatherProgram: this.save.settings.weatherProgram,
      mechanicalRate: this.save.settings.mechanicalRate,
      ruleSet: this.save.settings.ruleSet,
      specStats: null,
      seed: 17,
      ...(ctx?.options || {}),
    });
    this.race.manualControl = ctx
      ? !ctx.options.delegated
      : this.save.settings.controlMode === "manual";
    this.race.teamBaseStats = carStats(this.save);
    setPlan(this.race.cars[0], this.save.settings.pitPlan);
    this.race.cars[0].number =
      this.save.customizations[this.save.selectedCar]?.number ??
      liveries[this.save.selectedCar].number;
    if (!ctx) assignTeam(this.race, this.save);
    else {
      for (const c of this.race.cars) {
        c.number = driverCatalog[c.driverId].number;
        if (c.teamId === this.race.cars[0].teamId)
          c.crewLevel = Math.min(
            5,
            this.save.team.development +
              (careerTeams.find((t) => t.id === this.race.cars[0].teamId)
                ?.crew || 0),
          );
      }
    }
    for (const c of this.race.cars)
      if (c.id !== 0 && c.teamId === this.race.cars[0].teamId)
        c.personality.consistency = Math.min(
          0.99,
          c.personality.consistency +
            Math.min(5, this.save.career.training) * 0.02,
        );
    this.race.enableManagement({
      plans: this.save.settings.managerPlans,
      objective: this.save.settings.managerObjective,
      points: ctx?.managerPoints || {},
    });
    this.race.carIndex = ctx?.options.modelIndex ?? this.save.selectedCar;
    this.lastManagerReport = null;
    this.world.focusId = 0;
    this.world.raceContext = this.race;
    this.race.cars.forEach((c) => {
      c.assistance = this.save.settings.assistance;
    });
    this.engineer.reset();
    this.loop.reset();
    this.world.setWeather(this.save.settings.weather);
    this.lastReward = null;
    this.world.customization = this.save.customizations[this.save.selectedCar];
    this.world.setMode("race", this.race.cars);
    this.ui.page = "race";
    this.ui.render();
    if (!this.world.assetsReady) {
      const preparing = this.world;
      this.ui.toast("Preparando recursos do circuito…");
      preparing.ready
        .then(() => {
          if (this.world === preparing)
            this.ui.toast(
              preparing.assetErrors.length
                ? "Recursos incompletos; verifique a conexão e recarregue."
                : "Circuito pronto.",
            );
        })
        .catch((error) => {
          console.error("Falha na preparação da corrida", error);
          if (this.world === preparing)
            this.ui.toast("Falha ao preparar o circuito. Recarregue a página.");
        });
    }
    this.audio.start();
    this.audio.configure(this.save.settings);
    this.acc = 0;
    this.last = performance.now();
    this.bindTouch();
  }
  bindTouch() {
    const apply = (id, active) => {
      const t = this.controls.touch;
      if (id === "throttle") t.throttle = active ? 1 : 0;
      if (id === "brake") t.brake = active ? 1 : 0;
      if (id === "left") t.steer = active ? -1 : 0;
      if (id === "right") t.steer = active ? 1 : 0;
    };
    document.querySelectorAll("[data-touch]").forEach((b) => {
      if (b.dataset.touchBound) return;
      b.dataset.touchBound = "1";
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try {
          b.setPointerCapture(e.pointerId);
        } catch {}
        apply(b.dataset.touch, true);
      });
      for (const ev of ["pointerup", "pointercancel", "lostpointercapture"])
        b.addEventListener(ev, () => apply(b.dataset.touch, false));
    });
  }
  pause(onlyPause = false) {
    if (!this.race) {
      if (!onlyPause && this.ui.modal) this.ui.closeModal();
      return;
    }
    if (this.race.state === "results") return;
    if (onlyPause && this.race.state === "paused") return;
    this.race.pause();
    this.controls.clear();
    if (this.race.state === "paused") {
      this.engineer.stop();
      this.ui.showModal("pause");
    } else this.ui.closeModal();
    this.acc = 0;
    this.loop.reset();
  }
  finish() {
    if (this.lastReward) return;
    recordManager(this);
    if (this.launchContext) {
      finishCompetition(this);
      return;
    }
    this.lastReward = rewardRace(this.save, this.race);
    this.store();
    this.audio.beep(800, 0.4);
    this.ui.showModal("results");
  }
  setStrategy(key, value) {
    this.save.settings.aiStrategy = validateStrategy({
      ...this.save.settings.aiStrategy,
      [key]: value,
    });
    if (this.race?.manager) {
      const field =
        key === "pace"
          ? {
              pace: {
                economy: "conserve",
                balanced: "balanced",
                attack: "aggressive",
                qualifying: "maximum",
                recovery: "balanced",
              }[value],
            }
          : { [key]: value };
      this.race.manager.order(this.world.focusId || 0, field);
    } else if (this.race)
      assignStrategy(this.race, this.save.settings.aiStrategy);
    this.controls.clear();
    this.store();
  }
  setting(key, value) {
    if (
      [
        "mechanicalRate",
        "resolution",
        "shadows",
        "particles",
        "detail",
        "volume",
        "engineVolume",
        "musicVolume",
        "crowdVolume",
        "effectsVolume",
        "voiceVolume",
        "laps",
        "bots",
        "sensitivity",
        "deadzone",
        "radioFrequency",
      ].includes(key)
    )
      value = Number(value);
    if (
      ["resolution", "shadows", "particles", "effects", "detail"].includes(
        key,
      ) &&
      this.save.settings.quality !== "custom"
    ) {
      for (const k of [
        "resolution",
        "shadows",
        "particles",
        "effects",
        "detail",
      ])
        this.save.settings[k] = this.world.graphics[k];
    }
    if (key === "laps") value = clampRaceLaps(value);
    this.save.settings[key] = value;
    if (key === "raceDistancePreset") {
      const presetLaps = { short: 8, medium: 8, long: 9, endurance: 14 }[value];
      if (presetLaps) this.save.settings.laps = presetLaps;
    }
    if (key === "laps") {
      const match = { 8: "medium", 9: "long", 14: "endurance" }[value];
      this.save.settings.raceDistancePreset = match || "custom";
    }
    if (key === "hudMode") {
      const root = document.getElementById("race-hud");
      if (root) root.dataset.mode = value;
      const label = document.getElementById("hud-mode-label");
      if (label)
        label.textContent = {
          standard: "PADRÃO",
          compact: "COMPACTO",
          immersive: "IMERSIVO",
        }[value];
    }
    if (key === "weather" && value === "rain") {
      this.save.settings.tire = "wet";
      for (const p of this.save.settings.managerPlans) p.start = "wet";
    }
    if (key === "tire")
      for (const p of this.save.settings.managerPlans) p.start = value;
    if (key === "mode" && value === "endurance")
      this.save.settings.realism = "realistic";
    this.store();
    this.audio.configure(this.save.settings);
    this.engineer.configure(this.save.settings);
    this.controls.configure(this.save.settings);
    if (key === "track" && !this.race) {
      this.loadTrack(value, { modal: this.ui.modal || "setup" });
    }
    if (
      [
        "quality",
        "resolution",
        "shadows",
        "particles",
        "effects",
        "detail",
        "autoQuality",
      ].includes(key)
    ) {
      if (!["quality", "autoQuality"].includes(key))
        this.save.settings.quality = "custom";
      this.world.quality(this.save.settings);
      this.store();
      if (this.ui.modal === "settings") this.ui.showModal("settings");
    }
    if (
      this.ui.modal &&
      ["setup", "champ-setup"].includes(this.ui.modal) &&
      key !== "track"
    )
      this.ui.showModal(this.ui.modal);
  }
  managerChange(el) {
    return managerChange(this, el);
  }
  action(action, data = {}) {
    if (managerAction(this, action, data)) return;
    if (competitionAction(this, action, data)) return;
    if (
      [
        "setup",
        "champ-setup",
        "results-home",
        "results-champ",
        "confirm-exit",
      ].includes(action)
    )
      this.launchContext = null;
    if (handleExtraAction(this, action, data)) return;
    switch (action) {
      case "setup":
        this.switchTrack(this.save.settings.track);
        this.ui.showModal("setup");
        break;
      case "champ-setup":
        this.switchTrack(
          rounds[this.save.championship.results.length]?.track || "aurora",
        );
        this.ui.showModal("champ-setup");
        break;
      case "settings":
      case "help":
      case "new-season":
        this.ui.showModal(action);
        break;
      case "ranking-tab":
        this.ui.rankingTab = data.tab || "laps";
        this.ui.render();
        break;
      case "close":
        if (this.race?.state === "paused") this.ui.showModal("pause");
        else this.ui.closeModal();
        break;
      case "difficulty":
        this.setting("difficulty", data.key);
        this.ui.showModal(this.ui.modal);
        break;
      case "start":
        this.start(false);
        break;
      case "start-champ":
        this.start(true);
        break;
      case "pause":
        this.pause();
        break;
      case "resume":
        this.pause();
        break;
      case "restart":
        this.start(this.race?.championship);
        break;
      case "exit-race":
      case "results-home":
        this.race = null;
        this.controls.clear();
        this.ui.navigate("home");
        break;
      case "results-champ":
        this.race = null;
        this.ui.navigate("championship");
        break;
      case "car": {
        const id = Number(data.id);
        if (this.save.unlockedCars.includes(id)) {
          this.save.selectedCar = id;
          this.store();
          this.world.customization = this.save.customizations[id];
          this.world.setPreview(id);
          this.ui.render();
          this.ui.toast("Carro selecionado. Pronto para a próxima largada.");
        }
        break;
      }
      case "paint":
        if (this.save.unlockedPaints.includes(data.id)) {
          this.save.selectedPaint = data.id;
          delete this.save.customizations[this.save.selectedCar];
          this.world.customization = null;
          this.world.setPreview(this.save.selectedCar);
          this.world.setPaint(data.id);
          this.store();
          this.ui.render();
        }
        break;
      case "upgrade": {
        const res = purchase(this.save, data.key);
        if (res.ok) {
          const rewards = unlock(this.save);
          this.store();
          this.ui.render();
          this.ui.toast(
            rewards.length ? res.message + " · " + rewards[0] : res.message,
          );
        } else this.ui.toast(res.message);
        break;
      }
      case "confirm-season":
        this.save.championship = resetSeason(this.save.championship);
        this.store();
        this.ui.closeModal();
        this.ui.render();
        this.ui.toast("Nova temporada. Uma nova chance de fazer história.");
        break;
    }
  }
  async loadTrack(id, { modal = null, page = false } = {}) {
    if (this.race && !this.race.done) return false;
    const token = (this.trackLoadToken = (this.trackLoadToken || 0) + 1);
    this.loadingTrack = true;
    this.controls.clear();
    let overlay = document.getElementById("track-loading");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "track-loading";
      overlay.setAttribute("role", "status");
      document.body.appendChild(overlay);
    }
    overlay.innerHTML =
      '<div class="loading-mark"></div><b>PREPARANDO CIRCUITO</b><span>' +
      trackById(id).name +
      "</span>";
    try {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (token !== this.trackLoadToken) return false;
      this.switchTrack(id);
      await this.world.ready;
      if (this.world.assetErrors.length)
        this.ui.toast(
          "Recursos incompletos neste circuito. Verifique a conexão e recarregue; detalhes no console.",
        );
      if (token !== this.trackLoadToken) return false;
      this.save.settings.track = trackById(id).id;
      this.store();
      if (page) {
        this.ui.page = "tracks";
        this.ui.modal = null;
        this.ui.render();
        this.world.setMode("track-preview");
      }
      if (modal) this.ui.showModal(modal);
      this.last = performance.now();
      this.loop.reset();
      return true;
    } catch (error) {
      console.error("Falha ao carregar circuito", error);
      this.ui.toast("Falha ao carregar circuito. Tente novamente.");
      return false;
    } finally {
      if (token === this.trackLoadToken) {
        this.loadingTrack = false;
        overlay.remove();
      }
    }
  }
  switchTrack(id) {
    if (activeTrack.id === id) return;
    const container = this.world.container;
    this.world.dispose();
    configureTrack(id);
    this.world = new World(container);
    this.world.quality(this.save.settings);
    this.world.setPreview(this.save.selectedCar);
    this.world.setPaint(this.save.selectedPaint);
    this.world.customization = this.save.customizations[this.save.selectedCar];
  }
  frame(t) {
    const elapsed = Math.max(0, (t - this.last) / 1000),
      dt = Math.min(elapsed, 0.2);
    this.last = t;
    this.fps += (1 / Math.max(0.001, elapsed) - this.fps) * 0.05;
    if (this.race && this.world.assetsReady) {
      const input = this.controls.input();
      const scale = this.race.state === "finishing" ? 4 : 1;
      if (this.simulating) {
        this.loop.reset();
        for (
          let n = 0;
          n < 120 && !this.race.done && this.race.state !== "paused";
          n++
        )
          this.race.step(1 / 60, {}, false);
      } else
        for (let i = 0; i < scale; i++)
          this.loop.advance(
            elapsed,
            (d) => this.race.step(d, input),
            ["paused", "results"].includes(this.race.state),
          );
      this.ui.updateHUD(this.race, t);
      const wet = this.race.control.weather;
      const visual = wet.rain > 0.12 ? "rain" : "dry";
      if (this.world.weather !== visual) this.world.setWeather(visual);
      this.world.rainIntensity = wet.rain;
      if (this.race.done && !this.lastReward) this.finish();
    }
    this.engineer.update(this.race);
    this.audio.tick(this.race, this.ui, this.world.venues);
    this.world.observeFrame(
      elapsed,
      !!this.race && this.race.state === "racing",
    );
    this.renderElapsed += dt;
    const renderInterval =
      this.race &&
      ["countdown", "racing", "finishing"].includes(this.race.state)
        ? 0
        : 1000 / 30;
    if (
      this.world.container.style.display !== "none" &&
      t - this.lastRender >= renderInterval
    ) {
      this.world.render(
        Math.min(this.renderElapsed, 0.25),
        this.race?.cars || [],
        this.race?.state || "menu",
        this.race?.countdown || 0,
        this.simulating ? 1 : this.loop.accumulator / this.loop.step,
      );
      this.lastRender = t;
      this.renderElapsed = 0;
    }
    requestAnimationFrame((n) => this.frame(n));
  }
}
