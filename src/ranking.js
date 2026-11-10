import { driverCatalog } from "./data/drivers.js";

// Ranking local (sem online): voltas mais rápidas, mais vitórias e mais dinheiro.
// Cada piloto do catálogo tem estatísticas acumuladas em save.driverStats[id]:
//   { races, wins, bestLap, earnings }
// Pilotos de IA começam com um histórico-base determinístico (para o ranking
// já nascer vivo); o piloto selecionado pelo jogador começa do zero e sobe
// com os resultados reais das corridas.

export const PRIZE_BY_POSITION = [1200, 900, 700, 550, 450, 350];
export const DNF_PRIZE = 100;

// Histórico-base determinístico: pilotos melhores (overall maior) largam com
// mais vitórias, voltas mais rápidas e mais dinheiro acumulado.
function seedFor(driver) {
  // O Mega Baxter (id 30) tem overall "∞" (string) — trata como 99.
  const raw = Number(driver?.overall ?? driver?.attributes?.speed ?? 60);
  const overall = Number.isFinite(raw) ? raw : 99;
  const skill = Math.max(0, Math.min(99, overall));
  // Pseudo-aleatório estável por id (sem Math.random: o ranking não muda a cada load).
  const jitter = (n) => (((driver.id + 1) * (n + 7)) % 13) / 13;
  const races = 5 + Math.round(skill * 0.15) + Math.round(jitter(1) * 4);
  const wins = Math.max(
    0,
    Math.round(races * (skill / 100) * (0.2 + jitter(2) * 0.15)),
  );
  // Volta-base: pilotos melhores viram mais rápido (faixa ~52s–78s).
  const bestLap = 78 - (skill / 100) * 26 + jitter(3) * 2;
  const earnings =
    wins * PRIZE_BY_POSITION[0] +
    Math.round(races * 250 * (0.6 + jitter(4) * 0.4));
  return {
    races,
    wins,
    bestLap: Math.round(bestLap * 1000) / 1000,
    earnings,
  };
}

export function emptyDriverStats() {
  return { races: 0, wins: 0, bestLap: null, earnings: 0 };
}

// Preenche estatísticas ausentes com o histórico-base. O piloto selecionado
// pelo jogador começa do zero (salvo se já tiver resultados reais).
export function ensureRankingStats(save) {
  if (!save || typeof save !== "object") return save;
  save.driverStats = save.driverStats || {};
  const selected = save.selectedDriver ?? 0;
  for (const driver of driverCatalog) {
    const id = driver.id;
    const current = save.driverStats[id];
    if (current && typeof current === "object") {
      save.driverStats[id] = {
        races: Math.max(0, Math.floor(current.races) || 0),
        wins: Math.max(0, Math.floor(current.wins) || 0),
        bestLap:
          typeof current.bestLap === "number" &&
          Number.isFinite(current.bestLap) &&
          current.bestLap > 0
            ? current.bestLap
            : null,
        earnings: Math.max(0, Math.floor(current.earnings) || 0),
      };
      continue;
    }
    save.driverStats[id] = id === selected ? emptyDriverStats() : seedFor(driver);
  }
  return save;
}

// Registra o resultado de uma corrida para TODOS os pilotos participantes.
export function recordRaceStats(
  save,
  results,
  { countWins = true, timeTrial = false } = {},
) {
  if (!save || !Array.isArray(results)) return;
  save.driverStats = save.driverStats || {};
  for (const r of results) {
    const id = r.driverId;
    if (id === null || id === undefined) continue;
    const stats = save.driverStats[id] || emptyDriverStats();
    stats.races += 1;
    if (countWins && r.finished && r.position === 1) stats.wins += 1;
    if (typeof r.bestLap === "number" && r.bestLap > 0) {
      if (stats.bestLap === null || r.bestLap < stats.bestLap)
        stats.bestLap = r.bestLap;
    }
    stats.earnings += r.finished
      ? timeTrial
        ? 250
        : PRIZE_BY_POSITION[r.position - 1] ?? DNF_PRIZE
      : DNF_PRIZE;
    save.driverStats[id] = stats;
  }
}

// Monta as três tabelas do ranking (ordenadas). Retorna [{ id, name, ... }].
export function buildRankings(save) {
  ensureRankingStats(save);
  const rows = driverCatalog.map((driver) => {
    const stats = save.driverStats[driver.id] || emptyDriverStats();
    return {
      id: driver.id,
      name: driver.name,
      number: driver.number,
      color: driver.color,
      tier: driver.tier,
      isPlayer: driver.id === save.selectedDriver,
      races: stats.races,
      wins: stats.wins,
      bestLap: stats.bestLap,
      earnings: stats.earnings,
    };
  });
  const byBestLap = rows
    .filter((r) => r.bestLap !== null)
    .sort((a, b) => a.bestLap - b.bestLap || b.wins - a.wins || a.id - b.id);
  const byWins = [...rows].sort(
    (a, b) =>
      b.wins - a.wins ||
      (a.bestLap ?? Infinity) - (b.bestLap ?? Infinity) ||
      a.id - b.id,
  );
  const byEarnings = [...rows].sort(
    (a, b) => b.earnings - a.earnings || b.wins - a.wins || a.id - b.id,
  );
  return { byBestLap, byWins, byEarnings };
}
