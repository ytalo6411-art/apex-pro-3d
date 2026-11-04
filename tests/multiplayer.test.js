import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Race, collisionParticipants } from "../src/race.js";
import { defaults, validateSave } from "../src/save.js";
import { BASE } from "../src/physics.js";
import { configureTrack } from "../src/track.js";
import {
  assertRaceLaps,
  clampRaceLaps,
  MAX_GRID_CARS,
  MAX_RACE_LAPS,
  MIN_RACE_LAPS,
  validateRoomSettings,
} from "../src/racing/RaceConfig.js";
import {
  applyInterpolatedState,
  INPUT_INTERVAL_MS,
  isValidRaceSnapshot,
  makeRaceSnapshot,
  MAX_PACKET_BYTES,
  measurePacketBytes,
  SNAPSHOT_INTERVAL_MS,
  validateRaceInput,
} from "../src/multiplayer/NetworkProtocol.js";
import { MultiplayerClient } from "../src/multiplayer/MultiplayerClient.js";
import { isValidSessionUser, isPlaceholderUsername } from "../src/multiplayer/supabase.js";
import { resolveAccountSave } from "../src/multiplayer/CloudSave.js";

const RACE_ID = "74a2a023-270f-4e53-923e-e99bbbc5ca4d";
const HOST_ID = "54a1a023-270f-4e53-923e-e99bbbc5ca4d";
const GUEST_ID = "64a1a023-270f-4e53-923e-e99bbbc5ca4d";
const ROOM_ID = "44a1a023-270f-4e53-923e-e99bbbc5ca4d";

function roomSettings(overrides = {}) {
  return {
    name: "Sala de teste",
    visibility: "private",
    trackId: "aurora",
    lapCount: MIN_RACE_LAPS,
    maxPlayers: 2,
    botCount: 4,
    ...overrides,
  };
}

function networkRace({ authoritative, localCarId }) {
  configureTrack("aurora");
  const remoteInputs = new Map();
  const remoteInputAt = new Map();
  const race = new Race({
    difficulty: "normal",
    laps: MIN_RACE_LAPS,
    stats: BASE,
    specStats: BASE,
    botCount: 2,
    delegated: false,
    network: {
      authoritative,
      localPlayerId: localCarId === 0 ? HOST_ID : GUEST_ID,
      hostPlayerId: HOST_ID,
      remoteInputs,
      remoteInputAt,
    },
  });
  for (const [index, car] of race.cars.entries()) {
    car.networkEntityId = index < 2
      ? `player:${index === 0 ? HOST_ID : GUEST_ID}`
      : `bot:${index - 2}`;
    car.isNetworkHuman = index < 2;
    car.isNetworkLocal = index === localCarId;
  }
  race.localCarId = localCarId;
  race.network.localCarId = localCarId;
  race.state = "racing";
  return race;
}

test("online lap setting is exactly 8 minimum, preserves max 30 and migrates old saves", () => {
  assert.equal(MIN_RACE_LAPS, 8);
  assert.equal(MAX_RACE_LAPS, 30);
  assert.equal(clampRaceLaps(1), 8);
  assert.equal(clampRaceLaps("3"), 8);
  assert.equal(clampRaceLaps(30), 30);
  assert.equal(clampRaceLaps(99), 30);
  assert.throws(() => assertRaceLaps(7), RangeError);
  assert.equal(assertRaceLaps(8), 8);
  assert.equal(defaults().settings.laps, 8);
  assert.equal(
    validateSave({
      ...defaults(),
      settings: { ...defaults().settings, laps: 3 },
    }).settings.laps,
    8,
  );
  assert.equal(
    validateSave({
      ...defaults(),
      settings: { ...defaults().settings, laps: 80 },
    }).settings.laps,
    30,
  );
  assert.equal(validateRoomSettings(roomSettings()).lapCount, 8);
  assert.throws(() => validateRoomSettings(roomSettings({ lapCount: 7 })), RangeError);
  assert.throws(() => validateRoomSettings(roomSettings({ lapCount: 31 })), RangeError);
  assert.throws(
    () => validateRoomSettings(roomSettings({ maxPlayers: MAX_GRID_CARS + 1 })),
    RangeError,
  );
});

test("every shared distance preset used for player launches respects eight laps", async () => {
  const { RACE_DISTANCE_PRESETS } = await import("../src/race.js");
  for (const preset of Object.values(RACE_DISTANCE_PRESETS))
    if (Number.isInteger(preset.laps)) assert.ok(preset.laps >= 8);
});

test("race snapshots include bounded race/car telemetry and fit the Realtime packet budget", () => {
  const race = networkRace({ authoritative: true, localCarId: 0 });
  race.state = "racing";
  race.countdown = 0;
  const snapshot = makeRaceSnapshot(race, RACE_ID, 1);
  assert.equal(snapshot.cars.length, 3);
  assert.equal(isValidRaceSnapshot(snapshot, RACE_ID), true);
  assert.ok(measurePacketBytes(snapshot) <= MAX_PACKET_BYTES);
  assert.ok(snapshot.cars.every((car) => car.pit && car.tireCompound && Number.isFinite(car.fuel)));
  assert.equal(INPUT_INTERVAL_MS, 50);
  assert.equal(SNAPSHOT_INTERVAL_MS, 50);

  const badSpeed = structuredClone(snapshot);
  badSpeed.cars[0].speed = 151;
  assert.equal(isValidRaceSnapshot(badSpeed, RACE_ID), false);
  const duplicate = structuredClone(snapshot);
  duplicate.cars[1].entityId = duplicate.cars[0].entityId;
  assert.equal(isValidRaceSnapshot(duplicate, RACE_ID), false);
  const badPit = structuredClone(snapshot);
  badPit.cars[0].pit.state = "teleport";
  assert.equal(isValidRaceSnapshot(badPit, RACE_ID), false);
  const badEvent = structuredClone(snapshot);
  badEvent.events = [{ id: 1, type: "start", entityId: "x", detail: "x".repeat(121), time: 0 }];
  assert.equal(isValidRaceSnapshot(badEvent, RACE_ID), false);
});

test("player input is allow-listed, race-bound and clamped before the host simulates it", () => {
  const allowed = new Set([HOST_ID, GUEST_ID]);
  assert.deepEqual(
    validateRaceInput({
      raceId: RACE_ID,
      playerId: GUEST_ID,
      seq: 4,
      input: { throttle: 1.8, brake: -1, steer: 0.45 },
    }, RACE_ID, allowed),
    {
      playerId: GUEST_ID,
      seq: 4,
      input: { throttle: 1, brake: 0, steer: 0.45 },
    },
  );
  assert.equal(
    validateRaceInput({ raceId: "wrong", playerId: GUEST_ID, seq: 1, input: {} }, RACE_ID, allowed),
    null,
  );
  assert.equal(
    validateRaceInput({ raceId: RACE_ID, playerId: "stranger", seq: 1, input: { throttle: 1, brake: 0, steer: 0 } }, RACE_ID, allowed),
    null,
  );
  assert.equal(
    validateRaceInput({ raceId: RACE_ID, playerId: GUEST_ID, seq: 1, input: { throttle: NaN, brake: 0, steer: 0 } }, RACE_ID, allowed),
    null,
  );
});

test("host simulates remote inputs while clients control the correctly ordered local car", () => {
  const now = performance.now();
  const hostRace = networkRace({ authoritative: true, localCarId: 0 });
  hostRace.network.remoteInputs.set(`player:${GUEST_ID}`, { throttle: 1, brake: 0, steer: 0 });
  hostRace.network.remoteInputAt.set(`player:${GUEST_ID}`, now);
  hostRace.step(1 / 60, { throttle: 0, brake: 0, steer: 0 });
  assert.equal(hostRace.localCar.id, 0);
  assert.ok(hostRace.cars[1].speed > 0, "host must apply the guest's validated input");

  const guestRace = networkRace({ authoritative: false, localCarId: 1 });
  const guestCollisionTraffic = collisionParticipants(
    guestRace.control.traffic,
    guestRace.network,
  );
  assert.ok(guestCollisionTraffic.includes(guestRace.localCar));
  assert.equal(guestRace.isLocalCar(guestRace.localCar), true);
  assert.ok(!guestRace.isLocalCar(guestRace.cars[0]));
  assert.ok(!guestCollisionTraffic.includes(guestRace.cars[0]));
  assert.ok(guestRace.cars.slice(2).every((car) => guestCollisionTraffic.includes(car)));
  guestRace.step(1 / 60, { throttle: 1, brake: 0, steer: 0 });
  assert.equal(guestRace.localCar.id, 1);
  assert.ok(guestRace.cars[1].speed > 0, "guest input must drive its own entity, not the host car");
  assert.equal(guestRace.cars[0].speed, 0, "a client must not simulate a remote human car");
});

test("snapshot interpolation wraps heading and synchronizes resources and pit status", () => {
  configureTrack("aurora");
  const car = new Race({ laps: 8, botCount: 0 }).cars[0];
  const previous = {
    x: 0, z: 0, heading: Math.PI - 0.1, speed: 20, s: 0, lateral: 0,
    progress: 0, vx: 1, vz: 0, lapTime: 10, lap: 1, bestLap: 90,
    finishTime: null, finished: false, retired: false, fuel: 40,
    fuelPerLap: 3, tireCompound: "medium", tireHealth: 0.8,
    tireTemperature: 90, damage: 0.1, wingDamage: 0, mechanical: 0,
    penalty: 0, throttle: 0.5, brake: 0, steer: 0,
    pit: { state: "track", requested: false, stops: 0, through: false, mergeWaiting: false },
    retirement: "",
  };
  const current = {
    ...previous,
    x: 10,
    heading: -Math.PI + 0.1,
    speed: 30,
    progress: 10,
    fuel: 38,
    tireHealth: 0.7,
    tireTemperature: 100,
    damage: 0.2,
    tireCompound: "soft",
    pit: { state: "queue", requested: true, stops: 1, through: false, mergeWaiting: true },
  };
  applyInterpolatedState(car, previous, current, 0.5);
  assert.ok(Math.abs(car.heading - Math.PI) < 0.01);
  assert.equal(car.x, 5);
  assert.equal(car.fuel, 39);
  assert.equal(car.tires.health, 0.75);
  assert.equal(car.tires.compound, "soft");
  assert.equal(car.pit.state, "queue");
  assert.equal(car.pit.requested, true);
});

test("anonymous player identities are valid sessions; placeholder usernames require the identity screen", async () => {
  assert.equal(isValidSessionUser({
    id: GUEST_ID,
    is_anonymous: true,
    app_metadata: { provider: "anonymous", providers: ["anonymous"] },
  }), true, "anonymous Supabase sessions are first-class identities");
  assert.equal(isValidSessionUser({
    id: HOST_ID,
    is_anonymous: false,
    email_confirmed_at: "2026-11-04T10:00:00Z",
  }), true, "legacy e-mail accounts keep working");
  assert.equal(isValidSessionUser(null), false);
  assert.equal(isValidSessionUser({}), false);
  assert.equal(isPlaceholderUsername("pilot_ab12cd34"), true);
  assert.equal(isPlaceholderUsername("veloz_racer42"), false);

  // anonymous session + profile with placeholder username -> identity screen
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { user: {
          id: GUEST_ID,
          is_anonymous: true,
          app_metadata: { provider: "anonymous", providers: ["anonymous"] },
        } } },
        error: null,
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: GUEST_ID, username: "pilot_ab12cd34", username_claimed: false, display_name: "Piloto" },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async () => { throw new Error("must not call room RPCs before the name is claimed"); },
  };
  const game = { ui: { page: "account", render() {}, toast() {} } };
  const multiplayer = new MultiplayerClient(game, { client, configured: true });
  const profile = await multiplayer.loadExistingProfile();
  assert.equal(profile.username, "pilot_ab12cd34");
  assert.equal(multiplayer.state.authView, "identity", "placeholder username forces the identity screen");
  // the anonymous identity itself is accepted (the room RPC is reached);
  // the identity SCREEN is what gates the UI until the name is claimed.
  await assert.rejects(multiplayer.createRoom(roomSettings()), /must not call room RPCs/);

  // claimed username -> normal access
  const claimed = {
    ...client,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: GUEST_ID, username: "veloz_racer42", username_claimed: true, display_name: "Veloz" },
            error: null,
          }),
        }),
      }),
    }),
  };
  const mp2 = new MultiplayerClient(game, { client: claimed, configured: true });
  await mp2.loadExistingProfile();
  assert.equal(mp2.state.authView, "identity", "default view is identity until claimed (state default)");
  mp2.state.authView = "";
  await mp2.loadExistingProfile();
  assert.equal(mp2.state.profile.username, "veloz_racer42");
});

test("claimUsername validates, rejects duplicates and completes the account boot", async () => {
  let claimed = null;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: GUEST_ID, is_anonymous: true } } }, error: null }),
      signInAnonymously: async () => ({ data: { user: { id: GUEST_ID, is_anonymous: true } }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: GUEST_ID, username: "pilot_ab12cd34", username_claimed: false, display_name: "Piloto" },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (name, args) => {
      if (name === "username_available")
        return { data: args.p_username === "taken_name" ? false : true, error: null };
      if (name === "set_username") {
        claimed = args.p_username;
        return { data: { id: GUEST_ID, username: args.p_username, username_claimed: true, display_name: "Piloto" }, error: null };
      }
      if (name === "load_player_save") return { data: null, error: null };
      if (name === "save_player_save") return { data: { revision: 1 }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const game = {
    ui: { page: "account", render() {}, toast() {}, modal: null },
    authStatus: "identity",
    save: defaults(),
    world: { setMode() {}, setPreview() {}, raceContext: null },
    applyCloudSave() {},
  };
  const mp = new MultiplayerClient(game, { client, configured: true });
  await mp.loadExistingProfile();
  assert.equal(mp.state.authView, "identity");

  await assert.rejects(mp.claimUsername("ab"), /username_invalid/);
  await assert.rejects(mp.claimUsername("taken_name"), /username_taken/i);
  await mp.claimUsername("veloz_racer42");
  assert.equal(claimed, "veloz_racer42");
  assert.equal(mp.state.profile.username, "veloz_racer42");
  assert.equal(mp.state.profile.username_claimed, true);
  assert.equal(game.authStatus, "ready", "after claiming the name the game boots fully");

  // random name generator produces valid, unique-format names
  for (let i = 0; i < 50; i++) {
    const name = mp.randomPilotName();
    assert.match(name, /^[a-z0-9_]{3,20}$/);
  }
});

test("signup requires unique username, matching passwords and shows the confirm-e-mail screen", async () => {
  const calls = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signUp: async ({ email, password, options }) => {
        calls.push(`signUp:${email}:${options?.data?.username}`);
        assert.equal(password, "senha12345");
        return { data: { user: { id: GUEST_ID, email }, session: null }, error: null };
      },
    },
    rpc: async (name, args) => {
      calls.push(`rpc:${name}:${args?.p_username}`);
      if (name === "username_available") return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const game = { ui: { page: "account", render() {}, toast() {} }, authStatus: "login-required" };
  const multiplayer = new MultiplayerClient(game, { client, configured: true });

  await assert.rejects(
    multiplayer.signUp({ username: "ab", email: "piloto@example.com", password: "senha12345", confirmPassword: "senha12345" }),
    /username_invalid/,
  );
  await assert.rejects(
    multiplayer.signUp({ username: "piloto_01", email: "piloto@example.com", password: "senha12345", confirmPassword: "outra12345" }),
    /password_mismatch/,
  );
  await assert.rejects(
    multiplayer.signUp({ username: "piloto_01", email: "piloto@example.com", password: "123", confirmPassword: "123" }),
    /8 caracteres/,
  );

  await multiplayer.signUp({
    username: "Piloto_01",
    email: "Piloto@Example.com",
    password: "senha12345",
    confirmPassword: "senha12345",
  });
  assert.equal(multiplayer.state.authView, "confirm");
  assert.equal(multiplayer.state.pendingEmail, "piloto@example.com");
  assert.equal(multiplayer.state.emailUnconfirmed, true);
  assert.ok(calls.includes("rpc:username_available:Piloto_01"));
  assert.ok(calls.includes("signUp:piloto@example.com:Piloto_01"));
  assert.equal(multiplayer.state.profile, null, "no access before the e-mail is confirmed");
});

test("login resolves username to e-mail, keeps session preference and loads the profile", async () => {
  let session = null;
  const client = {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInWithPassword: async ({ email, password }) => {
        assert.equal(email, "piloto@example.com");
        assert.equal(password, "senha12345");
        session = { user: { id: HOST_ID, email, email_confirmed_at: "2026-11-04T10:00:00Z" } };
        return { data: { session }, error: null };
      },
      signOut: async () => { session = null; return { error: null }; },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: HOST_ID, username: "piloto_01", display_name: "Piloto_01" },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (name, args) => {
      if (name === "email_for_username")
        return { data: args.p_username === "piloto_01" ? "piloto@example.com" : null, error: null };
      if (name === "load_player_save") return { data: null, error: null };
      if (name === "save_player_save") return { data: { revision: 1 }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const game = {
    ui: { page: "account", render() {}, toast() {}, modal: null },
    authStatus: "login-required",
    save: defaults(),
    applyCloudSave() {},
  };
  const multiplayer = new MultiplayerClient(game, { client, configured: true });
  multiplayer.game.world = { setMode() {}, setPreview() {}, raceContext: null };

  await assert.rejects(
    multiplayer.signInWithCredentials({ identifier: "ninguem", password: "senha12345" }),
    /account_not_found/,
  );
  const ok = await multiplayer.signInWithCredentials({
    identifier: "piloto_01",
    password: "senha12345",
    keepSignedIn: true,
  });
  assert.equal(ok, true);
  assert.equal(multiplayer.state.profile.username, "piloto_01");
  assert.equal(multiplayer.isSignedIn, true);
  assert.equal(game.authStatus, "ready");

  await multiplayer.signOut();
  assert.equal(multiplayer.state.profile, null);
  assert.equal(game.authStatus, "login-required");
  assert.equal(multiplayer.state.authView, "identity", "after logout the pilot identity screen is shown again");
});

test("invite codes are exactly eight characters and survive room-state refreshes", async () => {
  const client = {
    rpc: async (name) => {
      if (name === "join_room")
        return { data: { id: ROOM_ID, code: "ABC12345" }, error: null };
      if (name === "get_room_state")
        return {
          data: {
            room: { id: ROOM_ID, host_id: HOST_ID, status: "results" },
            players: [],
            results: [],
          },
          error: null,
        };
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const game = { ui: { page: "multiplayer", render() {}, toast() {} } };
  const multiplayer = new MultiplayerClient(game, { client, configured: true });
  multiplayer.state.profile = { id: HOST_ID, username: "host_01", display_name: "Host" };
  multiplayer.attachRoom = async (id, code) => {
    multiplayer.activeRoomId = id;
    multiplayer.roomCode = code;
  };
  multiplayer.onRoomStateChanged = () => {};

  await assert.rejects(multiplayer.joinRoomByCode("ABC1234"), /8 caracteres/);
  await multiplayer.joinRoomById(ROOM_ID);
  assert.equal(multiplayer.state.room.code, "ABC12345");
});

test("account save resolution prefers cloud data and seeds a new account from the validated local save", () => {
  const localSave = defaults();
  localSave.credits = 4700;
  const cloudSave = defaults();
  cloudSave.credits = 875;

  const existing = resolveAccountSave(
    { save_data: cloudSave, revision: 4 },
    localSave,
  );
  assert.equal(existing.source, "cloud");
  assert.equal(existing.revision, 4);
  assert.equal(existing.save.credits, 875);

  const firstLogin = resolveAccountSave(null, localSave);
  assert.equal(firstLogin.source, "local");
  assert.equal(firstLogin.revision, 0);
  assert.equal(firstLogin.save.credits, 4700);
  assert.throws(
    () => resolveAccountSave({ save_data: { version: 2 }, revision: 1 }, localSave),
    /cloud_save_invalid/,
  );
});

test("cloud career migration gates account saves behind a confirmed e-mail account, with RLS, size validation and revisions", () => {
  const sql = fs.readFileSync(
    "supabase/migrations/20261104120000_email_password_auth.sql",
    "utf8",
  );
  const savesMigration = fs.readFileSync(
    "supabase/migrations/20261029201652_google_account_cloud_saves.sql",
    "utf8",
  );
  assert.match(savesMigration, /create table if not exists public\.player_saves/);
  assert.match(savesMigration, /alter table public\.player_saves enable row level security/);
  assert.match(savesMigration, /revoke all on table public\.player_saves from public, anon, authenticated/);
  assert.match(sql, /public\.is_confirmed_user\(\) and user_id = auth\.uid\(\)/);
  assert.match(sql, /perform public\.require_confirmed_user\(\)/);
  assert.match(sql, /cloud_save_too_large/);
  assert.match(sql, /save_revision_conflict/);
  assert.match(sql, /p_expected_revision/);
  assert.match(sql, /grant execute on function public\.load_player_save\(\) to authenticated/);
  assert.match(sql, /grant execute on function public\.save_player_save\(jsonb, bigint\) to authenticated/);
  assert.doesNotMatch(sql, /service_role|service-role/i);
  // The Google-era gate functions are dropped, not reused.
  assert.match(sql, /drop function if exists public\.is_google_user\(\)/);
  assert.match(sql, /drop function if exists public\.require_google_user\(\)/);
  // No Google/OAuth code remains in the frontend auth path.
  for (const file of [
    "src/multiplayer/MultiplayerClient.js",
    "src/multiplayer/MultiplayerUI.js",
    "src/multiplayer/supabase.js",
    "src/main.js",
  ]) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /google|signInWithOAuth|oauth/i,
      `${file} must not reference Google or OAuth`,
    );
  }

  const gameSource = fs.readFileSync("src/core/Game.js", "utf8");
  const uiSource = fs.readFileSync("src/ui.js", "utf8");
  assert.match(gameSource, /this\.authStatus !== "ready"/);
  assert.doesNotMatch(gameSource, /export-save|apex-dynasty-save\.json/);
  assert.doesNotMatch(uiSource, /EXPORTAR SAVE|export-save/);
  assert.match(uiSource, /this\.page === "account"/);
});

test("database migration enables explicit RLS and restricts room broadcast identities", () => {
  const sql = fs.readFileSync("supabase/migrations/20261028211101_multiplayer.sql", "utf8");
  for (const table of ["profiles", "rooms", "room_players", "race_results"])
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(sql, /can_send_room_event\(text, text, jsonb\)/);
  assert.match(sql, /v_body ->> 'playerId' is distinct from v_actor::text/);
  assert.match(sql, /r\.host_id = v_actor/);
  assert.match(
    sql,
    /create or replace function public\.begin_room_race[\s\S]*?v_room\.host_id <> auth\.uid\(\) then raise exception 'host_only'/,
  );
  const privilegeMigration = fs.readFileSync(
    "supabase/migrations/20261028211941_revoke_anon_public_table_privileges.sql",
    "utf8",
  );
  assert.match(privilegeMigration, /revoke all[\s\S]*?from anon/);
  assert.match(sql, /lap_count integer not null check \(lap_count between 8 and 30\)/);
  assert.doesNotMatch(sql, /service_role|service-role/i);
  const emailMigration = fs.readFileSync(
    "supabase/migrations/20261104120000_email_password_auth.sql",
    "utf8",
  );
  assert.match(emailMigration, /create or replace function public\.is_confirmed_user/);
  assert.match(emailMigration, /auth\.jwt\(\) ->> 'is_anonymous' is distinct from 'true'/);
  assert.match(emailMigration, /email_account_required/);
  assert.match(emailMigration, /using \(public\.is_confirmed_user\(\)/);
  // Unique usernames are enforced at the database level; passwords never live in public tables.
  assert.match(emailMigration, /profiles_username_unique unique \(username\)/);
  assert.match(emailMigration, /profiles_username_format/);
  for (const rpc of [
    "create_room", "join_room", "set_room_connection", "room_heartbeat",
    "set_room_ready", "configure_room", "start_room", "begin_room_race",
    "finish_room_race", "return_room_to_lobby", "leave_room",
    "list_public_rooms", "get_room_state", "set_display_name",
  ]) {
    assert.match(
      emailMigration,
      new RegExp(`create or replace function public\\.${rpc}\\([\\s\\S]*?require_confirmed_user`),
    );
  }
  // Username login helpers exist for the e-mail/password flow.
  assert.match(emailMigration, /create or replace function public\.username_available/);
  assert.match(emailMigration, /create or replace function public\.email_for_username/);
  assert.match(emailMigration, /create or replace function public\.set_username/);
});

// ---------------------------------------------------------------------------
// Two-account multiplayer integration: a shared in-memory Supabase mock plays
// the role of the real project (rooms + room_players + RPC guards), and two
// MultiplayerClient instances behave like two browsers signed in with two
// different confirmed e-mail accounts.
// ---------------------------------------------------------------------------
function makeSupabaseMock() {
  const db = { rooms: new Map(), players: new Map() };
  const pkey = (roomId, playerId) => `${roomId}:${playerId}`;
  const activePlayers = (roomId) =>
    [...db.players.values()].filter((p) => p.room_id === roomId && p.left_at === null);

  function makeClient(user) {
    const call = async (name, args = {}) => {
      switch (name) {
        case "create_room": {
          const room = {
            id: crypto.randomUUID(),
            code: crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase(),
            host_id: user.id,
            name: args.p_name,
            visibility: args.p_visibility,
            track_id: args.p_track_id,
            lap_count: args.p_lap_count,
            max_players: args.p_max_players,
            bot_count: args.p_bot_count,
            status: "waiting",
            race_id: null,
          };
          db.rooms.set(room.id, room);
          db.players.set(pkey(room.id, user.id), {
            room_id: room.id, player_id: user.id, role: "host",
            ready: false, connection_status: "reconnecting", left_at: null,
          });
          return { data: { id: room.id, code: room.code }, error: null };
        }
        case "join_room": {
          const room = [...db.rooms.values()].find(
            (r) => (args.p_room_id && r.id === args.p_room_id) || (args.p_code && r.code === args.p_code),
          );
          if (!room || room.status === "closed") throw new Error("room_unavailable");
          const existing = db.players.get(pkey(room.id, user.id));
          if (existing && existing.left_at === null) {
            existing.connection_status = "reconnecting";
            return { data: { id: room.id, code: room.code, reconnected: true }, error: null };
          }
          if (room.status !== "waiting") throw new Error("room_not_accepting_players");
          if (room.visibility === "private" && args.p_code !== room.code)
            throw new Error("invalid_invite_code");
          if (activePlayers(room.id).length >= room.max_players) throw new Error("room_full");
          db.players.set(pkey(room.id, user.id), {
            room_id: room.id, player_id: user.id, role: "driver",
            ready: false, connection_status: "reconnecting", left_at: null,
          });
          return { data: { id: room.id, code: room.code, reconnected: false }, error: null };
        }
        case "get_room_state": {
          const room = db.rooms.get(args.p_room_id);
          if (!room) throw new Error("room_unavailable");
          const players = [...db.players.values()]
            .filter((p) => p.room_id === room.id)
            .map((p) => ({
              ...p,
              display_name: p.player_id === user.id ? user.username : `user-${p.player_id.slice(0, 4)}`,
            }));
          return { data: { room, players, results: [], server_time: new Date().toISOString() }, error: null };
        }
        case "set_room_connection":
        case "room_heartbeat": {
          const p = db.players.get(pkey(args.p_room_id, user.id));
          if (p) { p.connection_status = args.p_status || "online"; p.left_at = p.left_at; }
          return { data: {}, error: null };
        }
        case "set_room_ready": {
          const p = db.players.get(pkey(args.p_room_id, user.id));
          if (!p || p.left_at !== null) throw new Error("not_a_room_member");
          p.ready = !!args.p_ready;
          return { data: {}, error: null };
        }
        case "start_room": {
          const room = db.rooms.get(args.p_room_id);
          if (!room || room.host_id !== user.id) throw new Error("host_only");
          const active = activePlayers(room.id);
          if (room.status !== "waiting") throw new Error("room_not_waiting");
          if (!active.length || !active.every((p) => p.ready)) throw new Error("all_players_must_be_ready");
          room.status = "countdown";
          room.race_id = crypto.randomUUID();
          return { data: { id: room.id, status: room.status, race_id: room.race_id }, error: null };
        }
        case "leave_room": {
          const p = db.players.get(pkey(args.p_room_id, user.id));
          if (p) p.left_at = new Date().toISOString();
          return { data: {}, error: null };
        }
        case "configure_room": {
          const room = db.rooms.get(args.p_room_id);
          if (!room || room.host_id !== user.id) throw new Error("host_only");
          if (room.status !== "waiting") throw new Error("room_not_waiting");
          room.name = args.p_name;
          room.visibility = args.p_visibility;
          room.track_id = args.p_track_id;
          room.lap_count = args.p_lap_count;
          room.max_players = args.p_max_players;
          room.bot_count = args.p_bot_count;
          return { data: { ...room }, error: null };
        }
        case "list_public_rooms": {
          return {
            data: [...db.rooms.values()]
              .filter((r) => r.visibility === "public" && r.status === "waiting")
              .map((r) => ({ ...r, player_count: activePlayers(r.id).length })),
            error: null,
          };
        }
        default:
          throw new Error(`Unexpected RPC: ${name}`);
      }
    };
    return {
      auth: {
        getSession: async () => ({ data: { session: { user } }, error: null }),
        signInWithPassword: async () => ({ data: { session: { user } }, error: null }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: user.id, username: user.username, display_name: user.username },
              error: null,
            }),
          }),
        }),
      }),
      channel: () => {
        const ch = {
          on: () => ch,
          subscribe: (cb) => { setTimeout(() => cb("SUBSCRIBED"), 0); return ch; },
          track: async () => ({}),
        };
        return ch;
      },
      removeChannel: async () => {},
      rpc: call,
    };
  }
  return { makeClient, db };
}

function makeGameStub() {
  return {
    ui: { page: "multiplayer", render() {}, toast() {}, closeModal() {}, modal: null },
    authStatus: "ready",
    save: defaults(),
    race: null,
    onlineRaceContext: null,
    controls: { clear() {} },
    world: { setMode() {}, setPreview() {}, raceContext: null },
    applyCloudSave() {},
    startOnlineRace(context) { this.onlineRaceContext = context; },
  };
}

test("two confirmed accounts create/join one room, sync state, start together and survive leave/rejoin without duplicates", async () => {
  const { makeClient } = makeSupabaseMock();
  const aliceUser = { id: crypto.randomUUID(), email: "alice@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "alice_01" };
  const bobUser = { id: crypto.randomUUID(), email: "bob@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "bob_02" };

  const alice = new MultiplayerClient(makeGameStub(), { client: makeClient(aliceUser), configured: true });
  const bob = new MultiplayerClient(makeGameStub(), { client: makeClient(bobUser), configured: true });
  alice.state.profile = { id: aliceUser.id, username: "alice_01", display_name: "alice_01" };
  bob.state.profile = { id: bobUser.id, username: "bob_02", display_name: "bob_02" };
  alice.prepareRoomTrack = async () => true;
  bob.prepareRoomTrack = async () => true;

  try {
    // Alice creates a public room; the 8-char code is the invite.
    await alice.createRoom(roomSettings({ name: "Duelo Apex", visibility: "public", maxPlayers: 2, botCount: 0 }));
    const roomId = alice.state.room.id;
    const code = alice.state.room.code;
    assert.match(code, /^[A-Z0-9]{8}$/);

    // Bob finds the room in the public list and joins by code.
    await bob.refreshPublicRooms();
    assert.equal(bob.state.publicRooms.length, 1);
    await bob.joinRoomByCode(code);
    await alice.refreshRoomState();
    await bob.refreshRoomState();

    // Both clients see exactly the same two players, once each.
    assert.equal(alice.state.players.length, 2);
    assert.equal(bob.state.players.length, 2);
    const ids = alice.state.players.map((p) => p.player_id).sort();
    assert.deepEqual(ids, [aliceUser.id, bobUser.id].sort());
    assert.equal(new Set(ids).size, 2, "no duplicate players in the room");
    assert.equal(alice.state.room.host_id, aliceUser.id);

    // Bob rejoining (reconnect) must not create a duplicate seat.
    await bob.joinRoomById(roomId);
    await alice.refreshRoomState();
    assert.equal(alice.state.players.filter((p) => p.player_id === bobUser.id).length, 1);

    // Both ready, host starts: the room state flips for everyone.
    await alice.setReady(true);
    await bob.setReady(true);
    await alice.startRoom();
    await bob.refreshRoomState();
    assert.equal(alice.state.room.status, "countdown");
    assert.equal(bob.state.room.status, "countdown");
    assert.ok(alice.state.room.race_id);

    // Bob leaves mid-session: Alice's room keeps working, Bob's seat is marked left.
    await bob.leaveRoom();
    await alice.refreshRoomState();
    assert.equal(alice.state.room.id, roomId, "host room survives the guest leaving");
    assert.equal(alice.state.players.filter((p) => p.player_id === aliceUser.id && p.left_at === null).length, 1);
    assert.equal(bob.state.room, null);
    assert.equal(alice.state.error, "");
  } finally {
    // Let in-flight channel subscribe callbacks settle, then dispose and clear
    // any heartbeat/refresh timers so the test process can exit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await alice.dispose();
    await bob.dispose();
    clearInterval(alice.heartbeatTimer);
    clearInterval(bob.heartbeatTimer);
    clearTimeout(alice.refreshTimer);
    clearTimeout(bob.refreshTimer);
  }
});

// ---------------------------------------------------------------------------
// Fase 1 — partida rápida "JOGAR AGORA": entra na sala pública com mais vagas,
// cria sala pública se não houver, aguarda outros jogadores e preenche com
// bots após o limite; com cancelamento e proteção contra duplicidade.
// ---------------------------------------------------------------------------
function makeQuickPlayClient(makeClient, user, extraOptions = {}) {
  const game = makeGameStub();
  const mp = new MultiplayerClient(game, {
    client: makeClient(user),
    configured: true,
    quickPlayWaitMs: extraOptions.quickPlayWaitMs ?? 30000,
    quickPlayPollMs: extraOptions.quickPlayPollMs ?? 2000,
  });
  mp.state.profile = { id: user.id, username: user.username, display_name: user.username };
  mp.prepareRoomTrack = async () => true;
  return mp;
}

test("JOGAR AGORA entra na sala pública com mais vagas livres", async () => {
  const { makeClient, db } = makeSupabaseMock();
  const hostUser = { id: crypto.randomUUID(), email: "host@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "host_01" };
  const seeker = { id: crypto.randomUUID(), email: "busca@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "busca_01" };

  // Host cria duas salas públicas: "Cheia" (5/6 ocupadas) e "Vazia" (1/6).
  const host = makeQuickPlayClient(makeClient, hostUser, { quickPlayWaitMs: 100, quickPlayPollMs: 20 });
  await host.createRoom(roomSettings({ name: "Cheia", visibility: "public", maxPlayers: 6, botCount: 0 }));
  const fullRoomId = host.state.room.id;
  for (let i = 0; i < 4; i++) {
    const ghostId = crypto.randomUUID();
    db.players.set(`${fullRoomId}:${ghostId}`, {
      room_id: fullRoomId, player_id: ghostId, role: "driver",
      ready: false, connection_status: "online", left_at: null,
    });
  }
  await host.leaveRoom();
  await host.createRoom(roomSettings({ name: "Vazia", visibility: "public", maxPlayers: 6, botCount: 0 }));
  const openRoomId = host.state.room.id;
  await host.leaveRoom();

  const seekerMp = makeQuickPlayClient(makeClient, seeker, { quickPlayWaitMs: 100, quickPlayPollMs: 20 });
  try {
    await seekerMp.quickPlay();
    assert.equal(seekerMp.activeRoomId, openRoomId, "deve escolher a sala com mais vagas (Vazia, 1/6) e não a outra");
    assert.equal(seekerMp.state.room.name, "Vazia");
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await seekerMp.dispose();
    clearInterval(seekerMp.heartbeatTimer);
    clearTimeout(seekerMp.refreshTimer);
    await host.dispose();
    clearInterval(host.heartbeatTimer);
    clearTimeout(host.refreshTimer);
  }
});

test("JOGAR AGORA cria sala pública quando não há nenhuma disponível", async () => {
  const { makeClient } = makeSupabaseMock();
  const user = { id: crypto.randomUUID(), email: "solo@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "solo_01" };
  const mp = makeQuickPlayClient(makeClient, user, { quickPlayWaitMs: 100, quickPlayPollMs: 20 });
  try {
    await mp.quickPlay();
    assert.ok(mp.state.room, "deve ter criado sala");
    assert.equal(mp.state.room.visibility, "public");
    assert.equal(mp.state.room.host_id, user.id);
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await mp.dispose();
    clearInterval(mp.heartbeatTimer);
    clearTimeout(mp.refreshTimer);
  }
});

test("JOGAR AGORA preenche as vagas com bots após o tempo de espera", async () => {
  const { makeClient } = makeSupabaseMock();
  const user = { id: crypto.randomUUID(), email: "bots@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "bots_01" };
  const mp = makeQuickPlayClient(makeClient, user, { quickPlayWaitMs: 150, quickPlayPollMs: 30 });
  try {
    await mp.quickPlay();
    assert.ok(mp.state.room);
    // só o próprio jogador na sala → grid de 6 → 5 bots
    assert.equal(mp.state.room.bot_count, 5);
    assert.match(mp.state.info, /bots/i);
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await mp.dispose();
    clearInterval(mp.heartbeatTimer);
    clearTimeout(mp.refreshTimer);
  }
});

test("cancelar a busca interrompe a partida rápida sem preencher bots", async () => {
  const { makeClient } = makeSupabaseMock();
  const user = { id: crypto.randomUUID(), email: "cancela@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "cancela_01" };
  const mp = makeQuickPlayClient(makeClient, user, { quickPlayWaitMs: 5000, quickPlayPollMs: 50 });
  try {
    const pending = mp.quickPlay();
    await new Promise((r) => setTimeout(r, 120)); // deixou entrar na sala e começar a esperar
    assert.equal(mp.quickPlayActive, true);
    assert.ok(mp.state.room, "já está na sala enquanto espera");
    mp.cancelQuickPlay();
    const result = await pending;
    assert.equal(result, false, "busca cancelada retorna false");
    assert.equal(mp.quickPlayActive, false);
    assert.equal(mp.state.room.bot_count, 0, "cancelado não preenche bots");
    assert.match(mp.state.info, /cancelada/i);
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await mp.dispose();
    clearInterval(mp.heartbeatTimer);
    clearTimeout(mp.refreshTimer);
  }
});

test("proteção contra duplicidade: segunda busca simultânea é ignorada e quem já está em sala não entra em outra", async () => {
  const { makeClient } = makeSupabaseMock();
  const user = { id: crypto.randomUUID(), email: "dup@example.com", email_confirmed_at: "2026-11-04T10:00:00Z", is_anonymous: false, username: "dup_01" };
  const mp = makeQuickPlayClient(makeClient, user, { quickPlayWaitMs: 5000, quickPlayPollMs: 50 });
  try {
    const first = mp.quickPlay();
    await new Promise((r) => setTimeout(r, 100));
    const second = await mp.quickPlay();
    assert.equal(second, false, "busca simultânea deve ser recusada");
    const roomIdWhileWaiting = mp.activeRoomId;
    assert.ok(roomIdWhileWaiting);
    mp.cancelQuickPlay();
    await first;
    // já está em sala: quickPlay apenas atualiza o estado, não cria outra sala
    const again = await mp.quickPlay();
    assert.equal(again, true);
    assert.equal(mp.activeRoomId, roomIdWhileWaiting, "não entrou em outra sala");
  } finally {
    await new Promise((r) => setTimeout(r, 30));
    await mp.dispose();
    clearInterval(mp.heartbeatTimer);
    clearTimeout(mp.refreshTimer);
  }
});

test("anonymous sign-ins disabled falls back to the e-mail login panel", async () => {
  // GoTrue rejects signInAnonymously() with HTTP 403 when the project has
  // Anonymous Sign-Ins turned off. The gate must reach the login form instead
  // of dead-ending on a generic sync-error retry screen.
  const disabledError = Object.assign(new Error("Anonymous sign-ins are disabled"), {
    status: 403,
  });
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInAnonymously: async () => ({ data: null, error: disabledError }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    rpc: async () => {
      throw new Error("must not call RPCs without a session");
    },
    from: () => {
      throw new Error("must not query tables without a session");
    },
  };
  const game = {
    ui: { page: "account", render() {}, toast() {}, modal: null },
    authStatus: "checking",
    save: defaults(),
    multiplayer: null,
    world: { setMode() {}, setPreview() {}, raceContext: null },
    applyCloudSave() {},
  };
  const mp = new MultiplayerClient(game, { client, configured: true });
  game.multiplayer = mp;

  const booted = await mp.initializeAccount();
  assert.equal(booted, false, "no session yet, so the game stays gated");
  assert.equal(mp.state.anonymousUnavailable, true, "flag records the project state");
  assert.equal(mp.state.authView, "login", "lands on the e-mail login view");
  assert.equal(mp.state.connection, "offline", "not a broken connection");
  assert.equal(mp.state.error, "", "no scary error banner");
  assert.match(mp.state.info, /e-mail/i);
  assert.equal(game.authStatus, "login-required", "auth panel is reachable");

  // A different auth failure must still surface as a real error, not silently
  // downgrade to the login panel.
  const networkClient = {
    ...client,
    auth: {
      ...client.auth,
      signInAnonymously: async () => ({
        data: null,
        error: Object.assign(new Error("Failed to fetch"), { status: 0 }),
      }),
    },
  };
  const game2 = { ...game, authStatus: "checking", multiplayer: null };
  const mp2 = new MultiplayerClient(game2, { client: networkClient, configured: true });
  game2.multiplayer = mp2;
  await mp2.initializeAccount();
  assert.equal(mp2.state.anonymousUnavailable, false);
  assert.equal(game2.authStatus, "sync-error", "real failures keep the retry path");
  assert.ok(mp2.state.error, "the failure is visible");
});

test("auth panel hides the identity card when anonymous sign-ins are off", async () => {
  const { register } = await import("node:module");
  register("./css-hooks.mjs", import.meta.url);
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="app"><div id="world"></div><div id="ui"></div><div id="toast"></div></div></body></html>`,
    { url: "http://localhost:5173/", pretendToBeVisual: true },
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;

  const { UI } = await import("../src/ui.js");
  const state = {
    configured: true,
    authView: "identity",
    anonymousUnavailable: true,
    busy: false,
    error: "",
    info: "",
    profile: null,
    room: null,
    players: [],
    publicRooms: [],
    results: [],
    connection: "offline",
    cloudSaveStatus: "idle",
  };
  const game = {
    authStatus: "login-required",
    save: defaults(),
    multiplayer: { state },
    world: { container: dom.window.document.getElementById("world"), resize() {} },
  };
  const ui = new UI(game);
  const html = ui.authPanel();
  assert.ok(html.includes("auth-login-form"), "login form is rendered");
  assert.ok(!html.includes("identity-form"), "identity card is not offered");
  assert.ok(!html.includes('data-view="identity"'), "no dead-end link to identity");
  assert.match(html, /Anonymous Sign-Ins/i, "explains why");
});
