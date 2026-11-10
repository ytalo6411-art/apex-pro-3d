import { rememberRivals } from "./ai/Rivalries.js";
import { recordRound } from "./championship.js";
import { recordRaceStats } from "./ranking.js";
import { developAcademyDriver } from "./data/drivers.js";
import {
  sponsorById,
  evaluateSponsorGoal,
  teamPrincipalById,
} from "./data/sponsors.js";
export const goals = [
  {
    id: "finish",
    name: "Primeira bandeirada",
    description: "Complete uma corrida.",
    reward: 250,
    icon: "flag",
    test: (s) => s.stats.races >= 1,
  },
  {
    id: "podium",
    name: "Entre os melhores",
    description: "Conquiste um pódio.",
    reward: 350,
    icon: "podium",
    test: (s) => s.stats.podiums >= 1,
  },
  {
    id: "win",
    name: "O gosto da vitória",
    description: "Vença uma corrida.",
    reward: 600,
    icon: "trophy",
    test: (s) => s.stats.wins >= 1,
  },
  {
    id: "upgrade",
    name: "Evolução na garagem",
    description: "Compre uma melhoria.",
    reward: 150,
    icon: "bolt",
    test: (s) => s.stats.upgrades >= 1,
  },
  {
    id: "fast",
    name: "Contra o relógio",
    description: "Complete uma volta em menos de 70 s.",
    reward: 300,
    icon: "timer",
    test: (s) => s.stats.bestLap !== null && s.stats.bestLap < 70,
  },
  {
    id: "season",
    name: "Uma nova dinastia",
    description: "Complete um campeonato.",
    reward: 800,
    icon: "crown",
    test: (s) => s.stats.seasons >= 1,
  },
];
export function unlock(save) {
  const messages = [];
  for (const g of goals) {
    if (!save.objectives.includes(g.id) && g.test(save)) {
      save.objectives.push(g.id);
      save.credits += g.reward;
      messages.push(g.name + " · +" + g.reward + " CR");
    }
  }
  const rules = [
    true,
    save.stats.podiums >= 1,
    save.stats.races >= 3,
    save.stats.wins >= 1,
    save.stats.upgrades >= 3,
    save.stats.seasons >= 1,
  ];
  rules.forEach((yes, i) => {
    if (yes && !save.unlockedCars.includes(i)) {
      save.unlockedCars.push(i);
      messages.push("Novo carro desbloqueado na garagem");
    }
  });
  if (save.stats.races >= 1 && !save.unlockedPaints.includes("carbon")) {
    save.unlockedPaints.push("carbon");
    messages.push("Pintura Carbon desbloqueada");
  }
  if (save.stats.podiums >= 1 && !save.unlockedPaints.includes("heritage")) {
    save.unlockedPaints.push("heritage");
    messages.push("Pintura Heritage desbloqueada");
  }
  return messages;
}
export function rewardRace(save, race) {
  if (race.rewarded || !race.done) return null;
  race.rewarded = true;
  const results = race.results(),
    player = results.find((r) => r.id === 0),
    credits = player.finished
      ? race.mode === "time-trial"
        ? 250
        : [1200, 900, 700, 550, 450, 350][player.position - 1]
      : 100;
  save.credits += credits;
  save.xp += player.finished ? 200 + (7 - player.position) * 50 : 30;
  // Ranking local: atualiza voltas, vitórias e dinheiro de TODOS os pilotos.
  recordRaceStats(save, results, {
    countWins: race.mode !== "time-trial",
    timeTrial: race.mode === "time-trial",
  });
  save.history.push({
    track: race.trackId,
    position: player.position,
    time: player.time,
    mode: race.mode,
    driver: race.cars[0].driverId,
    car: save.selectedCar,
    stops: player.stops || 0,
    pitSeconds: player.pitSeconds || 0,
  });
  save.history = save.history.slice(-50);
  const ps = save.team.pitStats;
  for (const c of race.cars)
    if (c.teamId === race.cars[0].teamId) {
      ps.stops += c.pit.stops;
      ps.laneSeconds += c.pit.lifetimeLaneTime || 0;
      for (const h of c.pit.history)
        ps.bestService =
          ps.bestService === null
            ? h.service
            : Math.min(ps.bestService, h.service);
    }

  const key = race.trackId + ":" + race.realism + ":" + race.weather,
    lap = race.cars[0].bestLap;
  if (
    (!race.weatherProgram || race.weatherProgram === "fixed") &&
    lap &&
    (!save.records[key] || lap < save.records[key])
  )
    save.records[key] = lap;
  rememberRivals(save, race);
  if (race.mode === "mega" && player.position === 1 && player.finished) {
    save.baxterWon = true;
    if (!save.unlockedDrivers.includes(30)) save.unlockedDrivers.push(30);
    if (!save.unlockedCars.includes(11)) save.unlockedCars.push(11);
  }
  if (player.finished) save.stats.races++;
  save.stats.laps += race.cars[0].lap;
  save.stats.distance += Math.round(Math.max(0, race.cars[0].progress));
  if (player.finished && race.mode !== "time-trial") {
    if (player.position === 1) save.stats.wins++;
    if (player.position <= 3) save.stats.podiums++;
  }
  const best = race.cars[0].bestLap;
  if (best && (save.stats.bestLap === null || best < save.stats.bestLap))
    save.stats.bestLap = best;
  if (race.championship) {
    const added = recordRound(save.championship, results);
    if (added && save.championship.results.length === 3) save.stats.seasons++;
  }
  const messages = unlock(save);
  if (race.mode === "mega" && save.baxterWon)
    messages.push("MEGA BAXTER ∞ e B-0 desbloqueados");
  if (race.mode === "recovery" && player.finished && player.position <= 3) {
    save.credits += 300;
    messages.push("Desafio de recuperação concluído · +300 CR");
  }
  let sponsorReport = null;
  if (player.finished && race.mode !== "time-trial") {
    save.sponsors = save.sponsors || {
      primary: "aether_ai",
      secondary: "pirex_tires",
      goalsCompleted: 0,
      totalEarned: 0,
    };
    const primary = sponsorById(save.sponsors.primary);
    const secondary = sponsorById(save.sponsors.secondary);
    const principalMult =
      teamPrincipalById(save.teamPrincipal ?? 0).sponsorBonus || 1;
    const primaryEval = evaluateSponsorGoal(primary, race, player);
    const secondaryEval = evaluateSponsorGoal(secondary, race, player);
    const sponsorTotal = Math.round(
      (primaryEval.payout + secondaryEval.payout * 0.6) * principalMult,
    );
    save.credits += sponsorTotal;
    save.sponsors.totalEarned = (save.sponsors.totalEarned || 0) + sponsorTotal;
    if (primaryEval.met) save.sponsors.goalsCompleted++;
    if (secondaryEval.met) save.sponsors.goalsCompleted++;
    sponsorReport = {
      primaryName: primary.name,
      met: primaryEval.met,
      total: sponsorTotal,
    };
    if (primaryEval.met) {
      messages.push(
        `Meta ${primary.short} cumprida · +${sponsorTotal} CR de patrocínio`,
      );
    }
    if (Array.isArray(save.academy) && save.academy.length) {
      for (const doc of save.academy) {
        const isTitular = save.promotedAcademyId === doc.uid;
        const devRes = developAcademyDriver(doc, "race", {
          position: player.position,
          titular: isTitular,
        });
        if (isTitular && devRes.gained > 0) {
          messages.push(devRes.message);
        }
      }
    }
  }
  return { credits, position: player.position, messages, results, sponsorReport };
}
