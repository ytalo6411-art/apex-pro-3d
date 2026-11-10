import test from "node:test";
import assert from "node:assert/strict";
import { defaults, validateSave } from "../src/save.js";
import {
  buildRankings,
  ensureRankingStats,
  recordRaceStats,
  PRIZE_BY_POSITION,
} from "../src/ranking.js";
import { driverCatalog } from "../src/data/drivers.js";

test("ranking seeds every driver except the selected one starts at zero", () => {
  const s = defaults();
  assert.equal(Object.keys(s.driverStats).length, driverCatalog.length);
  assert.deepEqual(s.driverStats[0], {
    races: 0,
    wins: 0,
    bestLap: null,
    earnings: 0,
  });
  for (const d of driverCatalog) {
    if (d.id === 0) continue;
    const st = s.driverStats[d.id];
    assert.ok(st.races > 0, `driver ${d.id} seeded races`);
    assert.ok(st.bestLap > 0 && st.bestLap < 200, `driver ${d.id} seeded lap`);
    assert.ok(st.earnings > 0, `driver ${d.id} seeded earnings`);
    assert.ok(Number.isFinite(st.wins), `driver ${d.id} finite wins`);
  }
});

test("ranking survives save validation round-trip", () => {
  const s = defaults();
  const loaded = validateSave(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(loaded.driverStats, s.driverStats);
});

test("recordRaceStats updates wins, best lap and earnings for all drivers", () => {
  const s = defaults();
  const before3 = s.driverStats[3].earnings;
  const before7 = s.driverStats[7].earnings;
  const results = [
    { driverId: 0, position: 1, finished: true, bestLap: 61.5 },
    { driverId: 3, position: 2, finished: true, bestLap: 62.25 },
    { driverId: 7, position: 6, finished: false, bestLap: null },
  ];
  recordRaceStats(s, results);
  assert.equal(s.driverStats[0].races, 1);
  assert.equal(s.driverStats[0].wins, 1);
  assert.equal(s.driverStats[0].bestLap, 61.5);
  assert.equal(s.driverStats[0].earnings, PRIZE_BY_POSITION[0]);
  assert.equal(s.driverStats[3].earnings, before3 + PRIZE_BY_POSITION[1]);
  assert.equal(s.driverStats[7].earnings, before7 + 100); // DNF prize
  // A slower lap does not overwrite the best lap.
  recordRaceStats(s, [{ driverId: 0, position: 3, finished: true, bestLap: 65 }]);
  assert.equal(s.driverStats[0].bestLap, 61.5);
  assert.equal(s.driverStats[0].races, 2);
  assert.equal(s.driverStats[0].wins, 1);
});

test("time-trial counts no wins and pays the flat 250 prize", () => {
  const s = defaults();
  recordRaceStats(
    s,
    [{ driverId: 0, position: 1, finished: true, bestLap: 58 }],
    { countWins: false, timeTrial: true },
  );
  assert.equal(s.driverStats[0].wins, 0);
  assert.equal(s.driverStats[0].earnings, 250);
});

test("buildRankings sorts by lap, wins and earnings with player flagged", () => {
  const s = defaults();
  // Zero out the seeds so the player's real results decide the order.
  for (const id of Object.keys(s.driverStats))
    s.driverStats[id] = { races: 0, wins: 0, bestLap: null, earnings: 0 };
  recordRaceStats(s, [
    { driverId: 0, position: 1, finished: true, bestLap: 55.0 },
    { driverId: 1, position: 2, finished: true, bestLap: 56.0 },
  ]);
  const { byBestLap, byWins, byEarnings } = buildRankings(s);
  assert.equal(byBestLap[0].id, 0); // fastest lap is the player's
  assert.equal(byWins[0].id, 0); // most wins is the player's
  assert.equal(byEarnings[0].id, 0); // most money is the player's
  assert.ok(byBestLap.find((r) => r.isPlayer));
  assert.ok(byWins.every((r, i, a) => i === 0 || a[i - 1].wins >= r.wins));
  assert.ok(
    byEarnings.every((r, i, a) => i === 0 || a[i - 1].earnings >= r.earnings),
  );
  assert.ok(
    byBestLap.every((r, i, a) => i === 0 || a[i - 1].bestLap <= r.bestLap),
  );
});

test("ensureRankingStats is idempotent and never overwrites real results", () => {
  const s = defaults();
  recordRaceStats(s, [{ driverId: 0, position: 1, finished: true, bestLap: 60 }]);
  const before = JSON.stringify(s.driverStats);
  ensureRankingStats(s);
  assert.equal(JSON.stringify(s.driverStats), before);
});
