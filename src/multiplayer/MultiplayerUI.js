import { trackById } from "../data/tracks.js";
import { MAX_RACE_LAPS, MIN_RACE_LAPS, MAX_GRID_CARS } from "../racing/RaceConfig.js";
import { icon } from "../icons.js";

const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const lapOptions = [8, 9, 10, 12, 14, 20, 25, 30];
const trackSelect = (tracks, value, name = "track_id", disabled = false) =>
  `<select name="${name}" ${disabled ? "disabled" : ""}>${tracks
    .map((track) => `<option value="${esc(track.id)}" ${track.id === value ? "selected" : ""}>${esc(track.name)}</option>`)
    .join("")}</select>`;
const lapSelect = (value, name = "lap_count", disabled = false) =>
  `<select name="${name}" min="${MIN_RACE_LAPS}" max="${MAX_RACE_LAPS}" ${disabled ? "disabled" : ""}>${lapOptions
    .map((laps) => `<option value="${laps}" ${Number(value) === laps ? "selected" : ""}>${laps} voltas</option>`)
    .join("")}</select>`;
const maxPlayerSelect = (value, disabled = false) =>
  `<select name="max_players" ${disabled ? "disabled" : ""}>${Array.from({ length: MAX_GRID_CARS - 1 }, (_, i) => i + 2)
    .map((n) => `<option value="${n}" ${Number(value) === n ? "selected" : ""}>${n} jogadores</option>`)
    .join("")}</select>`;
const botSelect = (value, disabled = false) =>
  `<select name="bot_count" ${disabled ? "disabled" : ""}>${Array.from({ length: MAX_GRID_CARS }, (_, i) => i)
    .map((n) => `<option value="${n}" ${Number(value) === n ? "selected" : ""}>${n} ${n === 1 ? "bot" : "bots"} (máx. ${MAX_GRID_CARS})</option>`)
    .join("")}</select>`;

export function extendMultiplayerUI(UI) {
  UI.prototype.accountGate = function () {
    const game = this.game;
    const state = game.multiplayer.state;
    let content = "";
    if (game.authStatus === "checking") {
      content = `<section class="panel account-check"><span class="account-spinner" aria-hidden="true"></span><b>Verificando sua conta e sua carreira…</b><small>Não feche esta página enquanto carregamos o save protegido.</small></section>`;
    } else if (!state.configured) {
      content = this.multiplayerUnconfigured();
    } else if (game.authStatus === "sync-error") {
      content = `<div class="mp-alert" role="alert"><span>${icon("alert")}</span><p>${esc(state.error || "Não foi possível carregar sua carreira da nuvem.")}</p></div><button type="button" class="btn primary full-width account-retry" data-action="account-retry" ${state.busy ? "disabled" : ""}>${state.busy ? "TENTANDO…" : "TENTAR NOVAMENTE"}</button>`;
    } else {
      content = this.authPanel();
    }
    const footnote = state.anonymousUnavailable
      ? "Conta de e-mail e senha via Supabase Auth. Habilite Anonymous Sign-Ins no painel para liberar a entrada sem cadastro."
      : "Identidade anônima via Supabase Auth. Contas antigas com e-mail continuam acessíveis pela opção secundária.";
    return `<main class="account-gate"><div class="account-gate-shell"><div class="account-brand"><img src="/assets/logo-primary.png" alt="Apex Dynasty"><span><b>APEX DYNASTY<span class="brand-dot">.</span></b><small>BUILD THE TEAM. MASTER THE RACE.</small></span></div><section class="account-gate-intro"><div class="eyebrow">UMA CONTA · A MESMA CARREIRA</div><h1>Seu legado acompanha você.</h1><p>Escolha seu nome de piloto e entre direto no jogo. Sua carreira fica salva na nuvem vinculada à sua identidade.</p></section>${content}<p class="account-gate-footnote">${footnote}</p></div></main>`;
  };

  UI.prototype.authPanel = function () {
    const state = this.game.multiplayer.state;
    // With Anonymous Sign-Ins turned off on the project there is no identity to
    // claim, so the gate must land on the e-mail account panel.
    const anonymousOff = !!state.anonymousUnavailable;
    let view = state.authView || (anonymousOff ? "login" : "identity");
    if (anonymousOff && view === "identity") view = "login";
    const busy = state.busy ? "disabled" : "";
    const alert = state.error
      ? `<div class="mp-alert" role="alert"><span>${icon("alert")}</span><p>${esc(state.error)}</p><button data-action="mp-close-error" aria-label="Fechar">${icon("close")}</button></div>`
      : "";
    const info = state.info
      ? `<div class="mp-info" role="status"><span class="live-dot"></span>${esc(state.info)}</div>`
      : "";
    if (view === "identity") {
      return `${alert}${info}<section class="panel mp-identity-card auth-card"><div class="eyebrow">BEM-VINDO AO APEX DYNASTY</div><h2>IDENTIFIQUE SEU PILOTO.</h2><p>Escolha seu nome e entre no mundo do Apex Dynasty.</p><form id="identity-form" data-auth-form="identity-claim" class="mp-form" autocomplete="off" onsubmit="return false"><label>NOME DO PILOTO<input name="pilot_name" maxlength="20" minlength="3" pattern="[A-Za-z0-9_]{3,20}" placeholder="3-20 letras, números ou _" required autocomplete="nickname"></label><button type="button" class="btn primary full-width" data-action="identity-claim" ${busy}>${state.busy ? "SALVANDO…" : "ENTRAR NO JOGO"}</button></form><button type="button" class="btn secondary full-width" data-action="identity-random" ${busy}>${icon("reset")} GERAR NOME ALEATÓRIO</button><p class="subtle auth-warning">Sem e-mail nem senha: este piloto fica vinculado a este navegador. Limpar os dados do navegador ou trocar de dispositivo pode fazer você perder o acesso a este perfil e progresso.</p><div class="auth-links"><span>Já tem uma conta antiga?</span><button type="button" class="btn text-btn" data-action="auth-view" data-view="login">ENTRAR COM E-MAIL</button></div></section>`;
    }
    if (view === "register") {
      return `${alert}${info}<section class="panel mp-identity-card auth-card"><div class="eyebrow">ACESSO RESTRITO · NOVA CONTA</div><h2>Crie sua conta.</h2><p>Escolha um nome de usuário único, informe seu e-mail e defina uma senha. Você receberá um e-mail de confirmação.</p><form id="auth-register-form" data-auth-form="auth-register" class="mp-form" autocomplete="off" onsubmit="return false"><label>NOME DE USUÁRIO<input name="username" maxlength="20" minlength="3" pattern="[A-Za-z0-9_]{3,20}" placeholder="3-20 letras, números ou _" required autocomplete="username"></label><label>E-MAIL<input name="email" type="email" maxlength="254" required autocomplete="email"></label><label>SENHA<input name="password" type="password" minlength="8" maxlength="72" required autocomplete="new-password"></label><label>CONFIRMAR SENHA<input name="confirm" type="password" minlength="8" maxlength="72" required autocomplete="new-password"></label><button type="button" class="btn primary full-width" data-action="auth-register" ${busy}>${state.busy ? "CRIANDO…" : "CRIAR CONTA"}</button></form><div class="auth-links"><span>Já tem conta?</span><button type="button" class="btn text-btn" data-action="auth-view" data-view="login">ENTRAR</button></div></section>`;
    }
    if (view === "confirm") {
      return `${alert}${info}<section class="panel mp-identity-card auth-card"><div class="eyebrow">CONFIRME SEU E-MAIL</div><h2>Quase lá.</h2><p>Enviamos um e-mail de confirmação para <b>${esc(state.pendingEmail || "seu e-mail")}</b>. Clique no link da mensagem para liberar sua conta antes de entrar.</p><button type="button" class="btn primary full-width" data-action="auth-resend" ${busy}>${state.busy ? "ENVIANDO…" : "REENVIAR CONFIRMAÇÃO"}</button><div class="auth-links"><span>Já confirmou?</span><button type="button" class="btn text-btn" data-action="auth-view" data-view="login">IR PARA O LOGIN</button></div></section>`;
    }
    if (view === "forgot") {
      return `${alert}${info}<section class="panel mp-identity-card auth-card"><div class="eyebrow">RECUPERAR SENHA</div><h2>Esqueceu sua senha?</h2><p>Informe o e-mail da sua conta e enviaremos um link para redefinir a senha.</p><form id="auth-forgot-form" data-auth-form="auth-forgot" class="mp-form" autocomplete="off" onsubmit="return false"><label>E-MAIL<input name="email" type="email" maxlength="254" required autocomplete="email"></label><button type="button" class="btn primary full-width" data-action="auth-forgot" ${busy}>${state.busy ? "ENVIANDO…" : "ENVIAR LINK DE RECUPERAÇÃO"}</button></form><div class="auth-links"><button type="button" class="btn text-btn" data-action="auth-view" data-view="login">VOLTAR AO LOGIN</button></div></section>`;
    }
    if (view === "reset-sent") {
      return `${alert}${info}<section class="panel mp-identity-card auth-card"><div class="eyebrow">E-MAIL ENVIADO</div><h2>Verifique sua caixa de entrada.</h2><p>Se <b>${esc(state.pendingEmail || "o e-mail informado")}</b> estiver cadastrado, você receberá um link para redefinir sua senha.</p><div class="auth-links"><button type="button" class="btn text-btn" data-action="auth-view" data-view="login">VOLTAR AO LOGIN</button></div></section>`;
    }
    const identityLink = anonymousOff
      ? ""
      : `<span>·</span><button type="button" class="btn text-btn" data-action="auth-view" data-view="identity">VOLTAR</button>`;
    const anonymousNote = anonymousOff
      ? `<p class="subtle auth-warning">Identidade anônima indisponível neste projeto (Anonymous Sign-Ins desligado no Supabase). Crie uma conta de e-mail para entrar — a confirmação é automática e sua carreira fica salva na nuvem.</p>`
      : "";
    return `${alert}${info}<section class="panel mp-identity-card auth-card"><div class="eyebrow">ACESSO RESTRITO · CONTA</div><h2>Entre na sua conta.</h2><p>Use seu nome de usuário ou e-mail e sua senha.</p>${anonymousNote}<form id="auth-login-form" data-auth-form="auth-login" class="mp-form" autocomplete="off" onsubmit="return false"><label>NOME DE USUÁRIO OU E-MAIL<input name="identifier" maxlength="254" required autocomplete="username"></label><label>SENHA<input name="password" type="password" maxlength="72" required autocomplete="current-password"></label><label class="auth-keep"><input type="checkbox" name="keep" checked><span>Manter conectado neste dispositivo</span></label><button type="button" class="btn primary full-width" data-action="auth-login" ${busy}>${state.busy ? "ENTRANDO…" : "ENTRAR"}</button></form><div class="auth-links"><button type="button" class="btn text-btn" data-action="auth-view" data-view="forgot">ESQUECI MINHA SENHA</button><span>·</span><button type="button" class="btn text-btn" data-action="auth-view" data-view="register">CRIAR CONTA</button>${identityLink}</div></section>`;
  };

  UI.prototype.multiplayer = function () {
    const mp = this.game.multiplayer;
    if (!mp) return this.title("APEX ONLINE", "Multiplayer indisponível.");
    const state = mp.state;
    return `${this.title("APEX ONLINE / CORRIDAS REAIS", "Corra com pessoas de verdade.", "Salas e corridas sincronizadas. Sua carreira também fica vinculada à mesma conta.")}
      ${state.error ? `<div class="mp-alert" role="alert"><span>${icon("alert")}</span><p>${esc(state.error)}</p><button data-action="mp-close-error" aria-label="Fechar">${icon("close")}</button></div>` : ""}
      ${state.info ? `<div class="mp-info" role="status"><span class="live-dot"></span>${esc(state.info)}</div>` : ""}
      ${this.quickPlayBanner()}
      ${!state.configured ? this.multiplayerUnconfigured() : !state.profile ? this.authPanel() : state.room ? this.multiplayerLobby() : this.multiplayerRooms()}`;
  };

  UI.prototype.quickPlayBanner = function () {
    const state = this.game.multiplayer.state;
    if (!state.quickPlayPhase) return "";
    const labels = {
      searching: "Procurando partida rápida…",
      creating: "Nenhuma sala com vaga — criando sala pública…",
      waiting: "Aguardando outros jogadores…",
    };
    const waiting = state.quickPlayPhase === "waiting";
    return `<section class="panel mp-quickplay" role="status"><span class="account-spinner" aria-hidden="true"></span><div><b>${labels[state.quickPlayPhase] || "Procurando partida…"}</b><small>${waiting ? `${esc(state.quickPlayElapsed)}s — se ninguém aparecer em ${esc(Math.round(this.game.multiplayer.quickPlayWaitMs / 1000))}s, os bots completam o grid.` : "Verifique sua conexão se demorar."}</small></div><button type="button" class="btn text-btn" data-action="mp-quick-play-cancel">${icon("close")} CANCELAR BUSCA</button></section>`;
  };

  UI.prototype.multiplayerUnconfigured = function () {
    return `<section class="panel mp-setup-required"><span class="mp-mark">${icon("wifi")}</span><div><div class="eyebrow">SUPABASE NECESSÁRIO</div><h2>Configure o acesso por conta.</h2><p>Todo o jogo exige uma conta de e-mail e senha criada no Supabase Auth antes de carregar a carreira. O banco também rejeita acessos sem conta confirmada.</p><ol><li>Aplique as migrations de <code>supabase/migrations/</code>.</li><li>No Supabase, mantenha o provedor <b>E-mail</b> habilitado e exija confirmação de e-mail em Authentication → Settings.</li><li>Defina <code>VITE_SUPABASE_URL</code> e a chave publicável <code>VITE_SUPABASE_ANON_KEY</code>; então reinicie o Vite.</li></ol><p class="subtle">Nunca coloque a chave <code>service_role</code> ou qualquer segredo no frontend.</p></div></section>`;
  };

  UI.prototype.multiplayerRooms = function () {
    const mp = this.game.multiplayer;
    const state = mp.state;
    const profile = state.profile;
    const roomRows = state.publicRooms.map((room) => {
      const track = trackById(room.track_id);
      return `<article class="mp-room-row"><div class="mp-room-status"><i class="live-dot"></i><small>${esc(room.status === "waiting" ? "LOBBY" : room.status.toUpperCase())}</small></div><div class="mp-room-main"><b>${esc(room.name)}</b><span>${esc(track.name)} · ${room.lap_count} voltas · ${room.player_count}/${room.max_players} jogadores · até ${room.bot_count} bots</span></div><div class="mp-room-actions"><span class="mp-public-label">PÚBLICA</span><button type="button" class="btn secondary" data-action="mp-join-room" data-room-id="${esc(room.id)}" ${room.player_count >= room.max_players || state.busy ? "disabled" : ""}>ENTRAR ${icon("arrow")}</button></div></article>`;
    }).join("");
    return `<section class="mp-profile-strip panel"><div class="mp-avatar">${esc((profile.display_name || "?").slice(0, 1).toUpperCase())}</div><div><small>JOGADOR · CONTA</small><b>${esc(profile.display_name)}</b><span>@${esc(profile.username || "")} · ${esc(profile.id.slice(0, 8))}… · Supabase Auth</span></div><form id="mp-profile-name-form" class="mp-profile-name" onsubmit="return false"><input id="mp-new-name" value="${esc(profile.display_name)}" maxlength="24" aria-label="Novo nome de exibição"><button type="button" class="btn secondary" data-action="mp-name">SALVAR NOME</button></form><button type="button" class="btn text-btn" data-action="auth-logout">${icon("close")} SAIR</button></section>
      <div class="mp-workspace"><section class="panel mp-create-card"><div class="eyebrow">NOVO GRID</div><h2>Criar sala.</h2><p>O anfitrião controla pista e largada. O limite do grid real é ${MAX_GRID_CARS} carros.</p><form id="mp-create-form" class="mp-form mp-room-form" autocomplete="off" onsubmit="return false"><label>NOME DA SALA<input name="name" value="Sala Apex" maxlength="40" minlength="3" required></label><label>VISIBILIDADE<select name="visibility"><option value="public">Pública · aparece na busca</option><option value="private">Privada · somente convite</option></select></label><label>PISTA${trackSelect(mp.trackOptions, this.game.save.settings.track)}</label><label>VOLTAS${lapSelect(8)}</label><label>JOGADORES${maxPlayerSelect(6)}</label><label>BOTS${botSelect(5)}</label><small class="subtle">Bots preenchem as vagas restantes até o grid físico de seis; configurações inválidas são rejeitadas também pelo banco.</small><button type="button" class="btn primary" data-action="mp-create" ${state.busy ? "disabled" : ""}>CRIAR SALA ${icon("arrow")}</button></form><div class="mp-join-code"><div class="eyebrow">TEM UM CONVITE?</div><div class="mp-code-entry"><input id="mp-join-code-input" maxlength="8" minlength="8" placeholder="CÓDIGO DE 8 CARACTERES" aria-label="Código de convite" autocomplete="off" spellcheck="false"><button type="button" class="btn secondary" data-action="mp-join-code">ENTRAR PELO CÓDIGO</button></div></div></section><section class="panel mp-room-list"><div class="mp-section-head"><div><div class="eyebrow">SALAS PÚBLICAS</div><h2>Encontre uma corrida.</h2></div><div class="mp-room-list-actions"><button type="button" class="btn primary" data-action="mp-quick-play" ${state.busy || state.quickPlayPhase ? "disabled" : ""}>${icon("bolt")} JOGAR AGORA</button><button type="button" class="btn text-btn" data-action="mp-refresh" ${state.busy ? "disabled" : ""}>${icon("reset")} ATUALIZAR</button></div></div>${roomRows || `<div class="mp-empty"><span>${icon("flag")}</span><b>Nenhuma sala pública disponível.</b><small>Use JOGAR AGORA, crie uma sala ou entre por código. Salas fechadas e privadas não aparecem.</small></div>`}</section></div>`;
  };

  UI.prototype.multiplayerLobby = function () {
    const mp = this.game.multiplayer;
    const { room, players, results, profile } = mp.state;
    if (!room) return this.multiplayerRooms();
    const isHost = room.host_id === profile?.id;
    const own = players.find((p) => p.player_id === profile?.id);
    const allReady = players.length > 0 && players.every((p) => p.ready && p.connection_status === "online");
    const effectiveBots = Math.min(Number(room.bot_count) || 0, Math.max(0, MAX_GRID_CARS - players.length));
    const track = trackById(room.track_id);
    const isWaiting = room.status === "waiting";
    const isResults = room.status === "results";
    const title = isWaiting ? "Preparação do grid." : room.status === "countdown" ? "Largada confirmada." : room.status === "racing" ? "Corrida em andamento." : isResults ? "Bandeirada final." : "Sala encerrada.";
    const statusText = {
      waiting: "AGUARDANDO PREPARAÇÃO",
      countdown: "CONTAGEM REGRESSIVA",
      racing: "CORRIDA AO VIVO",
      results: "RESULTADO FINAL",
      closed: "SALA ENCERRADA",
    }[room.status] || "SALA";
    const participantCards = players.map((p) => `<li class="mp-participant ${p.connection_status}"><span class="mp-avatar">${esc((p.display_name || "?").slice(0, 1).toUpperCase())}</span><div class="mp-participant-name"><b>${esc(p.display_name)}</b><small>${p.player_id === room.host_id ? "ANFITRIÃO" : "PILOTO"}${p.player_id === profile?.id ? " · VOCÊ" : ""}</small></div><span class="mp-ready-state ${p.ready ? "ready" : ""}"><i></i>${p.ready ? "PRONTO" : isWaiting ? "PREPARANDO" : "PRESENTE"}</span><span class="mp-presence ${p.connection_status}"><i></i>${connectionLabel(p.connection_status)}</span></li>`).join("");
    const resultRows = results.map((r) => `<tr><td>P${r.position}</td><td>${esc(r.driver_name)}${r.player_id ? "" : " <small>BOT</small>"}</td><td>${r.result_status === "finished" ? formatRaceTime(Number(r.finish_time) + Number(r.penalty_seconds || 0)) : esc(r.result_status === "disconnected" ? "Desconectado" : "DNF")}</td><td>${r.completed_laps}/${room.lap_count}</td><td>${r.best_lap ? formatRaceTime(Number(r.best_lap)) : "—"}</td></tr>`).join("");
    return `<div class="mp-lobby-header panel"><div><span class="mp-room-tag"><i></i>${esc(statusText)}</span><div class="eyebrow">${room.visibility === "private" ? "SALA PRIVADA" : "SALA PÚBLICA"} · ${esc(track.name.toUpperCase())}</div><h2>${esc(title)}</h2><p>${esc(room.name)} · ${room.lap_count} voltas · ${players.length}/${room.max_players} jogadores · ${effectiveBots} bots no grid</p></div><div class="mp-invite-box"><small>CÓDIGO PARA CONVIDAR</small><b>${esc(room.code)}</b><button type="button" class="btn secondary" data-action="mp-copy-code">${icon("copy")} COPIAR</button></div></div>
      <div class="mp-lobby-layout"><section class="panel mp-participants-card"><div class="mp-section-head"><div><div class="eyebrow">PARTICIPANTES REAIS</div><h3>${players.length} / ${room.max_players} pilotos</h3></div><span class="mp-connection-pill ${mp.state.connection}"><i></i>${connectionLabel(mp.state.connection)}</span></div><ul class="mp-participant-list">${participantCards || `<li class="mp-empty">Carregando participantes…</li>`}</ul>${isWaiting ? `<div class="mp-readiness"><div><b>${own?.ready ? "Você está pronto." : "Confirme quando estiver pronto."}</b><small>${mp.state.trackReady ? "Todos os pilotos conectados precisam confirmar antes da largada." : "Aguarde o carregamento local do circuito antes de confirmar presença."}</small></div><button type="button" class="btn ${own?.ready ? "secondary" : "primary"}" data-action="mp-ready" data-ready="${own?.ready ? "false" : "true"}" ${!own || mp.state.busy || (!own.ready && !mp.state.trackReady) ? "disabled" : ""}>${own?.ready ? "CANCELAR PRONTO" : mp.state.trackReady ? "ESTOU PRONTO" : "PREPARANDO CIRCUITO…"}</button></div>` : ""}</section>
      <section class="panel mp-config-card"><div class="eyebrow">CONFIGURAÇÃO ATUAL</div><h3>${isHost ? "Controle do anfitrião" : "Definida pelo anfitrião"}</h3>${isHost && isWaiting ? `<form id="mp-lobby-config" class="mp-form mp-room-form" onsubmit="return false"><label>NOME<input name="name" value="${esc(room.name)}" maxlength="40" required></label><label>VISIBILIDADE<select name="visibility"><option value="public" ${room.visibility === "public" ? "selected" : ""}>Pública</option><option value="private" ${room.visibility === "private" ? "selected" : ""}>Privada</option></select></label><label>PISTA${trackSelect(mp.trackOptions, room.track_id, "track_id")}</label><label>VOLTAS${lapSelect(room.lap_count)}</label><label>JOGADORES${maxPlayerSelect(room.max_players)}</label><label>BOTS${botSelect(room.bot_count)}</label><button type="button" class="btn secondary" data-action="mp-save-config">SALVAR CONFIGURAÇÃO</button></form>` : `<dl class="mp-config-values"><div><dt>PISTA</dt><dd>${esc(track.name)}</dd></div><div><dt>VOLTAS</dt><dd>${room.lap_count}</dd></div><div><dt>JOGADORES</dt><dd>${players.length} / ${room.max_players}</dd></div><div><dt>BOTS NO GRID</dt><dd>${effectiveBots}</dd></div><div><dt>STATUS</dt><dd>${esc(statusText)}</dd></div></dl>`}${isWaiting && isHost ? `<button type="button" class="btn primary mp-start-button" data-action="mp-start" ${!allReady || mp.state.busy ? "disabled" : ""}>${allReady ? "INICIAR CONTAGEM REGRESSIVA" : "AGUARDANDO TODOS PRONTOS"} ${icon("arrow")}</button>` : ""}${room.status === "countdown" ? `<div class="mp-countdown-box"><span class="live-dot"></span><b>Largada sincronizada</b><small>O relógio do Supabase coordena a saída.</small></div>` : ""}${isResults ? `<div class="mp-online-results"><div class="eyebrow">CLASSIFICAÇÃO FINAL · ${esc(track.name.toUpperCase())}</div>${resultRows ? `<div class="mp-results-table"><table><thead><tr><th>POS</th><th>PILOTO</th><th>TEMPO</th><th>VOLTAS</th><th>MELHOR</th></tr></thead><tbody>${resultRows}</tbody></table></div>` : `<p>Resultado indisponível para esta sessão.</p>`}${isHost ? `<button type="button" class="btn primary" data-action="mp-return-lobby">VOLTAR AO LOBBY / REMATCH ${icon("arrow")}</button>` : `<p class="subtle">O anfitrião poderá devolver a sala ao lobby para a próxima corrida.</p>`}</div>` : ""}<div class="mp-lobby-actions"><button type="button" class="btn text-btn" data-action="mp-leave">${icon("arrow")} SAIR DA SALA</button><small>Sair não encerra a sessão dos outros participantes.</small></div></section></div>`;
  };
}

function connectionLabel(status) {
  return ({ online: "CONECTADO", reconnecting: "RECONECTANDO", offline: "DESCONECTADO", unconfigured: "CONFIGURAÇÃO NECESSÁRIA", "email-unconfirmed": "CONFIRME SEU E-MAIL" })[status] || "CONECTANDO";
}
function formatRaceTime(value) {
  if (!Number.isFinite(value)) return "—";
  const minutes = Math.floor(value / 60);
  return `${minutes}:${(value % 60).toFixed(3).padStart(6, "0")}`;
}
