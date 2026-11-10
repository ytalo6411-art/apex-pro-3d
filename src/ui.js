import { managerPanel, managerHistory } from "./ui/ManagerUI.js";
import { extendCompetitionUI } from "./ui/CompetitionUI.js";
import { trackPreview } from "./data/TrackGeometry.js";
import { renderRaceHUD, updateRaceHUD } from "./ui/RaceHUD.js";
import { cameraModes } from "./camera/CameraManager.js";
import { activeDriverForSave } from "./data/drivers.js";
import { trackById, trackCatalog } from "./data/tracks.js";
import { extendUI } from "./ui/Extras.js";
import { activeTrack, mapPoint } from "./track.js";
import { icon } from "./icons.js";
import { outlineSVG, length, samples } from "./track.js";
import {
  vehicles,
  attributes,
  performance,
  displayStat,
  upgradeCost,
} from "./garage.js";
import { goals } from "./progression.js";
import { buildRankings } from "./ranking.js";
import { rounds, standings } from "./championship.js";
import { liveries } from "./models.js";
import { difficulties } from "./ai.js";
export const fmt = (n) => Math.round(n).toLocaleString("pt-BR");
export function time(t) {
  if (t === null || t === undefined || !Number.isFinite(t)) return "—";
  let m = Math.floor(t / 60),
    s = (t % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}
const btn = (label, action, style = "secondary", extra = "") =>
  `<button class="btn ${style}" data-action="${action}" ${extra}>${label}</button>`;
export class UI {
  constructor(game) {
    this.game = game;
    this.root = document.querySelector("#ui");
    this.page = "home";
    this.modal = null;
    this.toastTimer = 0;
    this.lastHUD = 0;
    this.root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-nav],[data-action]");
      if (!b || b.disabled) return;
      if (b.dataset.nav) this.navigate(b.dataset.nav);
      else this.game.action(b.dataset.action, b.dataset);
    });
    this.root.addEventListener("change", (e) => {
      if (this.game.managerChange(e.target)) return;
      if (e.target.dataset.actionSelect) {
        this.game.action(e.target.dataset.actionSelect, {
          value: e.target.value,
        });
        return;
      }
      if (e.target.hasAttribute("data-team-order"))
        this.game.action("team-order", { order: e.target.value });
      if (e.target.dataset.aiSetting)
        this.game.setStrategy(e.target.dataset.aiSetting, e.target.value);
      if (
        e.target.hasAttribute("data-pit-camera") &&
        cameraModes.includes(e.target.value)
      ) {
        this.game.world.cameraMode = e.target.value;
        this.game.world.cameraReady = false;
      }
      if (e.target.dataset.setting)
        this.game.setting(
          e.target.dataset.setting,
          e.target.type === "checkbox" ? e.target.checked : e.target.value,
        );
    });
    this.root.addEventListener(
      "toggle",
      (e) => {
        if (e.target.matches?.(".race-strategy:not(.strategy-preset)")) {
          this.game.save.settings.strategyOpen = e.target.open;
          this.game.store();
        }
      },
      true,
    );
    this.root.addEventListener("input", (e) => {
      if (e.target.dataset.setting === "volume")
        this.game.setting("volume", e.target.value);
    });
  }
  pilotBadge() {
    const driver = activeDriverForSave(this.game.save);
    const name = String(driver?.name || "").replace(/[^\p{L}\p{N} _-]/gu, "").trim();
    if (!name) return `<div class="avatar" title="Apex Motorsport">AD</div>`;
    const initials = name.split(/[\s_]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    return `<div class="avatar pilot-avatar" title="${name.replaceAll('"', "&quot;")} — ${this.game.save.team?.name || "Apex Motorsport"}">${initials || "P"}</div><span class="pilot-name">${name.replaceAll("<", "&lt;")}</span>`;
  }
  header() {
    const s = this.game.save;
    return `<header class="header"><button class="brand" data-nav="home" aria-label="Apex Dynasty — Início"><img src="/assets/logo-primary.png" alt="Logo oficial Apex Dynasty"><span><b>APEX DYNASTY<span class="brand-dot">.</span></b><small>F1 MANAGER <i>/</i> RETRO RACING</small></span></button><nav aria-label="Menu principal">${[
      ["home", "Início"],
      ["management", "Estratégia"],
      ["championship", "Campeonato"],
      ["ranking", "Ranking"],
      ["garage", "Garagem"],
      ["upgrades", "Melhorias"],
      ["stats", "Estatísticas"],
    ]
      .map(
        ([p, n]) =>
          `<button class="nav-item ${this.page === p ? "active" : ""}" data-nav="${p}">${n}</button>`,
      )
      .join(
        "",
      )}</nav><div class="header-tools"><div class="credit-balance">${icon("credit")}<b>${fmt(s.credits)}</b><small>CR</small></div><span class="header-divider"></span><button class="icon-btn settings-btn" data-action="settings" aria-label="Configurações">${icon("settings")}</button>${this.pilotBadge()}</div></header>`;
  }
  footer() {
    return `<footer class="footer"><span><span class="live-dot"></span> SEU PRÓXIMO LEGADO COMEÇA AQUI.</span><span>BUILD THE TEAM. <b>MASTER THE RACE.</b><i>APEX DYNASTY © 2026</i></span></footer>`;
  }
  title(eyebrow, title, sub = "") {
    return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div class="session-tag"><span class="live-dot"></span> PRONTO PARA CORRER</div></div>`;
  }
  navigate(page) {
    if (
      this.game.race &&
      ["countdown", "racing", "paused", "finishing"].includes(
        this.game.race.state,
      )
    )
      return;
    this.modal = null;
    this.game.launchContext = null;
    this.page = page;
    this.game.race = null;
    this.game.world.setMode("showcase");
    this.game.world.customization =
      this.game.save.customizations[this.game.save.selectedCar];
    this.game.world.setPreview(this.game.save.selectedCar);
    this.game.world.setPaint?.(this.game.save.selectedPaint);
    this.render();
    if (page === "tracks") this.game.world.setMode("track-preview");
  }
  render() {
    const world = this.game.world.container;
    document.querySelector("#app").appendChild(world);
    world.className = "";
    this.root.innerHTML =
      this.page === "race"
        ? this.raceHUD()
        : this.header() +
          `<main class="main">${this[this.page]()}</main>` +
          this.footer();
    const slot = this.root.querySelector(".scene-slot");
    if (slot) {
      slot.appendChild(world);
      world.style.display = "block";
    } else if (this.page === "race") {
      world.style.display = "block";
      world.className = "race-world";
    } else {
      world.style.display = "none";
    }
    this.game.world.resize();
    if (this.modal) this.showModal(this.modal);
  }
  management() {
    return (
      this.title(
        "CENTRAL / CHEFE DE EQUIPE",
        "Planeje. Comande. Conquiste.",
        "Pilotos autônomos. Estratégias independentes. Decisões com consequências reais.",
      ) +
      managerPanel(this.game) +
      managerHistory(this.game)
    );
  }
  home() {
    const s = this.game.save,
      st = performance(s),
      next = goals.find((g) => !s.objectives.includes(g.id));
    return `${this.title("CENTRAL DA EQUIPE", "O próximo capítulo é seu.")}
 <section class="hero"><div class="scene-slot"></div><div class="hero-shade"></div><div class="hero-noise"></div><div class="hero-content"><div class="hero-kicker"><span></span> ESPÍRITO RETRÔ. AMBIÇÃO SEM LIMITES.</div><h2>NASCIDOS<br>PARA <em>VENCER.</em></h2><p>Lidere dois pilotos. Conquiste o campeonato.<br>Construa sua equipe e escreva sua história.</p><div class="hero-actions">${btn(`PREPARAR EQUIPE ${icon("arrow")}`, "setup", "primary")}<button class="hero-garage" data-nav="garage" aria-label="Abrir garagem">${icon("car")}</button></div><div class="hero-meta">${icon("flag")} GERENCIAMENTO <span>·</span> IA AUTÔNOMA <span>·</span> ~4 MIN</div></div><div class="scene-badge"><span class="live-dot"></span> MOTORSPORT EM SUA ESSÊNCIA</div><div class="car-caption"><span class="car-number">${String(liveries[s.selectedCar].number).padStart(2, "0")}</span><div><small>SUA MÁQUINA. SUA HISTÓRIA.</small><b>${vehicles[s.selectedCar].title.toUpperCase()}</b><span>FÓRMULA ${vehicles[s.selectedCar].name} <i>///</i> ${s.selectedPaint.toUpperCase()}</span></div><div class="caption-bars"><i></i><i></i><i></i></div></div><div class="hero-bottom"><span>01 <i>/</i> APEX EXPERIENCE</span><span>PURE RACING. NO LIMITS. <i>↗</i></span></div></section>
 <div class="section-label"><span>SEU PADDOCK</span><i></i><span class="muted">DA PRIMEIRA LARGADA À SUA DINASTIA</span></div>
 <section class="dashboard-grid"><article class="panel track-card"><div class="card-label">${icon("pin")} O PALCO DA DISPUTA <span class="tag">CIRCUITO ${String(trackCatalog.findIndex((t) => t.id === activeTrack.id) + 1).padStart(2, "0")}</span></div><div class="track-card-body"><div><h3>${activeTrack.name}</h3><p>Velocidade encontra precisão.</p><div class="track-facts"><div><b>${(length / 1000).toFixed(2).replace(".", ",")}<small> km</small></b><span>EXTENSÃO</span></div><div><b>${trackPreview(activeTrack).corners}</b><span>CURVAS</span></div><div><b>${icon("sun")}</b><span>SECO</span></div></div></div><div class="track-map">${outlineSVG()}</div></div><button class="card-link" data-action="setup">Explore a próxima corrida ${icon("arrow")}</button></article>
 <article class="panel season-card"><div class="card-label">${icon("trophy")} CAMPEONATO <span class="tag">TEMPORADA ${String(s.championship.season).padStart(2, "0")}</span></div><div class="season-content"><span class="big-round">${String(Math.min(3, s.championship.results.length + 1)).padStart(2, "0")}<small>/03</small></span><div><h3>${s.championship.results.length === 3 ? "Uma história escrita." : "Um título. Seu nome."}</h3><p>Três etapas para construir seu legado.</p><div class="stage-dots">${[0, 1, 2].map((i) => `<i class="${i <= s.championship.results.length ? "on" : ""}"></i>`).join("")}</div></div></div><button class="card-link" data-nav="championship">${s.championship.results.length ? "Continuar sua temporada" : "Iniciar uma dinastia"} ${icon("arrow")}</button></article>
 <article class="panel machine-card"><div class="card-label">${icon("bolt")} EVOLUÇÃO CONTÍNUA <span class="tiny-red">${s.stats.upgrades} UPGRADES</span></div><h3>A vitória começa na garagem.</h3><div class="mini-stat"><span>Velocidade máxima</span><b>${Math.round(st.maxSpeed * 3.6)} <small>km/h</small></b></div><div class="performance-bar"><span style="width:${Math.min(100, (st.maxSpeed / 90) * 100)}%"></span></div><button class="card-link" data-nav="upgrades">Encontre sua vantagem ${icon("arrow")}</button></article></section>
 <section class="bottom-strip"><div class="next-goal">${icon(next?.icon || "crown")}<div><small>PRÓXIMO OBJETIVO</small><span>${next?.name || "Todos os objetivos concluídos"} <i>${next ? "+" + next.reward + " CR" : "O legado é seu."}</i></span></div><button data-nav="stats" aria-label="Ver objetivos">${icon("arrow")}</button></div><div class="controls-teaser"><span>ASSUMA O CONTROLE</span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><small>PILOTAR</small><kbd>ESC</kbd><small>PAUSAR</small><button class="icon-btn" data-action="help" aria-label="Como jogar">${icon("help")}</button></div></section>`;
  }
  garage() {
    const s = this.game.save,
      v = vehicles[s.selectedCar],
      stats = performance(s);
    return `${this.title("GARAGEM / SUA EQUIPE", "Projetado para ir além.", "Escolha sua máquina. Encontre seu estilo. Deixe sua marca.")}<section class="garage-hero panel"><div class="scene-slot"></div><div class="hero-shade"></div><div class="garage-info"><span class="tag red-tag">CARRO SELECIONADO</span><h2>${v.name}</h2><h3>${v.title}</h3><p>${v.role}</p><div class="paint-label">PINTURA</div><div class="paints">${[
      ["signature", "Original", "#bbc3cc"],
      ["carbon", "Carbon", "#272b31"],
      ["heritage", "Heritage", "#eeecdf"],
    ]
      .map(
        ([id, n, c]) =>
          `<button class="paint ${s.selectedPaint === id ? "selected" : ""}" data-action="paint" data-id="${id}" title="${n}${s.unlockedPaints.includes(id) ? "" : id === "carbon" ? " — complete uma corrida" : " — conquiste um pódio"}" style="--paint:${c}" ${s.unlockedPaints.includes(id) ? "" : "disabled"}>${s.unlockedPaints.includes(id) ? (s.selectedPaint === id ? icon("check") : "") : icon("lock")}</button>`,
      )
      .join(
        "",
      )}<span>${s.selectedPaint === "signature" ? "Original" : s.selectedPaint === "carbon" ? "Carbon" : "Heritage"}</span></div></div><div class="garage-stats">${attributes.map((a) => `<div><span>${icon(a.icon)} ${a.name}</span><b>${displayStat(a.key, stats[a.key])}<small> ${a.unit}</small></b></div>`).join("")}</div></section><div class="section-label"><span>SUA COLEÇÃO</span><i></i><span class="muted">${s.unlockedCars.length} DE 6 DESBLOQUEADOS</span></div><div class="vehicle-grid">${vehicles.map((v, i) => `<button class="vehicle-card ${s.selectedCar === i ? "selected" : ""} ${s.unlockedCars.includes(i) ? "" : "locked"}" data-action="car" data-id="${i}" ${s.unlockedCars.includes(i) ? "" : "disabled"}><div class="vehicle-top"><span>${v.name}</span><span>${s.selectedCar === i ? icon("check") : s.unlockedCars.includes(i) ? icon("car") : icon("lock")}</span></div><img src="/assets/cars/thumbnails/car-${i}.png" alt="${v.title}" onerror="this.style.visibility='hidden'"><h3>${v.title}</h3><p>${s.unlockedCars.includes(i) ? v.role : v.condition}</p><span class="livery-strip" style="background:${liveries[i].color}"></span></button>`).join("")}</div><div class="page-cta"><span>${icon("bolt")} Aplique melhorias à equipe inteira. Todos os carros evoluem com você.</span><button class="btn secondary" data-nav="upgrades">Ver melhorias ${icon("arrow")}</button></div>`;
  }
  upgrades() {
    const s = this.game.save,
      stats = performance(s);
    return `${this.title("ENGENHARIA / DESEMPENHO", "Cada detalhe faz a diferença.", "Melhorias permanentes para todos os carros da sua equipe.")}<section class="upgrade-banner panel"><div>${icon("bolt")}<div><small>PROGRAMA DE DESENVOLVIMENTO</small><h3>Sua próxima vantagem competitiva.</h3><p>Cada nível altera o comportamento real do carro na pista.</p></div></div><div class="upgrade-wallet"><small>SALDO DISPONÍVEL</small><b>${icon("credit")} ${fmt(s.credits)} <span>CR</span></b></div></section><div class="upgrade-grid">${attributes
      .map((a) => {
        let level = s.upgrades[a.key],
          cost = upgradeCost(level);
        return `<article class="panel upgrade-card"><div class="upgrade-top"><span class="upgrade-icon">${icon(a.icon)}</span><span class="tag">NÍVEL ${level} / 5</span></div><h2>${a.name}</h2><p>${a.description}</p><div class="upgrade-value"><b>${displayStat(a.key, stats[a.key])}</b><span>${a.unit}</span>${level < 5 ? `<small>${icon("arrow")} ${displayStat(a.key, stats[a.key] + a.gain)} ${a.unit}</small>` : "<small>DESEMPENHO MÁXIMO</small>"}</div><div class="level-bars">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < level ? "on" : ""}"></i>`).join("")}</div><button class="btn ${level < 5 && s.credits >= cost ? "primary" : "secondary"}" data-action="upgrade" data-key="${a.key}" ${level === 5 ? "disabled" : ""}>${level === 5 ? `${icon("check")} NÍVEL MÁXIMO` : `MELHORAR <span>${fmt(cost)} CR ${icon("arrow")}</span>`}</button></article>`;
      })
      .join(
        "",
      )}</div><div class="info-note">${icon("help")} Sem sorte. Sem espera. Só engenharia e o que você conquista na pista.</div>`;
  }
  championship() {
    const c = this.game.save.championship,
      complete = c.results.length === 3,
      table = standings(c);
    return `${this.title("CAMPEONATO / TEMPORADA " + String(c.season).padStart(2, "0"), complete ? "A temporada tem um nome." : "Três etapas. Uma dinastia.", "Três circuitos, desafios crescentes. Pontos e resultados salvos a cada bandeirada.")}<section class="champ-banner panel"><div class="champ-trophy">${icon(complete ? "crown" : "trophy")}</div><div><div class="eyebrow">${complete ? "CAMPEÃO DA TEMPORADA" : "APEX WORLD SERIES"}</div><h2>${complete ? (table[0].id === 0 ? "Você. O topo é seu." : table[0].name + " · " + liveries[table[0].id].team) : "O legado não se herda. Se conquista."}</h2><p>${complete ? table[0].points + " pontos · Uma temporada para a história." : "6 pilotos · 3 circuitos · Pontuação 25 / 18 / 15 / 12 / 10 / 8"}</p></div>${btn(complete ? `NOVA TEMPORADA ${icon("reset")}` : `${c.results.length ? "PRÓXIMA ETAPA" : "ENTRAR NO CAMPEONATO"} ${icon("arrow")}`, complete ? "new-season" : "champ-setup", "primary")}</section><div class="champ-layout"><section><div class="section-label"><span>CALENDÁRIO</span><i></i><span>${c.results.length} / 3 CONCLUÍDAS</span></div><div class="rounds">${rounds.map((r, i) => `<article class="panel round-card ${i === c.results.length ? "current" : ""}"><span class="round-number">0${i + 1}</span><div><small>${r.type} <i>·</i> ${r.laps} VOLTAS</small><h3>${r.name}</h3><p>${i < c.results.length ? "Resultado: P" + c.results[i].find((x) => x.id === 0).position + " · " + time(c.results[i].find((x) => x.id === 0).time) : trackById(r.track).name + " · Clima configurável"}</p></div><span class="round-state">${i < c.results.length ? icon("check") : i === c.results.length ? '<span class="live-dot"></span> PRÓXIMA' : icon("lock")}</span></article>`).join("")}</div></section><section><div class="section-label"><span>CLASSIFICAÇÃO GERAL</span><i></i></div><div class="panel table-panel"><table><thead><tr><th>POS</th><th>PILOTO / EQUIPE</th><th>VIT.</th><th>PTS</th></tr></thead><tbody>${table.map((d, i) => `<tr class="${d.id === 0 ? "player-row" : ""}"><td>${String(i + 1).padStart(2, "0")}</td><td><span class="driver-stripe" style="background:${liveries[d.id].color}"></span><b>${d.name}</b><small>${liveries[d.id].team}</small></td><td>${d.wins}</td><td><strong>${d.points}</strong></td></tr>`).join("")}</tbody></table></div></section></div>`;
  }
  stats() {
    const s = this.game.save;
    return `${this.title("ESTATÍSTICAS / SEU LEGADO", "Números que contam uma história.", "Cada volta é um passo a mais. Cada conquista abre um novo caminho.")}<div class="stats-grid">${[
      ["flag", "CORRIDAS", s.stats.races],
      ["trophy", "VITÓRIAS", s.stats.wins],
      ["podium", "PÓDIOS", s.stats.podiums],
      ["timer", "MELHOR VOLTA", time(s.stats.bestLap)],
    ]
      .map(
        ([ic, n, v]) =>
          `<article class="panel stat-tile">${icon(ic)}<span>${n}</span><b>${v}</b></article>`,
      )
      .join(
        "",
      )}</div><div class="section-label"><span>OBJETIVOS DE CARREIRA</span><i></i><span>${s.objectives.length} / 6 CONQUISTADOS</span></div><div class="goals-grid">${goals.map((g) => `<article class="panel goal-card ${s.objectives.includes(g.id) ? "complete" : ""}"><div class="goal-icon">${icon(s.objectives.includes(g.id) ? "check" : g.icon)}</div><div><h3>${g.name}</h3><p>${g.description}</p><span>${s.objectives.includes(g.id) ? "CONCLUÍDO" : "RECOMPENSA"} <b>+${g.reward} CR</b></span></div></article>`).join("")}</div><div class="career-strip panel"><div><small>VOLTAS COMPLETADAS</small><b>${s.stats.laps}</b></div><div><small>DISTÂNCIA PERCORRIDA</small><b>${(s.stats.distance / 1000).toFixed(1)} <span>km</span></b></div><div><small>TEMPORADAS CONCLUÍDAS</small><b>${s.stats.seasons}</b></div><div><small>CARROS DESBLOQUEADOS</small><b>${s.unlockedCars.length}<span> / ${vehicles.length}</span></b></div></div>`;
  }
  ranking() {
    const tab = this.rankingTab || "laps";
    const { byBestLap, byWins, byEarnings } = buildRankings(this.game.save);
    const tabs = [
      ["laps", "VOLTAS MAIS RÁPIDAS", "timer"],
      ["wins", "MAIS VITÓRIAS", "trophy"],
      ["money", "MAIS DINHEIRO", "credit"],
    ];
    const rows =
      tab === "wins"
        ? byWins
        : tab === "money"
          ? byEarnings
          : byBestLap;
    const valueOf = (r) =>
      tab === "wins"
        ? `${r.wins} <small>vitórias</small>`
        : tab === "money"
          ? `${fmt(r.earnings)} <small>CR</small>`
          : time(r.bestLap);
    const shown = rows.slice(0, 10);
    const playerRow = rows.find((r) => r.isPlayer);
    const playerIndex = playerRow ? rows.indexOf(playerRow) : -1;
    const medal = (i) => (i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "");
    const rowHtml = (r, i) => `<tr class="${r.isPlayer ? "player-row" : ""}"><td class="rank-pos ${medal(i)}">${String(i + 1).padStart(2, "0")}</td><td><span class="driver-stripe" style="background:${r.color || "#e63956"}"></span><b>${r.name}</b><small>#${String(r.number ?? 0).padStart(2, "0")}${r.isPlayer ? " · VOCÊ" : ""}</small></td><td class="rank-value">${valueOf(r)}</td><td class="rank-races">${r.races} corridas</td></tr>`;
    return `${this.title("RANKING / OS MELHORES DO APEX", "Quem manda no grid.", "Voltas mais rápidas, mais vitórias e mais dinheiro — atualizado a cada corrida.")}
 <div class="ranking-tabs" role="tablist">${tabs.map(([key, label, ic]) => `<button role="tab" aria-selected="${tab === key}" class="ranking-tab ${tab === key ? "active" : ""}" data-action="ranking-tab" data-tab="${key}">${icon(ic)} ${label}</button>`).join("")}</div>
 <section class="panel table-panel ranking-panel"><table><thead><tr><th>POS</th><th>PILOTO</th><th>${tab === "laps" ? "MELHOR VOLTA" : tab === "wins" ? "VITÓRIAS" : "DINHEIRO GANHO"}</th><th>CORRIDAS</th></tr></thead><tbody>${shown.map(rowHtml).join("")}</tbody></table>${playerIndex >= 10 && playerRow ? `<div class="ranking-you">Sua posição: <b>${playerIndex + 1}º</b> · ${valueOf(playerRow)}</div>` : ""}</section>
 <p class="ranking-note">${icon("help")} Os pilotos de IA acumulam resultados reais nas suas corridas. Vença, vire voltas rápidas e encha o cofre para subir no ranking.</p>`;
  }
  raceHUD() {
    return renderRaceHUD(this);
  }
  updateHUD(race, now) {
    updateRaceHUD(this, race, now);
  }
  drawMap(race) {
    const canvas = document.getElementById("minimap");
    if (!canvas) return;
    const c = canvas.getContext("2d");
    if (!this.mapLayer || this.mapTrack !== activeTrack.id) {
      this.mapTrack = activeTrack.id;
      this.mapLayer = document.createElement("canvas");
      this.mapLayer.width = 420;
      this.mapLayer.height = 270;
      const m = this.mapLayer.getContext("2d");
      m.beginPath();
      samples
        .filter((_, i) => i % 4 === 0)
        .forEach((p, i) => {
          const [x, y] = mapPoint(p, 380, 220);
          i ? m.lineTo(x, y) : m.moveTo(x, y);
        });
      m.closePath();
      m.lineWidth = 10;
      m.strokeStyle = "#c2cbd155";
      m.stroke();
      m.lineWidth = 2;
      m.strokeStyle = "#d5dce4";
      m.stroke();
    }
    c.clearRect(0, 0, 420, 270);
    c.drawImage(this.mapLayer, 0, 0);
    for (let i = race.cars.length - 1; i >= 0; i--) {
      const p = race.cars[i],
        [x, y] = mapPoint(p, 380, 220);
      c.beginPath();
      c.arc(x, y, p.id === 0 ? 8 : 5, 0, Math.PI * 2);
      c.fillStyle = p.id === 0 ? "#ff284e" : liveries[p.id].color;
      c.fill();
      if (p.id === 0) {
        c.strokeStyle = "#fff";
        c.lineWidth = 2;
        c.stroke();
      }
    }
    const sc = race.control?.sc;
    if (sc && sc.state !== "parked") {
      const [x, y] = mapPoint(sc.car, 380, 220);
      c.fillStyle = "#ffb53c";
      c.fillRect(x - 5, y - 5, 10, 10);
      c.font = "bold 12px sans-serif";
      c.fillText("SC", x + 8, y + 4);
    }
  }

  showModal(type) {
    this.modal = type;
    document.getElementById("modal")?.remove();
    let html = "",
      s = this.game.save;
    if (type === "setup" || type === "champ-setup") {
      const champ = type === "champ-setup",
        round = rounds[s.championship.results.length];
      html = `<div class="modal-eyebrow">${icon("flag")} ${champ ? "CAMPEONATO · ETAPA " + (s.championship.results.length + 1) : "CORRIDA RÁPIDA"}</div><h2>Sua equipe espera suas decisões.</h2><p>Prepare os planos. Os pilotos cuidam do volante; você comanda a equipe.</p><div class="setup-track"><div>${outlineSVG()}</div><div><span class="tag">${champ ? round?.type : "CIRCUITO 01"}</span><h3>${champ ? round?.name : activeTrack.name}</h3><p>${(length / 1000).toFixed(2)} km <i>·</i> ${champ ? 6 : ["practice", "time-trial"].includes(s.settings.mode) ? 1 : s.settings.bots + 1} carros <i>·</i> ${champ ? round?.laps : s.settings.mode === "endurance" ? Math.max(6, s.settings.laps) : s.settings.laps} voltas</p><span>${icon("sun")} ${s.settings.weather === "rain" ? "CHUVA / ASFALTO MOLHADO" : "PISTA SECA / CÉU ABERTO"}</span></div></div><div class="field-label">ESCOLHA SEU DESAFIO</div><div class="difficulty-options">${Object.entries(
        difficulties,
      )
        .map(
          ([key, v]) =>
            `<button data-action="difficulty" data-key="${key}" class="${s.settings.difficulty === key ? "selected" : ""}"><span>${key === "easy" ? "I" : key === "normal" ? "II" : "III"}</span><b>${v.label}</b><small>${key === "easy" ? "Encontre seu ritmo" : key === "normal" ? "Dispute cada curva" : "Sem margem para erro"}</small></button>`,
        )
        .join(
          "",
        )}</div><div class="setup-controls"><span>IA autônoma por padrão</span><span>WASD somente no modo manual</span><span><kbd>R</kbd> recuperar</span><span><kbd>ESC</kbd> pausar</span></div>${btn(`INICIAR CORRIDA ${icon("arrow")}`, champ ? "start-champ" : "start", "primary full-width")}<small class="modal-footnote">${icon("check")} Progresso salvo automaticamente após a corrida.</small>`;
    } else if (type === "pause") {
      html = `<div class="modal-eyebrow">${icon("pause")} BOX, BOX.</div><h2>Uma pausa. Não o fim.</h2><p>Seu lugar no grid está esperando.</p><div class="pause-actions">${btn(`VOLTAR À PISTA ${icon("play")}`, "resume", "primary full-width")}${btn(`REINICIAR CORRIDA ${icon("reset")}`, "restart", "secondary full-width")}${btn("SAIR PARA A CENTRAL", "exit-race", "text-btn full-width")}</div><div class="info-note">Reiniciar ou sair não concede créditos. A etapa atual não será registrada.</div>`;
    } else if (type === "settings") {
      html = `<div class="modal-eyebrow">${icon("settings")} CONFIGURAÇÕES</div><h2>No seu ritmo.</h2><p>Ajustes salvos neste navegador.</p><div class="setting-row"><div><b>Áudio do motor e efeitos</b><small>Som sintetizado localmente. Sem trilha remota.</small></div><label class="switch"><input type="checkbox" data-setting="audio" ${s.settings.audio ? "checked" : ""}><span></span></label></div><div class="setting-row"><div><b>Volume</b><small>O som começa ao entrar na corrida.</small></div><input type="range" min="0" max="1" step=".05" value="${s.settings.volume}" data-setting="volume" aria-label="Volume"></div><div class="setting-row"><div><b>Qualidade gráfica</b><small>Aplicado ao vivo. Física e regras permanecem iguais.</small></div><select data-setting="quality" aria-label="Qualidade gráfica">${[
        ["low", "Low · Leve"],
        ["medium", "Medium · Média"],
        ["high", "High · Alta"],
        ["custom", "Custom · Personalizada"],
      ]
        .map(
          ([v, n]) =>
            `<option value="${v}" ${s.settings.quality === v ? "selected" : ""}>${n}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="setting-row"><div><b>Dificuldade padrão</b><small>Velocidade, precisão e consistência dos rivais.</small></div><select data-setting="difficulty" aria-label="Dificuldade">${Object.entries(
        difficulties,
      )
        .map(
          ([k, v]) =>
            `<option value="${k}" ${s.settings.difficulty === k ? "selected" : ""}>${v.label}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="setting-actions">${btn(`${icon("help")} CONTROLES`, "help")}</div>`;
    } else if (type === "help") {
      html = `<div class="modal-eyebrow">${icon("help")} GUIA DO PILOTO</div><h2>Sinta o asfalto.</h2><p>Física arcade. Resposta rápida. O resto é com você.</p><div class="help-grid">${[
        ["W / ↑", "Acelerar"],
        ["S / ↓", "Frear"],
        ["A D / ← →", "Virar"],
        ["ESPAÇO", "Freio auxiliar"],
        ["R", "Recuperar o carro"],
        ["ESC", "Pausar / continuar"],
      ]
        .map(([k, n]) => `<div><kbd>${k}</kbd><span>${n}</span></div>`)
        .join(
          "",
        )}</div><div class="tip-box"><b>A volta perfeita começa antes da curva.</b><p>Freie na entrada, vire com toques curtos e acelere na saída. A grama reduz aderência e velocidade. Passe pelo traçado completo: atalhos não contam voltas.</p></div>${btn(`ENTENDIDO ${icon("check")}`, "close", "primary full-width")}`;
    } else if (type === "new-season") {
      html = `<div class="modal-eyebrow">${icon("trophy")} UM NOVO CAPÍTULO</div><h2>Começar de novo. Ir além.</h2><p>A classificação atual será substituída por uma nova temporada. Créditos, carros, melhorias e estatísticas permanecem.</p>${btn("INICIAR NOVA TEMPORADA", "confirm-season", "primary full-width")}`;
    } else if (type === "results") {
      const reward = this.game.lastReward,
        race = this.game.race,
        p = race.cars[0],
        champ = race.championship;
      html = `<div class="result-heading"><div><div class="modal-eyebrow">${icon("flag")} BANDEIRADA FINAL</div><h2>${!p.finished ? "Fim de prova." : race.mode === "time-trial" ? "Contra o relógio." : reward.position === 1 ? "O topo é seu." : reward.position <= 3 ? "Um lugar no pódio." : "Cada corrida, mais longe."}</h2><p>${activeTrack.name} <i>·</i> ${race.laps} voltas <i>·</i> ${difficulties[race.difficulty].label}</p></div><div class="result-place">P<b>${reward.position}</b></div></div><div class="result-summary"><div><small>CRÉDITOS DA CORRIDA</small><b class="positive">+ ${fmt(reward.credits)} <span>CR</span></b></div><div><small>MELHOR VOLTA</small><b>${time(p.bestLap)}</b></div><div><small>TEMPO TOTAL</small><b>${p.finished ? time(p.finishTime + p.penalty) : "—"}</b></div></div><div class="result-table"><table><thead><tr><th>POS</th><th>PILOTO / EQUIPE</th><th>TEMPO</th><th>${champ ? "PONTOS" : "MELHOR VOLTA"}</th></tr></thead><tbody>${reward.results.map((r) => `<tr class="${r.id === 0 ? "player-row" : ""}"><td>${String(r.position).padStart(2, "0")}</td><td><span class="driver-stripe" style="background:${liveries[r.id].color}"></span><b>${r.name}</b><small>${liveries[r.id].team}</small></td><td>${r.finished ? time(r.time) : "Não terminou"}</td><td>${champ ? "+" + r.points : time(r.bestLap)}</td></tr>`).join("")}</tbody></table></div>${reward.messages.length ? `<div class="reward-notices">${reward.messages.map((m) => `<span>${icon("check")} ${m}</span>`).join("")}</div>` : ""}<div class="result-actions">${btn("VOLTAR À CENTRAL", "results-home")}${btn(champ ? `VER CAMPEONATO ${icon("trophy")}` : `CORRER NOVAMENTE ${icon("reset")}`, champ ? "results-champ" : "restart", "primary")}</div><small class="modal-footnote">${icon("check")} Resultado e recompensas salvos.</small>`;
    }
    if (type === "results")
      html +=
        '<button class="btn secondary full-width" data-action="manager-review">RELATÓRIO · PLANO × EXECUÇÃO</button>';
    const node = document.createElement("div");
    node.id = "modal";
    node.className = "modal-backdrop";
    node.innerHTML = `<section class="modal ${type === "results" ? "results-modal" : ""}" role="dialog" aria-modal="true" aria-label="${type === "results" ? "Resultados" : type === "pause" ? "Pausa" : "Apex Dynasty"}">${!["pause", "results"].includes(type) ? `<button class="icon-btn modal-close" data-action="close" aria-label="Fechar">${icon("close")}</button>` : ""}${html}</section>`;
    this.root.appendChild(node);
    node.querySelector("button")?.focus({ preventScroll: true });
  }
  closeModal() {
    document.getElementById("modal")?.remove();
    this.modal = null;
  }
  toast(message) {
    const el = document.getElementById("toast");
    el.innerHTML = icon("check") + `<span>${message}</span>`;
    el.classList.add("visible");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("visible"), 3800);
  }
}

extendUI(UI);
extendCompetitionUI(UI);
