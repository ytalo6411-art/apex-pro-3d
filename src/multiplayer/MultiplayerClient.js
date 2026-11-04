import { trackCatalog } from "../data/tracks.js";
import { save as persist } from "../save.js";
import { resolveAccountSave, validateCloudSave } from "./CloudSave.js";
import { MAX_GRID_CARS, validateRoomSettings } from "../racing/RaceConfig.js";
import { BASE } from "../physics.js";
import { requestPit } from "../strategy/PitStop.js";
import {
  applyInterpolatedState,
  applyRaceTelemetry,
  INPUT_INTERVAL_MS,
  INTERPOLATION_DELAY_MS,
  isValidRaceSnapshot,
  makeRaceSnapshot,
  MAX_PACKET_BYTES,
  measurePacketBytes,
  SNAPSHOT_INTERVAL_MS,
  validateRaceInput,
} from "./NetworkProtocol.js";
import {
  cleanupAuthRedirectUrl,
  createSupabaseClient,
  isPlaceholderUsername,
  isValidSessionUser,
  setRememberSession,
  supabaseConfigured,
} from "./supabase.js";

const ROOM_KEY = "apex-dynasty:last-room:v1";
const VALID_EVENTS = new Set([
  "start", "lap", "last-lap", "finish", "personal-best", "pit", "penalty",
  "penalty-served", "flag", "weather", "safety-car", "race-control", "contact",
  "incident", "overtake", "mechanical",
]);
const escapeChannelEvent = (value) => String(value || "").slice(0, 40);

export class MultiplayerClient {
  constructor(game, options = {}) {
    this.game = game;
    const injectedClient = Object.hasOwn(options, "client");
    this.client = options.client ?? null;
    this.clientFactory = injectedClient ? null : createSupabaseClient;
    this.clientPromise = null;
    this.clientSessionOnly = null;
    this.configured = options.configured ?? (injectedClient ? !!this.client : supabaseConfigured);
    this.state = {
      configured: this.configured,
      authView: "identity",
      pendingEmail: "",
      emailUnconfirmed: false,
      profile: null,
      room: null,
      players: [],
      publicRooms: [],
      results: [],
      connection: "offline",
      busy: false,
      error: "",
      info: "",
      cloudSaveStatus: "checking",
      // True when the project rejects anonymous sign-ins (dashboard toggle off).
      // The gate then starts on the e-mail login instead of the identity card.
      anonymousUnavailable: false,
      roomLoading: false,
      trackReady: false,
      onlineRace: false,
      quickPlayPhase: "",
      quickPlayElapsed: 0,
    };
    this.roomChannel = null;
    this.publicChannel = null;
    this.activeRoomId = null;
    this.roomCode = null;
    this.refreshTimer = 0;
    this.heartbeatTimer = 0;
    // Quick-play ("JOGAR AGORA") controls. Timings are injectable for tests.
    this.quickPlayActive = false;
    this.quickPlayTimer = 0;
    this.quickPlayResolve = null;
    this.quickPlayWaitMs = options.quickPlayWaitMs ?? 30000;
    this.quickPlayPollMs = options.quickPlayPollMs ?? 2000;
    this.heartbeatCount = 0;
    this.lastInputSentAt = -Infinity;
    this.lastSnapshotSentAt = -Infinity;
    this.lastSnapshotSequence = -1;
    this.snapshotSequence = 0;
    this.lastInputSequence = 0;
    this.lastCommandSequence = 0;
    this.lastCommandAt = new Map();
    this.lastEventIdSent = 0;
    this.lastLocalRaceId = null;
    this.lastSubmittedRaceId = null;
    this.inputSequences = new Map();
    this.snapshotBuffers = new Map();
    this.presenceIds = new Set();
    this.serverOffsetMs = 0;
    this.closedReason = "";
    this.trackReadyId = null;
    this.preparingTrackId = null;
    this.trackPreparation = null;
    this.accountInitialization = null;
    this.authSubscription = null;
    this.cloudSaveRevision = 0;
    this.cloudSaveTimer = 0;
    this.pendingCloudSave = null;
    this.cloudSaveInFlight = null;
    this.cloudSaveDelay = 650;
  }

  get playerId() {
    return this.state.profile?.id || null;
  }

  get isSignedIn() {
    return !!this.state.profile;
  }

  get isHost() {
    return !!this.playerId && this.state.room?.host_id === this.playerId;
  }

  get trackOptions() {
    return trackCatalog.map(({ id, name }) => ({ id, name }));
  }

  emit(patch = {}) {
    Object.assign(this.state, patch);
    if (["account", "multiplayer"].includes(this.game.ui?.page))
      this.game.ui.render();
  }

  async ensureClient() {
    if (!this.configured) return null;
    if (this.client) return this.client;
    if (!this.clientFactory)
      throw new Error("O cliente Supabase não está disponível neste navegador.");
    if (!this.clientPromise)
      this.clientPromise = this.clientFactory(
        this.clientSessionOnly === null
          ? {}
          : { sessionOnly: this.clientSessionOnly },
      );
    this.client = await this.clientPromise;
    if (!this.client) {
      this.configured = false;
      this.emit({ configured: false, connection: "unconfigured" });
      throw new Error("As variáveis públicas do Supabase não estão configuradas.");
    }
    return this.client;
  }

  async initializeAccount() {
    if (this.accountInitialization) return this.accountInitialization;
    this.game.authStatus = "checking";
    this.emit({
      busy: true,
      error: "",
      info: "Verificando sua conta…",
      cloudSaveStatus: "checking",
    });

    const initialization = (async () => {
      try {
        if (!this.configured) {
          this.game.authStatus = "unconfigured";
          this.emit({
            busy: false,
            connection: "unconfigured",
            cloudSaveStatus: "idle",
            info: "Configure o Supabase para acessar o jogo.",
          });
          return false;
        }

        const client = await this.ensureClient();
        this.subscribeAuthChanges(client);
        const profile = await this.loadExistingProfile();
        if (!profile) {
          if (!["offline", "email-unconfirmed"].includes(this.state.connection))
            throw new Error("profile_missing");
          this.game.authStatus = "login-required";
          this.emit({ busy: false, cloudSaveStatus: "idle", error: "" });
          return false;
        }
        // Anonymous identity without a pilot name yet: stay on the identity
        // screen; the career save loads right after the name is claimed.
        if (
          profile.username_claimed === false ||
          isPlaceholderUsername(profile.username)
        ) {
          this.game.authStatus = "identity";
          this.emit({
            busy: false,
            cloudSaveStatus: "idle",
            error: "",
            authView: "identity",
            info: "Escolha seu nome de piloto para entrar no jogo.",
          });
          return false;
        }

        this.emit({
          busy: true,
          error: "",
          info: "Carregando sua carreira da nuvem…",
          cloudSaveStatus: "checking",
        });
        const record = await this.readCloudSave();
        let resolved = resolveAccountSave(record, this.game.save);
        if (resolved.source === "local") {
          try {
            this.cloudSaveRevision = await this.writeCloudSave(
              resolved.save,
              resolved.revision,
            );
          } catch (error) {
            if (!isSaveRevisionConflict(error)) throw error;
            const winner = await this.readCloudSave();
            resolved = resolveAccountSave(winner, this.game.save);
            if (resolved.source !== "cloud") throw error;
            this.cloudSaveRevision = resolved.revision;
            this.game.applyCloudSave(resolved.save);
            persist(resolved.save);
          }
          if (resolved.source === "local") {
            this.game.save = resolved.save;
            persist(resolved.save);
          }
        } else {
          // A save already attached to this account always wins over this
          // browser's local copy, including when their contents differ.
          this.cloudSaveRevision = resolved.revision;
          this.game.applyCloudSave(resolved.save);
          persist(resolved.save);
        }

        this.game.authStatus = "ready";
        this.game.ui.page = "home";
        this.game.ui.modal = null;
        this.emit({
          busy: false,
          error: "",
          connection: "online",
          cloudSaveStatus: "synced",
          info:
            resolved.source === "local"
              ? "Save deste dispositivo enviado para a sua conta."
              : "Carreira carregada da sua conta.",
        });
        this.game.ui.render();
        return true;
      } catch (error) {
        this.game.authStatus = this.configured ? "sync-error" : "unconfigured";
        this.emit({
          busy: false,
          error: friendlyError(error),
          info: "",
          cloudSaveStatus: "error",
          connection: this.configured ? "offline" : "unconfigured",
        });
        return false;
      } finally {
        // Always remove any auth tokens/code left in the address bar, even if
        // the account/profile load failed. Supabase already read the session by
        // the time we reach here, so this only cleans the visible URL.
        cleanupAuthRedirectUrl();
      }
    })();

    this.accountInitialization = initialization;
    try {
      return await initialization;
    } finally {
      if (this.accountInitialization === initialization)
        this.accountInitialization = null;
    }
  }

  subscribeAuthChanges(client) {
    if (this.authSubscription || !client?.auth?.onAuthStateChange) return;
    const result = client.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      this.handleSignedOut();
    });
    this.authSubscription = result?.data?.subscription || null;
  }

  handleSignedOut() {
      this.cancelQuickPlay();
      clearTimeout(this.cloudSaveTimer);
      this.cloudSaveTimer = 0;
      this.pendingCloudSave = null;
      this.cloudSaveRevision = 0;
      void this.detachRoom();
      if (this.publicChannel) {
        const channel = this.publicChannel;
        this.publicChannel = null;
        void this.client?.removeChannel(channel).catch(() => {});
      }
      this.removeLastRoom();
      this.roomCode = null;
      this.game.controls?.clear();
      this.game.world.raceContext = null;
      this.game.world.setMode("showcase");
      this.game.world.setPreview(this.game.save.selectedCar);
      this.state.profile = null;
      this.state.room = null;
      this.state.players = [];
      this.state.results = [];
      this.state.publicRooms = [];
      this.game.race = null;
      this.game.onlineRaceContext = null;
      this.game.authStatus = "login-required";
      if (this.game.ui) {
        this.game.ui.modal = null;
        this.game.ui.page = "account";
        this.game.ui.render();
      }
      this.emit({
        busy: false,
        error: "",
        info: "Você saiu da sua conta. Entre novamente para continuar.",
        cloudSaveStatus: "idle",
        connection: "offline",
        authView: "identity",
      });
  }

  async readCloudSave() {
    const { data, error } = await this.client.rpc("load_player_save");
    if (error) throw error;
    return data ?? null;
  }

  async writeCloudSave(saveData, expectedRevision) {
    const save = validateCloudSave(saveData);
    const { data, error } = await this.client.rpc("save_player_save", {
      p_save: save,
      p_expected_revision: expectedRevision,
    });
    if (error) throw error;
    const revision = Number(data?.revision);
    if (!Number.isSafeInteger(revision) || revision <= expectedRevision)
      throw new Error("cloud_save_revision_invalid");
    return revision;
  }

  queueCloudSave(saveData) {
    if (
      this.game.authStatus !== "ready" ||
      !this.isSignedIn ||
      !this.client
    )
      return;
    try {
      this.pendingCloudSave = validateCloudSave(saveData);
    } catch (error) {
      this.state.cloudSaveStatus = "error";
      const message = friendlyError(error);
      this.state.error = message;
      this.state.info = "";
      this.game.ui?.toast?.(message);
      return;
    }
    this.state.cloudSaveStatus = "pending";
    this.state.error = "";
    clearTimeout(this.cloudSaveTimer);
    this.cloudSaveTimer = setTimeout(
      () => void this.flushCloudSave(),
      this.cloudSaveDelay,
    );
  }

  async flushCloudSave() {
    clearTimeout(this.cloudSaveTimer);
    this.cloudSaveTimer = 0;
    if (this.cloudSaveInFlight) return this.cloudSaveInFlight;
    if (!this.pendingCloudSave || !this.isSignedIn) return false;

    const snapshot = this.pendingCloudSave;
    this.pendingCloudSave = null;
    const expectedRevision = this.cloudSaveRevision;
    const operation = (async () => {
      try {
        this.cloudSaveRevision = await this.writeCloudSave(
          snapshot,
          expectedRevision,
        );
        this.state.cloudSaveStatus = "synced";
        this.state.error = "";
        this.state.info = "Carreira sincronizada com sua conta.";
        return true;
      } catch (error) {
        if (isSaveRevisionConflict(error)) {
          try {
            const latest = resolveAccountSave(
              await this.readCloudSave(),
              this.game.save,
            );
            if (latest.source !== "cloud") throw error;
            this.cloudSaveRevision = latest.revision;
            this.game.applyCloudSave(latest.save);
            persist(latest.save);
            this.pendingCloudSave = null;
            this.state.cloudSaveStatus = "synced";
            this.state.error = "";
            this.state.info = "Uma versão mais recente da nuvem foi carregada.";
            this.game.ui?.toast?.("Save da nuvem carregado; ele prevalece nesta conta.");
            return true;
          } catch (reloadError) {
            error = reloadError;
          }
        }
        if (!this.pendingCloudSave) this.pendingCloudSave = snapshot;
        const message = friendlyError(error);
        this.state.cloudSaveStatus = "error";
        this.state.error = message;
        this.state.info = "";
        this.game.ui?.toast?.(`Falha ao sincronizar a carreira: ${message}`);
        return false;
      } finally {
        this.cloudSaveInFlight = null;
        if (this.pendingCloudSave && this.pendingCloudSave !== snapshot) {
          clearTimeout(this.cloudSaveTimer);
          this.cloudSaveTimer = setTimeout(
            () => void this.flushCloudSave(),
            this.cloudSaveDelay,
          );
        }
      }
    })();
    this.cloudSaveInFlight = operation;
    return operation;
  }

  async retryCloudSave() {
    if (!this.isSignedIn || !this.client) return false;
    try {
      if (!this.pendingCloudSave)
        this.pendingCloudSave = validateCloudSave(this.game.save);
      this.state.cloudSaveStatus = "pending";
      this.state.error = "";
      return await this.flushCloudSave();
    } catch (error) {
      const message = friendlyError(error);
      this.state.cloudSaveStatus = "error";
      this.state.error = message;
      this.game.ui?.toast?.(message);
      return false;
    }
  }

  async openMenu() {
    if (!this.configured) {
      this.emit({ connection: "unconfigured" });
      return;
    }
    try {
      await this.ensureClient();
      await this.loadExistingProfile();
      if (this.isSignedIn) {
        await this.resumeLastRoom();
        await this.subscribePublicRooms();
        await this.refreshPublicRooms();
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  reportError(error) {
    const message = friendlyError(error);
    this.emit({ busy: false, error: message, info: "" });
    this.game.ui?.toast?.(message);
  }

  async loadExistingProfile() {
    if (!this.configured || this.state.profile) return this.state.profile;
    await this.ensureClient();
    let { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    let user = data?.session?.user;
    if (!isValidSessionUser(user)) {
      // First visit (or cleared storage): create an anonymous player identity.
      // The session is persisted by Supabase, so the pilot never has to pick
      // a name again on this device. When the project has Anonymous Sign-Ins
      // turned off this call is rejected — that is a configuration state, not a
      // broken connection, so fall back to the e-mail account panel instead of
      // dead-ending the player on a generic retry screen.
      const anon = await this.client.auth.signInAnonymously().catch((thrown) => ({
        data: null,
        error: thrown instanceof Error ? thrown : new Error(String(thrown)),
      }));
      if (anon.error) {
        if (!isAnonymousSignInDisabled(anon.error)) throw anon.error;
        this.emit({
          profile: null,
          emailUnconfirmed: false,
          anonymousUnavailable: true,
          connection: "offline",
          authView: "login",
          error: "",
          info:
            "A identidade anônima está desativada neste projeto. Entre com uma conta de e-mail para jogar.",
        });
        return null;
      }
      user = anon.data?.user;
      if (!isValidSessionUser(user)) {
        ({ data, error } = await this.client.auth.getSession());
        if (error) throw error;
        user = data?.session?.user;
      }
    }
    if (!isValidSessionUser(user)) {
      this.emit({
        profile: null,
        emailUnconfirmed: false,
        connection: "offline",
        authView: "identity",
        info: "Não foi possível criar sua identidade de piloto. Verifique a conexão.",
      });
      return null;
    }
    const { data: profile, error: profileError } = await this.client
      .from("profiles")
      .select("id,username,username_claimed,display_name,avatar_url,created_at,updated_at")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) {
      this.emit({
        profile: null,
        connection: "online",
        error: "",
        info: "O perfil não foi criado no Supabase. Verifique o trigger de criação de perfil.",
      });
      return null;
    }
    this.state.profile = { ...profile };
    // A profile with the auto placeholder username still needs a pilot name.
    const needsName =
      profile.username_claimed === false || isPlaceholderUsername(profile.username);
    this.emit({
      profile: this.state.profile,
      emailUnconfirmed: false,
      anonymousUnavailable: false,
      connection: "online",
      error: "",
      authView: needsName ? "identity" : this.state.authView,
      info: needsName
        ? "Escolha seu nome de piloto para entrar no jogo."
        : "Sessão restaurada. Bem-vindo de volta.",
    });
    return this.state.profile;
  }

  async updateDisplayName(value) {
    if (!this.isSignedIn) throw new Error("Entre na sua conta para usar o multiplayer.");
    await this.ensureClient();
    const name = cleanDisplayName(value);
    const { data, error } = await this.client.rpc("set_display_name", {
      p_display_name: name,
    });
    if (error) throw error;
    this.state.profile = { ...this.state.profile, ...(data || {}), display_name: name };
    this.emit({ profile: this.state.profile, error: "", info: "Nome atualizado." });
  }

  switchAuthView(view) {
    const allowed = ["identity", "login", "register", "confirm", "forgot", "reset-sent"];
    if (!allowed.includes(view)) return;
    this.emit({ authView: view, error: "", info: "" });
  }

  randomPilotName() {
    const adjectives = ["veloz", "turbo", "nitro", "apex", "drift", "storm", "lunar", "carmesim", "sonic", "phantom"];
    const nouns = ["racer", "falcon", "viper", "bolt", "shadow", "nova", "rex", "jet", "blaze", "hawk"];
    const a = adjectives[Math.floor(Math.random() * adjectives.length)];
    const n = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 90 + 10);
    return `${a}_${n}${num}`.slice(0, 20).toLowerCase().replace(/[^a-z0-9_]/g, "");
  }

  async claimUsername(rawName) {
    const name = cleanUsername(rawName);
    this.emit({ busy: true, error: "", info: "Salvando seu nome de piloto…" });
    await this.ensureClient();
    const { data: available, error: availabilityError } = await this.client.rpc(
      "username_available",
      { p_username: name },
    );
    if (availabilityError) throw availabilityError;
    if (available === false) throw new Error("username_taken");
    const { data, error } = await this.client.rpc("set_username", {
      p_username: name,
    });
    if (error) throw error;
    if (data?.username) {
      this.state.profile = {
        ...this.state.profile,
        ...data,
        username: data.username,
        username_claimed: true,
        display_name: this.state.profile?.display_name || data.username,
      };
    }
    this.emit({ profile: this.state.profile, busy: false, error: "", info: "Nome salvo!" });
    // With the name claimed, run the full account boot (loads the career save).
    await this.initializeAccount();
    return true;
  }

  async signUp({ username, email, password, confirmPassword }) {
    const name = cleanUsername(username);
    const mail = cleanEmail(email);
    if (String(password || "").length < 8)
      throw new Error("A senha deve ter pelo menos 8 caracteres.");
    if (password !== confirmPassword) throw new Error("password_mismatch");
    this.emit({ busy: true, error: "", info: "Criando sua conta…" });
    await this.ensureClient();
    const { data: available, error: availabilityError } = await this.client.rpc(
      "username_available",
      { p_username: name },
    );
    if (availabilityError) throw availabilityError;
    if (available === false) throw new Error("username_taken");
    const { data, error } = await this.client.auth.signUp({
      email: mail,
      password,
      options: { data: { username: name, display_name: name } },
    });
    if (error) throw error;
    // When e-mail confirmation is disabled the session is returned right away.
    if (data?.session) {
      await this.initializeAccount();
      return true;
    }
    this.emit({
      busy: false,
      error: "",
      authView: "confirm",
      pendingEmail: mail,
      emailUnconfirmed: true,
      info: "Conta criada! Enviamos um e-mail de confirmação.",
    });
    return true;
  }

  async signInWithCredentials({ identifier, password, keepSignedIn }) {
    setRememberSession(keepSignedIn !== false);
    // Recreate the SDK client if the persistence choice changed, so the
    // session lands in localStorage (keep connected) or sessionStorage.
    const sessionOnly = keepSignedIn === false;
    if (this.client && this.clientSessionOnly !== null && this.clientSessionOnly !== sessionOnly) {
      try {
        await this.client.auth.signOut();
      } catch {}
      this.client = null;
      this.clientPromise = null;
    }
    this.clientSessionOnly = sessionOnly;
    const id = String(identifier || "").trim();
    if (!id) throw new Error("Informe seu nome de usuário ou e-mail.");
    if (!password) throw new Error("Informe sua senha.");
    await this.ensureClient();
    let email = id.includes("@") ? id.toLowerCase() : null;
    if (!email) {
      const username = cleanUsername(id);
      const { data, error } = await this.client.rpc("email_for_username", {
        p_username: username,
      });
      if (error) throw error;
      if (!data) throw new Error("account_not_found");
      email = String(data);
    }
    this.emit({ busy: true, error: "", info: "Entrando…" });
    const { error: signInError } = await this.client.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) throw signInError;
    await this.initializeAccount();
    return this.game.authStatus === "ready";
  }

  async signOut() {
    if (this.client) {
      try {
        await this.client.auth.signOut();
      } catch {}
    }
    this.handleSignedOut();
    return true;
  }

  async sendPasswordReset(email) {
    const mail = cleanEmail(email);
    await this.ensureClient();
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { error } = await this.client.auth.resetPasswordForEmail(mail, {
      redirectTo,
    });
    if (error) throw error;
    this.emit({
      busy: false,
      error: "",
      authView: "reset-sent",
      pendingEmail: mail,
      info: "E-mail de recuperação enviado.",
    });
    return true;
  }

  async resendConfirmation(email) {
    const mail = cleanEmail(email || this.state.pendingEmail);
    await this.ensureClient();
    const { error } = await this.client.auth.resend({ type: "signup", email: mail });
    if (error) throw error;
    this.emit({
      busy: false,
      error: "",
      authView: "confirm",
      pendingEmail: mail,
      info: "E-mail de confirmação reenviado. Verifique sua caixa de entrada.",
    });
    return true;
  }

  async createRoom(rawSettings) {
    const settings = validateRoomSettings(rawSettings);
    if (!this.isSignedIn) throw new Error("Entre na sua conta para criar uma sala.");
    this.emit({ busy: true, error: "", info: "Criando sala…" });
    const { data, error } = await this.client.rpc("create_room", {
      p_name: settings.name,
      p_visibility: settings.visibility,
      p_track_id: settings.trackId,
      p_lap_count: settings.lapCount,
      p_max_players: settings.maxPlayers,
      p_bot_count: settings.botCount,
    });
    if (error) {
      this.emit({ busy: false, error: friendlyError(error), info: "" });
      throw error;
    }
    const id = data?.id || data?.room_id;
    if (!id) throw new Error("O Supabase criou a sala sem retornar o identificador.");
    this.writeLastRoom(id);
    await this.joinRoomById(id);
    this.emit({ busy: false, error: "", info: "Sala criada." });
  }

  async joinRoomByCode(rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code))
      throw new Error("Informe o código de convite de 8 caracteres.");
    return this.joinRoom({ code });
  }

  async joinRoomById(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id)))
      throw new Error("Identificador de sala inválido.");
    return this.joinRoom({ id });
  }

  async joinRoom({ id = null, code = null } = {}) {
    if (!this.isSignedIn) throw new Error("Entre na sua conta antes de entrar em uma sala.");
    this.emit({ busy: true, error: "", info: "Entrando na sala…" });
    const { data, error } = await this.client.rpc("join_room", {
      p_room_id: id,
      p_code: code,
    });
    if (error) {
      this.emit({ busy: false, error: friendlyError(error), info: "" });
      throw error;
    }
    const roomId = data?.id || data?.room_id || id;
    if (!roomId) throw new Error("A sala não retornou um identificador válido.");
    this.writeLastRoom(roomId);
    await this.attachRoom(roomId, data?.code);
    await this.refreshRoomState();
    this.emit({ busy: false, error: "", info: "Conectado à sala." });
  }

  async resumeLastRoom() {
    if (!this.isSignedIn || this.activeRoomId) return;
    const id = this.readLastRoom();
    if (!id) return;
    try {
      await this.joinRoomById(id);
    } catch (error) {
      this.removeLastRoom();
      this.emit({ room: null, players: [], results: [], roomLoading: false });
      if (!isRoomUnavailable(error)) this.emit({ error: friendlyError(error) });
    }
  }

  async attachRoom(roomId, roomCode = null) {
    if (!this.configured || !this.isSignedIn) return;
    await this.detachRoom();
    this.activeRoomId = roomId;
    this.roomCode = /^[A-Z0-9]{8}$/.test(String(roomCode || ""))
      ? String(roomCode)
      : null;
    this.state.connection = "reconnecting";
    this.state.roomLoading = true;
    this.snapshotBuffers.clear();
    this.snapshotSequence = 0;
    this.lastSnapshotSequence = -1;
    this.lastInputSequence = 0;
    this.lastCommandSequence = 0;
    this.lastCommandAt.clear();
    this.snapshotSequence = 0;
    this.lastEventIdSent = 0;
    this.lastSubmittedRaceId = null;
    this.inputSequences.clear();
    const topic = `room:${roomId}`;
    this.roomChannel = this.client.channel(topic, {
      config: {
        private: true,
        broadcast: { self: false, ack: false },
        presence: { key: this.playerId },
      },
    });
    this.roomChannel
      .on("broadcast", { event: "race-input" }, ({ payload }) => this.receiveInput(payload))
      .on("broadcast", { event: "race-command" }, ({ payload }) => this.receiveCommand(payload))
      .on("broadcast", { event: "race-snapshot" }, ({ payload }) => this.receiveSnapshot(payload))
      .on("presence", { event: "sync" }, () => this.refreshPresence())
      .on("presence", { event: "join" }, () => this.refreshPresence())
      .on("presence", { event: "leave" }, () => this.refreshPresence())
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
        () => this.scheduleRoomRefresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_players", filter: `room_id=eq.${roomId}` },
        () => this.scheduleRoomRefresh(),
      );
    this.roomChannel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        this.state.connection = "online";
        try {
          await this.roomChannel?.track({ player_id: this.playerId });
          await this.client.rpc("set_room_connection", {
            p_room_id: roomId,
            p_status: "online",
          });
          await this.refreshRoomState();
          this.startHeartbeat();
        } catch (error) {
          this.emit({ error: friendlyError(error), connection: "reconnecting" });
        }
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        this.state.connection = "reconnecting";
        this.emit({ info: status === "TIMED_OUT" ? "Reconectando à sala…" : "Conexão interrompida; tentando reconectar…" });
      }
    });
  }

  async detachRoom() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.refreshTimer);
    this.heartbeatTimer = 0;
    this.refreshTimer = 0;
    const channel = this.roomChannel;
    this.roomChannel = null;
    this.activeRoomId = null;
    this.presenceIds.clear();
    if (channel) {
      try {
        await this.client.removeChannel(channel);
      } catch {}
    }
  }

  async leaveRoom() {
    const roomId = this.activeRoomId || this.state.room?.id;
    if (!roomId) return;
    this.emit({ busy: true, error: "", info: "Saindo da sala…" });
    try {
      await this.client.rpc("leave_room", { p_room_id: roomId });
    } catch (error) {
      // The room may already have expired or been closed. Local cleanup still
      // must not leave this browser trapped on a racing HUD.
      if (!isRoomUnavailable(error)) {
        this.emit({ busy: false, error: friendlyError(error), info: "" });
        throw error;
      }
    }
    this.cancelQuickPlay();
    await this.detachRoom();
    this.roomCode = null;
    this.removeLastRoom();
    this.clearOnlineRace();
    this.emit({
      busy: false,
      room: null,
      players: [],
      results: [],
      connection: "online",
      onlineRace: false,
      error: "",
      info: "Você saiu da sala. A sessão dos outros jogadores continua.",
    });
  }

  async prepareRoomTrack(trackId) {
    const id = String(trackId || "");
    if (this.trackReadyId === id && this.game.world?.assetsReady) {
      this.emit({ trackReady: true });
      return true;
    }
    if (this.preparingTrackId === id && this.trackPreparation)
      return this.trackPreparation;
    this.preparingTrackId = id;
    this.emit({ trackReady: false, info: "Preparando o circuito da sala…" });
    const preparation = (async () => {
      this.game.switchTrack(id);
      const world = this.game.world;
      await world.ready;
      if (this.game.world !== world)
        throw new Error("A pista da sala mudou durante o carregamento.");
      if (!world.assetsReady)
        throw new Error("Não foi possível concluir a preparação do circuito.");
      this.trackReadyId = id;
      this.emit({ trackReady: true, info: "Circuito preparado. Confirme presença para correr." });
      return true;
    })();
    this.trackPreparation = preparation;
    try {
      return await preparation;
    } catch (error) {
      this.emit({ trackReady: false, error: friendlyError(error), info: "" });
      return false;
    } finally {
      if (this.trackPreparation === preparation) {
        this.trackPreparation = null;
        this.preparingTrackId = null;
      }
    }
  }

  async setReady(ready) {
    const room = this.state.room;
    const roomId = room?.id;
    if (!roomId) throw new Error("Entre em uma sala antes de confirmar presença.");
    if (ready && !(await this.prepareRoomTrack(room.track_id)))
      throw new Error("Aguarde o circuito terminar de carregar antes de confirmar.");
    const { error } = await this.client.rpc("set_room_ready", {
      p_room_id: roomId,
      p_ready: !!ready,
    });
    if (error) throw error;
    await this.refreshRoomState();
  }

  async configureRoom(rawSettings) {
    if (!this.isHost) throw new Error("Somente o anfitrião pode alterar a configuração.");
    const settings = validateRoomSettings(rawSettings);
    const { error } = await this.client.rpc("configure_room", {
      p_room_id: this.state.room.id,
      p_name: settings.name,
      p_visibility: settings.visibility,
      p_track_id: settings.trackId,
      p_lap_count: settings.lapCount,
      p_max_players: settings.maxPlayers,
      p_bot_count: settings.botCount,
    });
    if (error) throw error;
    await this.refreshRoomState();
  }

  async startRoom() {
    if (!this.isHost) throw new Error("Somente o anfitrião pode iniciar a corrida.");
    const { error } = await this.client.rpc("start_room", {
      p_room_id: this.state.room.id,
    });
    if (error) throw error;
    await this.refreshRoomState();
  }

  async returnToLobby() {
    if (!this.state.room) return;
    const { error } = await this.client.rpc("return_room_to_lobby", {
      p_room_id: this.state.room.id,
    });
    if (error) throw error;
    await this.refreshRoomState();
  }

  async refreshPublicRooms() {
    if (!this.configured || !this.isSignedIn) {
      this.emit({ publicRooms: [] });
      return [];
    }
    const { data, error } = await this.client.rpc("list_public_rooms");
    if (error) {
      this.emit({ error: friendlyError(error) });
      return [];
    }
    const rooms = Array.isArray(data) ? data : [];
    this.emit({ publicRooms: rooms.filter((room) => room?.status === "waiting") });
    return this.state.publicRooms;
  }

  // "JOGAR AGORA": entra na sala pública com mais vagas; se não houver nenhuma,
  // cria uma pública. Depois aguarda outros jogadores até quickPlayWaitMs e,
  // se ninguém aparecer, o anfitrião preenche as vagas do grid com bots.
  async quickPlay() {
    if (!this.isSignedIn)
      throw new Error("Entre na sua conta para procurar uma partida.");
    // Proteção contra entradas duplicadas: uma busca por vez e, se já
    // estiver em uma sala, apenas atualiza o estado dela.
    if (this.quickPlayActive) return false;
    if (this.activeRoomId || this.state.room) {
      await this.refreshRoomState();
      return true;
    }
    this.quickPlayActive = true;
    const startedAt = Date.now();
    this.emit({
      busy: true,
      error: "",
      info: "Procurando partida rápida…",
      quickPlayPhase: "searching",
      quickPlayElapsed: 0,
    });
    try {
      await this.refreshPublicRooms();
      const candidates = this.state.publicRooms
        .filter(
          (room) =>
            room?.status === "waiting" &&
            (room.player_count ?? 0) < (room.max_players ?? MAX_GRID_CARS),
        )
        .sort(
          (a, b) =>
            b.max_players - b.player_count - (a.max_players - a.player_count),
        );
      let joined = false;
      for (const room of candidates) {
        try {
          await this.joinRoomById(room.id);
          joined = true;
          break;
        } catch (error) {
          if (!/room_full|unavailable|closed|not accepting|not found/i.test(String(error?.message || error)))
            throw error;
          // Sala encheu entre a listagem e o join: tenta a próxima.
        }
      }
      if (!joined) {
        this.emit({
          info: "Nenhuma sala pública com vaga — criando uma nova…",
          quickPlayPhase: "creating",
        });
        await this.createRoom({
          name: "Partida rápida",
          visibility: "public",
          trackId: this.game.save.settings.track,
          lapCount: this.game.save.settings.laps,
          maxPlayers: MAX_GRID_CARS,
          botCount: 0,
        });
      }

      // Aguarda outros jogadores até o limite configurado.
      this.emit({
        info: "Sala encontrada. Aguardando outros jogadores…",
        quickPlayPhase: "waiting",
      });
      const deadline = Date.now() + this.quickPlayWaitMs;
      while (this.quickPlayActive && Date.now() < deadline) {
        await this.refreshRoomState();
        this.emit({
          quickPlayElapsed: Math.floor((Date.now() - startedAt) / 1000),
        });
        const active = this.state.players.filter((p) => p.left_at === null).length;
        if (active >= 2) break; // outro jogador chegou
        await this.waitQuickPlay(this.quickPlayPollMs);
      }
      if (!this.quickPlayActive) return false; // busca cancelada

      // Ninguém apareceu: o anfitrião preenche o grid com bots.
      const room = this.state.room;
      if (room && this.isHost) {
        const active = this.state.players.filter((p) => p.left_at === null).length;
        const freeGrid = Math.max(0, MAX_GRID_CARS - active);
        if (freeGrid > 0 && (room.bot_count ?? 0) < freeGrid) {
          await this.configureRoom({
            name: room.name,
            visibility: room.visibility,
            trackId: room.track_id,
            lapCount: room.lap_count,
            maxPlayers: room.max_players,
            botCount: Math.min(freeGrid, 5),
          });
          this.emit({ info: "Sem novos jogadores — vagas preenchidas com bots." });
        }
      }
      return true;
    } catch (error) {
      this.emit({
        busy: false,
        error: friendlyError(error),
        info: "",
        quickPlayPhase: "",
        quickPlayElapsed: 0,
      });
      throw error;
    } finally {
      this.quickPlayActive = false;
      clearTimeout(this.quickPlayTimer);
      this.quickPlayTimer = 0;
      this.quickPlayResolve = null;
      if (!this.state.error)
        this.emit({ busy: false, quickPlayPhase: "", quickPlayElapsed: 0 });
    }
  }

  waitQuickPlay(ms) {
    return new Promise((resolve) => {
      this.quickPlayResolve = resolve;
      this.quickPlayTimer = setTimeout(() => {
        this.quickPlayResolve = null;
        resolve();
      }, ms);
    });
  }

  cancelQuickPlay() {
    if (!this.quickPlayActive) return;
    this.quickPlayActive = false;
    clearTimeout(this.quickPlayTimer);
    this.quickPlayTimer = 0;
    const resolve = this.quickPlayResolve;
    this.quickPlayResolve = null;
    resolve?.();
    this.emit({
      busy: false,
      info: "Busca por partida cancelada.",
      quickPlayPhase: "",
      quickPlayElapsed: 0,
    });
  }

  async subscribePublicRooms() {
    if (!this.configured || !this.isSignedIn || this.publicChannel) return;
    this.publicChannel = this.client
      .channel("apex-public-room-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rooms" },
        () => this.refreshPublicRooms(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_players" },
        () => this.refreshPublicRooms(),
      );
    this.publicChannel.subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
        this.state.info = "A lista continua disponível pelo botão Atualizar.";
    });
  }

  async refreshRoomState() {
    const roomId = this.activeRoomId || this.state.room?.id;
    if (!roomId || !this.configured || !this.isSignedIn) return null;
    const { data, error } = await this.client.rpc("get_room_state", {
      p_room_id: roomId,
    });
    if (error) {
      this.state.roomLoading = false;
      if (isRoomUnavailable(error)) {
        this.removeLastRoom();
        await this.detachRoom();
        this.clearOnlineRace();
        this.emit({ room: null, players: [], results: [], connection: "online", error: "A sala não está mais disponível." });
        return null;
      }
      this.emit({ error: friendlyError(error), roomLoading: false });
      return null;
    }
    if (!data?.room) {
      this.emit({ room: null, players: [], results: [], roomLoading: false });
      return null;
    }
    if (data.server_time) {
      const serverMs = Date.parse(data.server_time);
      if (Number.isFinite(serverMs))
        this.serverOffsetMs = this.serverOffsetMs * 0.65 + (serverMs - Date.now()) * 0.35;
    }
    const existingCode = this.state.room?.id === data.room.id
      ? this.state.room.code
      : null;
    const code = data.room.code || this.roomCode || existingCode || null;
    const room = { ...data.room, code };
    this.roomCode = code;
    const players = (Array.isArray(data.players) ? data.players : []).map((player) => {
      const present = this.presenceIds.has(player.player_id);
      return {
        ...player,
        connection_status: present
          ? "online"
          : player.connection_status === "offline"
            ? "offline"
            : "reconnecting",
      };
    });
    this.emit({
      room,
      players,
      results: Array.isArray(data.results) ? data.results : [],
      roomLoading: false,
      error: "",
    });
    this.onRoomStateChanged(room, players);
    return data;
  }

  scheduleRoomRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshRoomState(), 120);
  }

  refreshPresence() {
    if (!this.roomChannel) return;
    const state = this.roomChannel.presenceState();
    this.presenceIds = new Set(Object.keys(state || {}));
    const players = this.state.players.map((player) => ({
      ...player,
      connection_status: this.presenceIds.has(player.player_id)
        ? "online"
        : player.connection_status === "offline"
          ? "offline"
          : "reconnecting",
    }));
    this.emit({ players });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatCount = 0;
    this.heartbeatTimer = setInterval(async () => {
      if (!this.activeRoomId || !this.isSignedIn) return;
      const { data, error } = await this.client.rpc("room_heartbeat", {
        p_room_id: this.activeRoomId,
      });
      if (error) {
        this.state.connection = "reconnecting";
        this.emit({ connection: "reconnecting" });
        return;
      }
      this.state.connection = "online";
      if (data?.server_time) {
        const serverMs = Date.parse(data.server_time);
        if (Number.isFinite(serverMs))
          this.serverOffsetMs = this.serverOffsetMs * 0.65 + (serverMs - Date.now()) * 0.35;
      }
      this.heartbeatCount++;
      if (this.heartbeatCount % 2 === 0) await this.refreshRoomState();
    }, 15000);
  }

  onRoomStateChanged(room, players) {
    const wasOnlineRace = !!this.state.onlineRace;
    this.state.onlineRace = ["countdown", "racing"].includes(room.status);
    if (room.status === "countdown" || room.status === "racing") {
      const raceId = room.race_id;
      if (raceId && this.lastLocalRaceId !== raceId) {
        const context = this.makeRaceContext(room, players);
        if (context) {
          this.lastLocalRaceId = raceId;
          this.snapshotBuffers.clear();
          this.snapshotSequence = 0;
          this.lastSnapshotSequence = -1;
          this.lastEventIdSent = 0;
          this.game.startOnlineRace(context);
        }
      }
      this.retireDepartedDrivers(players);
      if (room.status === "racing" && this.game.race?.online) {
        this.game.race.network.roomStatus = "racing";
      }
    } else if (room.status === "results") {
      this.state.onlineRace = false;
      this.lastLocalRaceId = room.race_id;
      if (this.game.race?.online && this.game.race.online.raceId === room.race_id) {
        this.clearOnlineRace();
        this.lastLocalRaceId = room.race_id;
        this.game.ui.page = "multiplayer";
        this.game.ui.render();
      } else if (wasOnlineRace) {
        this.game.race = null;
        this.game.onlineRaceContext = null;
        this.game.ui.page = "multiplayer";
        this.game.ui.render();
      }
    } else if (room.status === "closed") {
      this.state.onlineRace = false;
      this.closedReason = room.closed_reason || "room_closed";
      if (this.game.race?.online) this.clearOnlineRace();
      if (this.game.ui.page === "race") {
        this.game.ui.page = "multiplayer";
        this.game.ui.render();
      }
      this.emit({ info: closedMessage(this.closedReason) });
    } else if (room.status === "waiting") {
      this.state.onlineRace = false;
      if (wasOnlineRace || this.game.race?.online) {
        this.clearOnlineRace();
        if (this.game.ui.page === "race") {
          this.game.ui.page = "multiplayer";
          this.game.ui.render();
        }
      }
      this.closedReason = "";
      void this.prepareRoomTrack(room.track_id);
    }
    if (this.game.race?.online && this.game.race.online.raceId === room.race_id) {
      this.game.race.network.roomStatus = room.status;
    }
  }

  makeRaceContext(room, players) {
    const active = players
      .filter((player) => !player.left_at)
      .sort(
        (a, b) =>
          Date.parse(a.joined_at || 0) - Date.parse(b.joined_at || 0) ||
          String(a.player_id).localeCompare(String(b.player_id)),
      );
    const local = active.find((player) => player.player_id === this.playerId);
    const host = active.find((player) => player.player_id === room.host_id);
    if (!local || !host || !room.race_id) return null;
    const ordered = [host, ...active.filter((player) => player.player_id !== host.player_id)];
    const botCount = Math.max(0, Math.min(Number(room.bot_count) || 0, MAX_GRID_CARS - ordered.length));
    const entities = ordered.map((player) => ({
      id: `player:${player.player_id}`,
      playerId: player.player_id,
      name: player.display_name,
      human: true,
    }));
    for (let i = 0; i < botCount; i++)
      entities.push({ id: `bot:${i}`, playerId: null, name: `Apex AI ${i + 1}`, human: false });
    const countdownAt = Date.parse(room.countdown_at || room.started_at || "");
    const serverNow = Date.now() + this.serverOffsetMs;
    return {
      room,
      raceId: room.race_id,
      localPlayerId: this.playerId,
      hostPlayerId: room.host_id,
      participants: ordered,
      entities,
      botCount,
      countdownSeconds: Number.isFinite(countdownAt)
        ? Math.max(0, Math.min(5, (countdownAt - serverNow) / 1000))
        : 0,
      reconnecting: room.status === "racing",
      weather: "dry",
    };
  }

  retireDepartedDrivers(players) {
    const race = this.game.race;
    if (!race?.online) return;
    const active = new Set(players.filter((p) => !p.left_at).map((p) => p.player_id));
    for (const car of race.cars) {
      const id = car.networkEntityId?.startsWith("player:")
        ? car.networkEntityId.slice("player:".length)
        : null;
      if (id && !active.has(id) && !car.finished && !car.retired) {
        car.retired = true;
        car.retirement = "Desconectado";
        car.speed = car.vx = car.vz = 0;
      }
    }
  }

  tickRace(now, input, race) {
    if (!race?.online || !this.roomChannel || this.activeRoomId !== race.online.roomId)
      return;
    const inputInterval = now - this.lastInputSentAt;
    if (inputInterval >= INPUT_INTERVAL_MS && this.state.room?.status === "racing") {
      this.lastInputSentAt = now;
      const payload = {
        raceId: race.online.raceId,
        playerId: this.playerId,
        seq: ++this.lastInputSequence,
        input: {
          throttle: clampUnit(input?.throttle),
          brake: clampUnit(input?.brake),
          steer: clampSteer(input?.steer),
        },
      };
      if (measurePacketBytes(payload) <= MAX_PACKET_BYTES)
        this.roomChannel.send({ type: "broadcast", event: "race-input", payload });
    }
    if (
      this.isHost &&
      this.state.room?.status === "countdown" &&
      Date.now() + this.serverOffsetMs >= Date.parse(this.state.room.countdown_at)
    )
      this.beginRaceWhenDue(this.state.room.id, race.online.raceId);
    if (this.isHost && this.state.room?.status === "racing") {
      if (now - this.lastSnapshotSentAt >= SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotSentAt = now;
        const snapshot = makeRaceSnapshot(race, race.online.raceId, ++this.snapshotSequence, this.lastEventIdSent);
        this.lastEventIdSent = Math.max(this.lastEventIdSent, ...race.events.map((event) => event.id), 0);
        if (measurePacketBytes(snapshot) <= MAX_PACKET_BYTES)
          this.roomChannel.send({ type: "broadcast", event: "race-snapshot", payload: snapshot });
      }
      if (race.done && this.lastSubmittedRaceId !== race.online.raceId)
        this.submitRaceResults(race);
    } else if (!this.isHost) {
      this.applyRemoteSnapshots(race, now);
    }
  }

  async beginRaceWhenDue(roomId, raceId) {
    if (this.beginRacePending) return;
    this.beginRacePending = true;
    try {
      const { error } = await this.client.rpc("begin_room_race", {
        p_room_id: roomId,
        p_race_id: raceId,
      });
      if (error && !/already|status|started/i.test(String(error.message)))
        this.emit({ error: friendlyError(error) });
      await this.refreshRoomState();
    } catch (error) {
      this.emit({ error: friendlyError(error) });
    } finally {
      this.beginRacePending = false;
    }
  }

  sendRaceCommand(command) {
    const race = this.game.race;
    if (
      command !== "pit" ||
      !race?.online ||
      !this.roomChannel ||
      race.network.authoritative ||
      this.state.room?.status !== "racing"
    ) {
      this.game.ui?.toast?.("O comando online não está disponível agora.");
      return false;
    }
    const payload = {
      raceId: race.online.raceId,
      playerId: this.playerId,
      seq: ++this.lastCommandSequence,
      command,
    };
    if (measurePacketBytes(payload) > MAX_PACKET_BYTES) return false;
    this.roomChannel.send({ type: "broadcast", event: "race-command", payload });
    this.game.ui?.toast?.("Comando de boxes enviado ao anfitrião.");
    return true;
  }

  receiveCommand(payload) {
    const race = this.game.race;
    if (!race?.online || !race.network.authoritative || !payload) return;
    const playerId = payload.playerId;
    if (
      payload.raceId !== race.online.raceId ||
      typeof playerId !== "string" ||
      playerId === this.playerId ||
      !race.online.participants.some((player) => player.player_id === playerId) ||
      !Number.isSafeInteger(payload.seq) ||
      payload.seq < 1 ||
      payload.command !== "pit"
    )
      return;
    const entityId = `player:${playerId}`;
    const previous = this.inputSequences.get(`command:${playerId}`) ?? 0;
    const lastAt = this.lastCommandAt.get(playerId) ?? -Infinity;
    if (payload.seq <= previous || performance.now() - lastAt < 1200) return;
    const car = race.cars.find((candidate) => candidate.networkEntityId === entityId);
    if (!car || car.finished || car.retired) return;
    this.inputSequences.set(`command:${playerId}`, payload.seq);
    this.lastCommandAt.set(playerId, performance.now());
    requestPit(car);
  }

  receiveInput(payload) {
    const race = this.game.race;
    if (!race?.online || !race.network.authoritative) return;
    const allowed = new Set(race.online.participants.map((player) => player.player_id));
    const message = validateRaceInput(payload, race.online.raceId, allowed);
    if (!message || message.playerId === this.playerId) return;
    const previous = this.inputSequences.get(message.playerId) ?? -1;
    if (message.seq <= previous) return;
    this.inputSequences.set(message.playerId, message.seq);
    race.network.remoteInputs.set(`player:${message.playerId}`, message.input);
    race.network.remoteInputAt.set(`player:${message.playerId}`, performance.now());
  }

  receiveSnapshot(payload) {
    const race = this.game.race;
    if (!race?.online || race.network.authoritative) return;
    if (race.online.hostPlayerId !== this.state.room?.host_id) return;
    if (!isValidRaceSnapshot(payload, race.online.raceId)) return;
    if (payload.seq <= this.lastSnapshotSequence || measurePacketBytes(payload) > MAX_PACKET_BYTES) return;
    this.lastSnapshotSequence = payload.seq;
    const receivedAt = performance.now();
    for (const remote of payload.cars) {
      if (!race.cars.some((car) => car.networkEntityId === remote.entityId)) continue;
      let buffer = this.snapshotBuffers.get(remote.entityId);
      if (!buffer) {
        buffer = [];
        this.snapshotBuffers.set(remote.entityId, buffer);
      }
      buffer.push({ receivedAt, state: remote });
      if (buffer.length > 3) buffer.splice(0, buffer.length - 3);
    }
    race.network.hostFlag = payload.flag;
    race.network.hostState = payload.state;
    race.network.hostTime = payload.time;
    race.network.hostCountdown = payload.countdown;
    this.applyEvents(race, payload.events || []);
  }

  applyRemoteSnapshots(race, now) {
    const targetAt = now - INTERPOLATION_DELAY_MS;
    const localId = `player:${this.playerId}`;
    for (const car of race.cars) {
      const buffer = this.snapshotBuffers.get(car.networkEntityId);
      if (!buffer?.length) continue;
      if (car.networkEntityId === localId && !race.online.reconnecting) continue;
      let previous = buffer[0], current = buffer.at(-1);
      if (buffer.length > 1) {
        for (let i = 1; i < buffer.length; i++) {
          if (buffer[i].receivedAt >= targetAt) {
            previous = buffer[i - 1];
            current = buffer[i];
            break;
          }
          previous = buffer[i];
        }
      }
      const span = Math.max(1, current.receivedAt - previous.receivedAt);
      const alpha = previous === current
        ? 1
        : Math.max(0, Math.min(1, (targetAt - previous.receivedAt) / span));
      if (car.networkEntityId === localId) {
        // Predict locally for immediate controls, but continuously reconcile to
        // the host's authoritative car state with bounded visual corrections.
        const state = interpolateSnapshot(previous.state, current.state, alpha);
        const correction = race.online.reconnecting ? 0.45 : 0.08;
        const angleError = Math.atan2(
          Math.sin(state.heading - car.heading),
          Math.cos(state.heading - car.heading),
        );
        car.x += Math.max(-correction, Math.min(correction, state.x - car.x));
        car.z += Math.max(-correction, Math.min(correction, state.z - car.z));
        car.heading += Math.max(-0.035, Math.min(0.035, angleError));
        car.speed = car.speed * 0.82 + state.speed * 0.18;
        car.progress += Math.max(-correction, Math.min(correction, state.progress - car.progress));
        applyRaceTelemetry(car, previous.state, current.state, alpha);
        if (
          Math.abs(state.x - car.x) < 0.8 &&
          Math.abs(state.z - car.z) < 0.8 &&
          Math.abs(state.speed - car.speed) < 1.5
        ) race.online.reconnecting = false;
      } else {
        applyInterpolatedState(car, previous.state, current.state, alpha);
        if (car.timingState && Number.isFinite(car.progress)) car.timingState.progress = car.progress;
        const timing = race.timing?.states?.[car.id];
        if (timing) {
          timing.progress = car.progress;
          timing.s = car.s;
          timing.lap = car.lap;
        }
      }
    }
    if (Number.isFinite(race.network.hostTime)) race.time = race.network.hostTime;
    if (Number.isFinite(race.network.hostCountdown))
      race.countdown = race.network.hostCountdown;
    if (race.network.hostFlag) race.flag = race.network.hostFlag;
    if (race.network.hostState === "red") {
      race.state = "red";
      race.done = false;
    } else if (race.network.hostState === "racing") {
      race.state = "racing";
      race.done = false;
      race.finishWait = 0;
    } else if (race.network.hostState === "finishing") {
      race.state = "finishing";
      race.done = false;
    } else if (race.network.hostState === "results") {
      race.state = "results";
      race.done = true;
    }
  }

  applyEvents(race, events) {
    for (const event of events) {
      if (!Number.isSafeInteger(event.id) || event.id <= (race.network.hostEventId || 0)) continue;
      if (!VALID_EVENTS.has(event.type)) continue;
      const car = race.cars.find((candidate) => candidate.networkEntityId === event.entityId);
      const against = race.cars.find((candidate) => candidate.networkEntityId === event.againstEntityId);
      const item = {
        id: ++race.eventSerial,
        type: event.type,
        car: car?.id ?? null,
        detail: String(event.detail || "").slice(0, 120),
        time: Number.isFinite(event.time) ? event.time : race.time,
      };
      if (event.type === "overtake") {
        item.by = car?.id ?? null;
        item.against = against?.id ?? null;
        item.detail = `${car?.name || "Piloto"} ultrapassou ${against?.name || "outro piloto"}`;
      }
      race.events.push(item);
      race.network.hostEventId = event.id;
    }
    if (race.events.length > 150) race.events.splice(0, race.events.length - 150);
  }

  async submitRaceResults(race) {
    const raceId = race.online.raceId;
    this.lastSubmittedRaceId = raceId;
    const ordered = race.standings();
    const results = ordered.map((car, i) => ({
      entity_key: car.networkEntityId,
      player_id: car.networkEntityId.startsWith("player:")
        ? car.networkEntityId.slice("player:".length)
        : null,
      driver_name: car.name,
      position: i + 1,
      completed_laps: car.lap,
      finish_time: Number.isFinite(car.finishTime) ? car.finishTime : null,
      best_lap: Number.isFinite(car.bestLap) ? car.bestLap : null,
      penalty_seconds: Number.isFinite(car.penalty) ? car.penalty : 0,
      result_status: car.finished
        ? "finished"
        : car.retirement === "Desconectado"
          ? "disconnected"
          : "dnf",
    }));
    try {
      const { error } = await this.client.rpc("finish_room_race", {
        p_room_id: this.state.room.id,
        p_race_id: raceId,
        p_results: results,
      });
      if (error) throw error;
      await this.refreshRoomState();
    } catch (error) {
      this.lastSubmittedRaceId = null;
      this.emit({ error: `Não foi possível registrar os resultados: ${friendlyError(error)}` });
    }
  }

  clearOnlineRace() {
    this.game.onlineRaceContext = null;
    if (this.game.race?.online) this.game.race = null;
    this.game.controls?.clear();
    this.game.world.raceContext = null;
    this.game.world.setMode("showcase");
    this.game.world.setPreview(this.game.save.selectedCar);
    this.game.ui.modal = null;
    this.game.ui.closeModal();
    this.state.onlineRace = false;
    this.lastLocalRaceId = null;
  }

  writeLastRoom(id) {
    try {
      sessionStorage.setItem(ROOM_KEY, id);
    } catch {}
  }
  readLastRoom() {
    try {
      const id = sessionStorage.getItem(ROOM_KEY);
      return /^[0-9a-f-]{36}$/i.test(String(id || "")) ? id : null;
    } catch {
      return null;
    }
  }
  removeLastRoom() {
    try {
      sessionStorage.removeItem(ROOM_KEY);
    } catch {}
  }

  async handleAction(action, data = {}) {
    try {
      switch (action) {
        case "auth-login": {
          const form = document.getElementById("auth-login-form");
          await this.signInWithCredentials({
            identifier: form?.querySelector('[name="identifier"]')?.value,
            password: form?.querySelector('[name="password"]')?.value,
            keepSignedIn: form?.querySelector('[name="keep"]')?.checked !== false,
          });
          this.game.ui.render();
          return true;
        }
        case "auth-register": {
          const form = document.getElementById("auth-register-form");
          const field = (name) => form?.querySelector(`[name="${name}"]`)?.value;
          await this.signUp({
            username: field("username"),
            email: field("email"),
            password: field("password"),
            confirmPassword: field("confirm"),
          });
          this.game.ui.render();
          return true;
        }
        case "auth-logout":
          await this.signOut();
          this.game.ui.render();
          return true;
        case "auth-forgot": {
          const form = document.getElementById("auth-forgot-form");
          await this.sendPasswordReset(form?.querySelector('[name="email"]')?.value);
          this.game.ui.render();
          return true;
        }
        case "auth-resend":
          await this.resendConfirmation(this.state.pendingEmail);
          this.game.ui.render();
          return true;
        case "auth-view":
          this.switchAuthView(data.view);
          return true;
        case "identity-claim": {
          const form = document.getElementById("identity-form");
          await this.claimUsername(form?.querySelector('[name="pilot_name"]')?.value);
          this.game.ui.render();
          return true;
        }
        case "identity-random": {
          const input = document.querySelector('#identity-form [name="pilot_name"]');
          if (input) {
            input.value = this.randomPilotName();
            input.focus();
          }
          return true;
        }
        case "mp-name":
          await this.updateDisplayName(document.getElementById("mp-new-name")?.value);
          this.game.ui.toast("Nome de exibição atualizado.");
          return true;
        case "mp-create": {
          const settings = readRoomForm("mp-create-form");
          await this.createRoom(settings);
          this.game.ui.render();
          return true;
        }
        case "mp-join-code":
          await this.joinRoomByCode(document.getElementById("mp-join-code-input")?.value);
          this.game.ui.render();
          return true;
        case "mp-join-room":
          await this.joinRoomById(data.roomId);
          this.game.ui.render();
          return true;
        case "mp-refresh":
          await this.refreshPublicRooms();
          this.game.ui.toast("Lista de salas atualizada.");
          return true;
        case "mp-quick-play":
          await this.quickPlay();
          this.game.ui.render();
          return true;
        case "mp-quick-play-cancel":
          this.cancelQuickPlay();
          return true;
        case "mp-ready":
          await this.setReady(data.ready === "true");
          return true;
        case "mp-save-config":
          await this.configureRoom(readRoomForm("mp-lobby-config"));
          this.game.ui.toast("Configuração da sala atualizada.");
          return true;
        case "mp-start":
          await this.startRoom();
          return true;
        case "mp-return-lobby":
          await this.returnToLobby();
          return true;
        case "mp-leave":
          await this.leaveRoom();
          this.game.ui.page = "multiplayer";
          this.game.ui.render();
          return true;
        case "mp-copy-code":
          await navigator.clipboard.writeText(this.state.room?.code || "");
          this.game.ui.toast("Código copiado para a área de transferência.");
          return true;
        case "mp-close-error":
          this.emit({ error: "" });
          return true;
        default:
          return false;
      }
    } catch (error) {
      this.emit({ busy: false, error: friendlyError(error), info: "" });
      this.game.ui?.toast?.(friendlyError(error));
      return true;
    }
  }

  async dispose() {
    this.cancelQuickPlay();
    await this.detachRoom();
    if (this.publicChannel) {
      try {
        await this.client.removeChannel(this.publicChannel);
      } catch {}
      this.publicChannel = null;
    }
  }
}

function readRoomForm(id) {
  const form = document.getElementById(id);
  if (!form) throw new Error("O formulário da sala não está disponível.");
  const value = (name) => form.querySelector(`[name="${name}"]`)?.value;
  return {
    name: value("name"),
    visibility: value("visibility"),
    trackId: value("track_id"),
    lapCount: Number(value("lap_count")),
    maxPlayers: Number(value("max_players")),
    botCount: Number(value("bot_count")),
  };
}

function cleanUsername(raw) {
  const value = String(raw || "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "");
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(value))
    throw new RangeError("username_invalid");
  return value;
}

function cleanEmail(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) || value.length > 254)
    throw new RangeError("Informe um e-mail válido.");
  return value;
}

function cleanDisplayName(raw) {
  const value = String(raw || "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (value.length < 2 || value.length > 24)
    throw new RangeError("O nome de exibição deve ter entre 2 e 24 caracteres.");
  return value;
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
function clampSteer(value) {
  return Math.max(-1, Math.min(1, Number(value) || 0));
}
function interpolateSnapshot(previous, current, alpha) {
  const t = Math.max(0, Math.min(1, alpha));
  const state = { ...current };
  for (const field of ["x", "z", "speed", "s", "lateral", "progress", "vx", "vz", "lapTime"])
    state[field] = previous[field] + (current[field] - previous[field]) * t;
  const delta = Math.atan2(
    Math.sin(current.heading - previous.heading),
    Math.cos(current.heading - previous.heading),
  );
  state.heading = previous.heading + delta * t;
  return state;
}
// Supabase rejects signInAnonymously() (HTTP 403, "Anonymous sign-ins are
// disabled") when the project has the toggle off. Detect it across the shapes
// auth-js returns so the gate can fall back to the e-mail account panel.
function isAnonymousSignInDisabled(error) {
  const text = String(error?.message ?? error ?? "");
  return (
    /anonymous[\s_-]*sign[\s_-]*ins?\s+(?:are|is)\s+(?:not\s+)?disabled/i.test(text) ||
    /(?:disabled|not\s+enabled|admin\s+only)[\s\S]{0,40}anonymous/i.test(text) ||
    /anonymous[\s\S]{0,40}(?:disabled|not\s+enabled|admin\s+only)/i.test(text)
  );
}

function friendlyError(error) {
  const message = String(error?.message || error || "Falha de conexão.").slice(0, 220);
  if (isAnonymousSignInDisabled(error))
    return "A identidade anônima está desativada neste projeto Supabase. Entre com uma conta de e-mail, ou habilite Anonymous Sign-Ins em Authentication → Sign In / Providers.";
  if (/save_too_large|cloud_save_too_large/i.test(message))
    return "Este save excede o limite de 8 MiB da sincronização em nuvem. Reduza retratos personalizados e tente novamente.";
  if (/cloud_save_invalid|cloud_save_revision_invalid/i.test(message))
    return "O save da nuvem está inválido. Seus dados locais foram mantidos; entre em contato com o suporte.";
  if (/profile_missing/i.test(message))
    return "A conta não possui perfil de jogo no Supabase. Verifique a configuração do banco.";
  if (/email_account_required|authentication_required/i.test(message))
    return "Entre na sua conta para usar o multiplayer.";
  if (/invalid login credentials|invalid_grant/i.test(message))
    return "Nome de usuário/e-mail ou senha incorretos.";
  if (/email not confirmed/i.test(message))
    return "Confirme seu e-mail antes de entrar. Reenvie a confirmação se necessário.";
  if (/user already registered|already been registered/i.test(message))
    return "Este e-mail já está cadastrado. Faça login ou recupere sua senha.";
  if (/username_taken|23505/i.test(message))
    return "Este nome de piloto já está em uso. Escolha outro.";
  if (/username_rate_limited/i.test(message))
    return "Muitas tentativas de trocar o nome. Aguarde um minuto e tente novamente.";
  if (/username_invalid/i.test(message))
    return "O nome de usuário deve ter 3 a 20 caracteres (letras, números e _).";
  if (/account_not_found/i.test(message))
    return "Nenhuma conta encontrada para este nome de usuário.";
  if (/password_mismatch/i.test(message))
    return "As senhas não conferem. Digite a mesma senha nos dois campos.";
  if (/password.*(8|characters)|weak|should be at least/i.test(message))
    return "A senha deve ter pelo menos 8 caracteres.";
  if (/email.*(invalid|rate)|over_email_send_rate_limit|rate.?limit/i.test(message))
    return "E-mail inválido ou limite de envios atingido. Aguarde alguns segundos e tente novamente.";
  if (/room_full|room is full|capacity/i.test(message)) return "A sala está cheia.";
  if (/invalid_invite|private|code/i.test(message)) return "Código de convite inválido ou sala privada.";
  if (/not.*host|permission|not authorized|42501/i.test(message)) return "Essa ação é permitida somente ao anfitrião.";
  if (/not ready|all.*ready/i.test(message)) return "Todos os participantes conectados precisam confirmar presença.";
  if (/lap|volta/i.test(message)) return "A corrida deve ter entre 8 e 30 voltas.";
  if (/closed|expired|not found|unavailable/i.test(message)) return "A sala foi encerrada ou não está mais disponível.";
  return message;
}
function isSaveRevisionConflict(error) {
  return (
    error?.code === "40001" ||
    /save_revision_conflict/i.test(String(error?.message || error || ""))
  );
}
function isRoomUnavailable(error) {
  return /room_closed|room_expired|not found|no longer available|room_unavailable/i.test(
    String(error?.message || error || ""),
  );
}
function closedMessage(reason) {
  if (reason === "host_left") return "O anfitrião saiu durante a corrida. A sessão foi encerrada sem registrar resultado.";
  if (reason === "host_timeout") return "A conexão do anfitrião foi perdida. A corrida foi encerrada sem registrar resultado.";
  return "A sala foi encerrada.";
}
