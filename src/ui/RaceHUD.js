import { managerPanel, updateManager } from "./ManagerUI.js";
import { icon } from "../icons.js";
import { pitTeams, bayFor } from "../strategy/PitLayout.js";
import { compounds } from "../strategy/Resources.js";
import { strategyOptions } from "../strategy/RaceStrategy.js";
import { gearFor, rpmFor, shiftNeeded } from "../racing/Telemetry.js";
import { driverCatalog } from "../data/drivers.js";
export const clock = (t) =>
  t == null
    ? "—"
    : `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, "0")}`;
const html = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
export function strategyPanel(settings, preRace = false) {
  const fields = Object.entries(strategyOptions)
    .map(
      ([key, d]) =>
        `<label>${d.label}<select aria-label="${d.label}" data-ai-setting="${key}">${d.options.map(([id, name]) => `<option value="${id}" ${settings.aiStrategy[key] === id ? "selected" : ""}>${name}</option>`).join("")}</select></label>`,
    )
    .join("");
  return `<details class="race-strategy ${preRace ? "strategy-preset" : ""}" ${!preRace && settings.strategyOpen ? "open" : ""}><summary>ESTRATÉGIA DE CORRIDA <span>＋</span></summary><div class="strategy-body"><p>Perfil global da IA: adversários e pilotos delegados. Volante manual preservado. Alterações aplicadas na próxima decisão segura.</p><div class="strategy-fields">${fields}</div>${!preRace ? '<label class="team-order">ORDEM DE EQUIPE<select data-team-order><option value="race">Disputa livre</option><option value="protect">Proteger posição</option><option value="yield">Ceder ao carro principal</option></select></label>' : ""}<small>Volta lançada é um ritmo de ataque, não uma sessão de qualificatória. Planos explícitos de paradas continuam no painel BOXES.</small></div></details>`;
}
export function renderRaceHUD(ui) {
  const g = ui.game,
    r = g.race,
    s = g.save.settings;
  ui.hudCache = null;
  ui.managerLast = -Infinity;
  ui.hudEventTime = 0;
  ui.hudAlertQueue = [];
  ui.hudAlertUntil = 0;
  ui.hudLastPosition = null;
  ui.hudPositionMap = new Map();
  ui.lastHUD = -Infinity;
  return `<section id="race-hud" class="rc-hud" data-mode="${s.hudMode}" data-driving="${r.isDelegated() ? "manager" : "manual"}" aria-label="HUD de corrida">
 <header class="hud-top"><div class="hud-brand"><strong>APEX<span>DYNASTY</span><i>LIVE</i></strong><small>${html(r.trackName)}</small></div><div class="hud-clocks"><div><small>VOLTA</small><b id="hud-lap">1 / ${r.laps}</b></div><div><small>VOLTA ATUAL</small><b id="hud-time">0:00.000</b></div><div class="hud-reference"><small>MELHOR PESSOAL</small><b id="hud-best">—</b></div><div class="hud-reference"><small>Δ MELHOR DA SESSÃO</small><b id="hud-delta">—</b></div><div class="hud-total"><small>TEMPO DE PROVA</small><b id="hud-race-time">0:00.000</b></div></div><div id="hud-status" class="hud-flag">GRID</div><button class="hud-icon" data-action="pause" aria-label="Pausar">${icon("pause")}</button></header>
 <div class="manager-control-banner"><b>${r.isDelegated() ? "CHEFE · IA AUTÔNOMA" : "MANUAL · CARRO 1"}</b><button data-action="manager-drive">${r.isDelegated() ? "DIRIGIR (OPCIONAL)" : "VOLTAR A GERENCIAR"}</button><select data-manager-focus aria-label="Carro acompanhado">${r.cars.map((c) => `<option value="${c.id}" ${(g.world.focusId ?? (r.localCar?.id || 0)) === c.id ? "selected" : ""}>C${c.id + 1} · ${html(c.name)}</option>`).join("")}</select></div>
 <aside class="hud-tower hud-clutter"><div class="tower-heading"><b id="hud-position">P${r.cars.length}</b><span>CLASSIFICAÇÃO<small>INTERVALOS DE PASSAGEM</small></span><i id="hud-grid-size">${r.cars.length} ${r.cars.length === 1 ? "CARRO" : "CARROS"}</i></div><ol id="leaderboard">${r.cars.map((c) => `<li class="race-entry ${r.isLocalCar(c) ? "player" : ""}" data-car="${c.id}"><b class="entry-pos"></b><span class="entry-number" style="--team:${pitTeams[c.teamId].color}">${c.number}</span><div class="entry-name"><strong>${html(c.id === 0 ? c.academyDriver?.name || driverCatalog[c.driverId].name : c.name)}</strong><small>${pitTeams[c.teamId].name}${c.teamId === r.cars[0].teamId ? " · SUA EQUIPE" : ""}</small></div><span class="entry-gap">—</span><i class="entry-change"></i></li>`).join("")}</ol><small class="tower-note">${r.difficulty.toUpperCase()} · ${r.weather === "rain" ? "CHUVA" : "SECO"} · ${r.realism === "realistic" ? "REALISTA" : "ARCADE"}</small></aside>
 <div id="countdown" class="hud-countdown"><div class="start-lights">${Array.from({ length: 5 }, () => "<i></i>").join("")}</div><b id="start-number">5</b><small>PREPARE-SE PARA A LARGADA</small></div>
 <aside class="hud-director" id="hud-director" hidden><b id="hud-director-flag"></b><span id="hud-director-instruction"></span><small id="hud-weather"></small></aside><div id="race-message" class="hud-alert" role="status" aria-live="polite"></div>
 <aside class="hud-map hud-clutter"><div><b>MAPA DO CIRCUITO</b><span>● VOCÊ</span></div><canvas id="minimap" width="420" height="270"></canvas></aside>
 <section class="hud-resources hud-clutter" id="resource-data"><div><small>COMBUSTÍVEL</small><b id="hud-fuel">—</b><span id="hud-range">—</span></div><div><small>PNEUS</small><b id="hud-tire">—</b><span id="hud-temp">—</span></div><div><small>DANOS</small><b id="hud-damage">0%</b><span id="hud-damage-state">—</span></div><div class="hud-pit"><small>BOXES / <span id="hud-bay">G1</span></small><b id="hud-pit-state">NA PISTA</b><span id="hud-pit-time">0 paradas</span></div></section>
 <aside class="hud-car"><small id="hud-view-label" class="hud-camera-label" hidden>PILOTO ACOMPANHADO · CÂMERA NO SAFETY CAR</small><div class="hud-shift" id="rpm">${Array.from({ length: 16 }, () => "<i></i>").join("")}</div><div class="hud-speed-line"><span id="hud-gear">N</span><strong id="hud-speed">0</strong><small>KM/H</small></div><div class="hud-engine"><span id="hud-rpm">1.500 RPM</span><b id="hud-shift">AUTO</b><span id="hud-drs" class="hud-drs-badge">DRS PRONTO</span></div><div class="pedal"><small>ACEL</small><i><em id="hud-throttle"></em></i></div><div class="pedal brake"><small>FREIO</small><i><em id="hud-brake"></em></i></div></aside>
 <div class="hud-strategy-slot">${r.manager ? managerPanel(g, true) : strategyPanel(s)}</div>
 <nav class="hud-toolbar" aria-label="Controles de corrida"><button data-action="pit-options">BOXES <kbd>P</kbd></button><button data-action="race-journal">REGRAS</button><button data-action="radio">RÁDIO <kbd>Q</kbd></button><button data-action="camera">CÂMERA <kbd>C</kbd></button><select data-pit-camera aria-label="CÂMERAS"><option value="">CÂMERAS</option><option value="overview">Circuito completo</option><option value="battle">Disputa próxima</option><option value="cockpit">Carro acompanhado</option><option value="broadcast">Transmissão</option><option value="pit-lane">Externa</option><option value="pit-garage">Garagem</option><option value="pit-follow">Entrada / saída</option><option value="pit-wheels">Pneus</option><option value="safety-car">Safety Car</option><option value="grandstands">Arquibancadas</option><option value="chase">Perseguição</option></select><button data-action="hud-mode" aria-label="Alternar modo do HUD">HUD <span id="hud-mode-label">${s.hudMode === "standard" ? "PADRÃO" : s.hudMode === "compact" ? "COMPACTO" : "IMERSIVO"}</span></button>${g.admin.active ? '<button data-action="admin-inspect">LAB</button>' : ""}</nav>
 <div id="engineer-radio" class="hud-radio"><b>ENGENHEIRO</b><span id="hud-radio-text"></span></div><small id="fps-counter"></small>
 <div class="touch-controls rc-touch"><button data-touch="left" aria-label="Virar à esquerda">${icon("left")}</button><button data-touch="right" aria-label="Virar à direita">${icon("chevron")}</button><button data-touch="brake">FREAR</button><button data-touch="throttle">ACELERAR</button></div>
 </section>`;
}
function alertFor(event) {
  switch (event.type) {
    case "start":
      return ["LARGADA LIBERADA", "green"];
    case "last-lap":
      return ["ÚLTIMA VOLTA", ""];
    case "personal-best":
      return ["RECORDE PESSOAL · " + clock(event.detail), "purple"];
    case "finish":
      return ["BANDEIRADA · CORRIDA CONCLUÍDA", ""];
    case "penalty":
      return ["PENALIDADE · +" + event.detail + " s", "yellow"];
    case "race-control":
      return [
        event.detail.reason,
        event.detail.phase === "red" ? "red" : "yellow",
      ];
    case "safety-car":
      return [event.detail, "yellow"];
    case "weather":
      return [event.detail, ""];
    case "penalty-served":
      return ["PENALIDADE CUMPRIDA · " + event.detail + " s", "green"];
    case "mechanical":
      return ["FALHA DE POTÊNCIA · REPARO SOLICITADO", "yellow"];
    case "flag":
      return [
        event.detail === "yellow"
          ? "NEUTRALIZAÇÃO · CONSULTE DIREÇÃO DE PROVA"
          : "BANDEIRA VERDE",
        event.detail,
      ];
    case "pit":
      return [
        {
          entry: "ENTRADA DOS BOXES",
          queue: "AGUARDANDO GARAGEM DA EQUIPE",
          service: "SERVIÇO EM ANDAMENTO",
          release: "SERVIÇO CONCLUÍDO · AGUARDE",
          exit: "SAÍDA DOS BOXES",
          track: "REENTRADA CONCLUÍDA",
        }[event.detail] || "BOXES",
        "",
      ];
    case "overtake":
      return [
        event.by === 0 ? "ULTRAPASSAGEM CONCLUÍDA" : "POSIÇÃO PERDIDA",
        event.by === 0 ? "green" : "yellow",
      ];
    default:
      return null;
  }
}
export function updateRaceHUD(ui, race, now) {
  if (ui.page !== "race" || now - ui.lastHUD < 100) return;
  ui.lastHUD = now;
  updateManager(ui, race, now);
  const root = document.getElementById("race-hud");
  if (!root) return;
  if (!ui.hudCache) {
    ui.hudCache = new Map(
      [...root.querySelectorAll("[id]")].map((el) => [el.id, el]),
    );
    ui.hudRows = new Map(
      [...root.querySelectorAll("[data-car]")].map((el) => [
        Number(el.dataset.car),
        {
          el,
          pos: el.querySelector(".entry-pos"),
          gap: el.querySelector(".entry-gap"),
          change: el.querySelector(".entry-change"),
        },
      ]),
    );
  }
  const el = (id) => ui.hudCache.get(id),
    set = (id, value) => {
      const n = el(id);
      if (n && n.textContent !== String(value)) n.textContent = value;
    };
  const c =
      race.cars.find((c) => c.id === (ui.game.world.focusId ?? race.localCarId ?? 0)) ||
      race.localCar ||
      race.cars[0],
    order = race.standings(),
    position = order.indexOf(c) + 1;
  set("hud-position", "P" + position);
  set(
    "hud-lap",
    race.mode === "practice"
      ? c.lap + 1 + " / ∞"
      : Math.min(race.laps, c.lap + 1) + " / " + race.laps,
  );
  set("hud-time", clock(c.lapTime));
  set("hud-best", clock(c.bestLap));
  set("hud-race-time", clock(race.time));
  const delta = race.timing.delta(c);
  set(
    "hud-delta",
    delta === null ? "—" : (delta >= 0 ? "+" : "") + delta.toFixed(3),
  );
  el("hud-delta").dataset.tone =
    delta === null ? "" : delta <= 0 ? "green" : "red";
  set("hud-speed", Math.round(c.speed * 3.6));
  set("hud-gear", gearFor(c) || "N");
  const rpm = rpmFor(c);
  set("hud-rpm", rpm.toLocaleString("pt-BR") + " RPM");
  set("hud-shift", shiftNeeded(c) ? "TROCAR ↑" : "AUTO");
  el("hud-shift").classList.toggle("shift-now", shiftNeeded(c));
  el("hud-throttle").style.transform = `scaleX(${c.throttle})`;
  el("hud-brake").style.transform = `scaleX(${c.brake})`;
  el("hud-view-label").hidden = !["safety-car", "grandstands"].includes(
    ui.game.world.cameraMode,
  );
  el("hud-view-label").textContent =
    ui.game.world.cameraMode === "grandstands"
      ? "PILOTO ACOMPANHADO · CÂMERA NAS ARQUIBANCADAS"
      : "PILOTO ACOMPANHADO · CÂMERA NO SAFETY CAR";
  const leds = el("rpm").children,
    lit = Math.round((rpm / 14000) * 16);
  for (let i = 0; i < leds.length; i++) leds[i].classList.toggle("on", i < lit);
  const drsActive = c.speed > 56 && c.throttle > 0.85 && Math.abs(c.steer || 0) < 0.08 && race.flag === "green";
  set("hud-drs", drsActive ? "DRS ATIVO" : race.flag === "yellow" ? "DRS BLOQ" : "DRS PRONTO");
  if (el("hud-drs")) el("hud-drs").dataset.active = drsActive ? "1" : "0";
  for (let i = 0; i < order.length; i++) {
    const car = order[i],
      row = ui.hudRows.get(car.id);
    row.el.style.order = i;
    row.pos.textContent = i + 1;
    const gap = race.timing.gap(order[0], car, race.time),
      laps = Math.floor((order[0].progress - car.progress) / race.trackLength);
    const text = ["practice", "qualifying", "time-attack"].includes(
      race.sessionType,
    )
      ? clock(car.bestLap)
      : car.retired
        ? "DNF"
        : i === 0
          ? car.finished
            ? "FIN"
            : "LÍDER"
          : car.finished
            ? "+" +
              (
                car.finishTime +
                car.penalty -
                order[0].finishTime -
                order[0].penalty
              ).toFixed(1)
            : laps > 0
              ? "+" + laps + (laps === 1 ? " VOLTA" : " VOLTAS")
              : gap === null
                ? "—"
                : "+" + gap.toFixed(1);
    if (row.gap.textContent !== text) row.gap.textContent = text;
    const last = ui.hudPositionMap.get(car.id);
    if (last && last !== i + 1) {
      row.change.textContent = last > i + 1 ? "▲" : "▼";
      row.change.dataset.tone = last > i + 1 ? "green" : "red";
      row.until = race.time + 4;
    }
    if (race.time > (row.until || 0)) row.change.textContent = "";
    ui.hudPositionMap.set(car.id, i + 1);
  }
  set(
    "hud-status",
    race.state === "paused"
      ? "PAUSA"
      : race.state === "countdown"
        ? "GRID"
        : race.flag === "yellow"
          ? "VSC · 83 KM/H"
          : c.finished
            ? "FINALIZADO"
            : "BANDEIRA VERDE",
  );
  el("hud-status").dataset.flag = race.flag;
  const countdown = el("countdown");
  countdown.hidden = race.state !== "countdown";
  if (!countdown.hidden) {
    set("start-number", Math.ceil(race.countdown));
    [...countdown.querySelectorAll(".start-lights i")].forEach((n, i) =>
      n.classList.toggle("on", 5 - race.countdown > i),
    );
  }
  const tire = compounds[c.tires.compound];
  set(
    "hud-fuel",
    race.realism === "arcade" ? "ASSISTIDO" : c.fuel.toFixed(1) + " L",
  );
  set("hud-range", (c.fuel / c.fuelPerLap).toFixed(1) + " voltas");
  set(
    "hud-tire",
    tire.label.toUpperCase() + " " + Math.round(c.tires.health * 100) + "%",
  );
  el("hud-tire").style.color = tire.color;
  set("hud-temp", Math.round(c.tires.temperature) + " °C");
  set("hud-damage", Math.round(c.damage * 100) + "%");
  set(
    "hud-damage-state",
    c.retired
      ? "ABANDONO"
      : c.mechanical > 0
        ? "MOTOR −" + Math.round(c.mechanical * 50) + "%"
        : c.wingDamage > 0
          ? "ASA " + Math.round(c.wingDamage * 100) + "%"
          : race.realism === "arcade"
            ? "REDUZIDOS"
            : "REALISTA",
  );
  set("hud-bay", "G" + (bayFor(c).id + 1));
  const p = c.pit;
  set(
    "hud-pit-state",
    p.state === "service"
      ? (p.total - p.remaining).toFixed(1) + " / " + p.total.toFixed(1) + " s"
      : p.mergeWaiting
        ? "CEDER PASSAGEM"
        : {
            entry: "ENTRADA",
            queue: "FILA DA EQUIPE",
            release: "AGUARDAR FAIXA",
            exit: "SAÍDA",
            track: p.requested ? "SOLICITADO" : "NA PISTA",
          }[p.state],
  );
  set(
    "hud-pit-time",
    p.stops +
      " paradas · +" +
      c.penalty +
      " s" +
      (p.state !== "track"
        ? " · " + (p.laneElapsed || 0).toFixed(1) + " s box"
        : ""),
  );
  const isLocalCarId = (id) => {
    const car = race.cars.find((candidate) => candidate.id === id);
    return car ? race.isLocalCar(car) : !race.network && id === 0;
  };
  let newHighest = 0;
  for (const event of race.events)
    if (
      event.id > ui.hudEventTime &&
      (event.type === "start" ||
        event.car === null ||
        isLocalCarId(event.car) ||
        isLocalCarId(event.by) ||
        isLocalCarId(event.against))
    ) {
      const a = alertFor(event);
      if (a) {
        const priority =
          {
            finish: 100,
            "race-control": 90,
            "safety-car": 85,
            weather: 35,
            "penalty-served": 55,
            penalty: 90,
            flag: 80,
            "last-lap": 70,
            start: 65,
            "personal-best": 55,
            pit: 40,
            overtake: 30,
          }[event.type] || 10;
        ui.hudAlertQueue.push({ a, priority });
        newHighest = Math.max(newHighest, priority);
      }
    }
  ui.hudEventTime = race.eventSerial;
  ui.hudAlertQueue.sort((a, b) => b.priority - a.priority);
  ui.hudAlertQueue.length = Math.min(ui.hudAlertQueue.length, 8);
  if (
    ui.hudAlertQueue.length &&
    (now >= ui.hudAlertUntil || newHighest > (ui.hudAlertPriority || 0))
  ) {
    const item = ui.hudAlertQueue.shift();
    ui.hudAlertPriority = item.priority;
    ui.hudAlertUntil = now + 3200;
    set("race-message", item.a[0]);
    el("race-message").dataset.tone = item.a[1];
  }
  el("race-message").classList.toggle("show", now < (ui.hudAlertUntil || 0));
  const e = ui.game.engineer,
    hasRadio = e.until > race.time && e.message;
  set("hud-radio-text", hasRadio ? e.message : "");
  el("engineer-radio").classList.toggle("show", !!hasRadio);
  set(
    "fps-counter",
    ui.game.save.settings.fps
      ? Math.round(ui.game.fps) +
          " FPS · " +
          ui.game.world.renderer.info.render.calls +
          " DRAW"
      : "",
  );
  if (race.control) {
    const control = race.control,
      signal = control.signal(c),
      w = control.weather;
    const flagNames = {
      green: "VERDE",
      grid: "GRID",
      yellow: "AMARELA",
      "double-yellow": "DUPLA AMARELA",
      red: "VERMELHA",
      blue: "AZUL",
      vsc: "VIRTUAL SAFETY CAR",
      sc: "SAFETY CAR",
      restart: "RELARGADA",
      "black-white": "ADVERTÊNCIA",
      black: "DESCLASSIFICADO",
      chequered: "QUADRICULADA",
    };
    el("hud-director").hidden =
      signal.flag === "grid" ||
      (signal.flag === "green" && w.program === "fixed");
    el("hud-director").dataset.flag = signal.flag;
    set(
      "hud-director-flag",
      (flagNames[signal.flag] || signal.flag) + " / SETOR " + signal.sector,
    );
    set("hud-director-instruction", signal.instruction);
    set(
      "hud-weather",
      `Pista ${w.condition || "seca"} · ${Math.round(w.wetness * 100)}% · chuva ${Math.round(w.rain * 100)}% · ${w.forecastText || ""}`,
    );
    set("hud-status", flagNames[signal.flag] || signal.flag);
  }
  ui.drawMap(race);
}
