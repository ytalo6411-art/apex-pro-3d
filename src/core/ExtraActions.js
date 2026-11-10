import { setPlan } from "../strategy/PitStrategy.js";
import { compounds } from "../strategy/Resources.js";
import {
  driverCatalog,
  activeDriverForSave,
  resolveDriverPortrait,
  createAcademyDriver,
  generateRandomAcademyPreset,
  developAcademyDriver,
} from "../data/drivers.js";
import { vehicles, purchasePart } from "../garage.js";
import { defaults } from "../save.js";
import { requestPit } from "../strategy/PitStop.js";
import { nextCamera } from "../camera/CameraManager.js";
import { powerUnits } from "../data/powerUnits.js";
import { aeroSetupById } from "../data/parts.js";
import { sponsorById, teamPrincipalById } from "../data/sponsors.js";
function findDriverByKey(save, rawKey) {
  if (rawKey !== undefined && rawKey !== null && rawKey !== "") {
    const strKey = String(rawKey);
    const acad = (save.academy || []).find((a) => a.uid === strKey);
    if (acad) return acad;
    const numId = Number(strKey);
    if (Number.isInteger(numId) && driverCatalog[numId]) {
      return driverCatalog[numId];
    }
  }
  return activeDriverForSave(save);
}

function slugifyName(name) {
  return String(name || "piloto")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function downloadDriverPortrait(g, rawKey) {
  const s = g.save;
  const ui = g.ui;
  const driver = findDriverByKey(s, rawKey);
  if (!driver) {
    ui.toast("Não foi possível localizar o piloto selecionado.");
    return;
  }
  const pInfo = resolveDriverPortrait(driver, s);
  const src = pInfo.src;
  const slug = slugifyName(driver.name);
  const numStr = String(driver.number || 0).padStart(2, "0");

  // Render or fetch a clean high-resolution PNG so downloads work across all formats
  try {
    let downloadUrl = src;
    let revokeAfter = false;
    let ext = "png";
    if (src.startsWith("data:image/")) {
      const m = src.match(/^data:image\/([a-zA-Z0-9+]+);/);
      if (m) ext = m[1] === "jpeg" ? "jpg" : m[1].replace("+xml", "");
    } else {
      // Convert SVG/PNG portrait to a crisp downloadable PNG via offscreen canvas or fetch blob
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(" Portrait HTTP " + resp.status);
      const blob = await resp.blob();
      if (blob.type === "image/png" || blob.type === "image/jpeg" || blob.type === "image/webp") {
        ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
        downloadUrl = URL.createObjectURL(blob);
        revokeAfter = true;
      } else {
        // Render SVG onto high-res 384x432 PNG canvas so the user gets a ready-to-use PNG portrait
        const svgUrl = URL.createObjectURL(blob);
        const pngBlob = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = 384;
            canvas.height = 432;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#0b111b";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(svgUrl);
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
          };
          img.onerror = (err) => {
            URL.revokeObjectURL(svgUrl);
            reject(err);
          };
          img.src = svgUrl;
        });
        downloadUrl = URL.createObjectURL(pngBlob);
        revokeAfter = true;
        ext = "png";
      }
    }

    const fileName = pInfo.isPlaceholder
      ? `imagem-substituta-sem-foto-${slug}.${ext}`
      : `retrato-${slug}-${numStr}.${ext}`;

    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = fileName;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revokeAfter) {
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);
    }

    if (pInfo.isPlaceholder) {
      ui.toast(
        `Aviso: ${driver.name} usa imagem substituta genérica (não é foto oficial). Arquivo "${fileName}" baixado.`,
      );
    } else {
      ui.toast(`Retrato de ${driver.name} baixado (${fileName}).`);
    }
  } catch (err) {
    ui.toast("Não foi possível baixar a imagem do piloto no momento.");
  }
}

export function handlePortraitFileUpload(g, file, targetKey, onDone) {
  const ui = g.ui;
  const s = g.save;
  if (!file) return;
  const validTypes = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
  ];
  if (!validTypes.includes(file.type)) {
    ui.toast("Formato inválido. Selecione uma imagem PNG, JPG, WEBP ou SVG.");
    return;
  }
  if (file.size > 2.5 * 1024 * 1024) {
    ui.toast("Imagem muito grande (máximo 2,5 MB). Escolha um arquivo menor.");
    return;
  }
  const reader = new FileReader();
  reader.onerror = () => ui.toast("Erro ao ler o arquivo de imagem.");
  reader.onload = () => {
    const rawDataUrl = String(reader.result || "");
    const img = new Image();
    img.onerror = () =>
      ui.toast("Arquivo de imagem corrompido ou não suportado.");
    img.onload = () => {
      // Normalize to crisp 384x432 cover portrait PNG
      const canvas = document.createElement("canvas");
      canvas.width = 384;
      canvas.height = 432;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0b111b";
      ctx.fillRect(0, 0, 384, 432);
      const iw = img.naturalWidth || 384;
      const ih = img.naturalHeight || 432;
      const scale = Math.max(384 / iw, 432 / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (384 - dw) * 0.5;
      const dy = (432 - dh) * 0.35;
      ctx.drawImage(img, dx, dy, dw, dh);
      const normalizedDataUrl = canvas.toDataURL("image/png", 0.92);

      if (typeof onDone === "function") {
        onDone(normalizedDataUrl);
        ui.toast("Foto personalizada carregada com sucesso!");
        return;
      }

      const driver = findDriverByKey(s, targetKey);
      const key = String(driver.uid || driver.id);
      s.customPortraits = s.customPortraits || {};
      s.customPortraits[key] = normalizedDataUrl;
      if (driver.isAcademy) {
        driver.customPortrait = normalizedDataUrl;
        driver.portrait = normalizedDataUrl;
        driver.usePlaceholder = false;
        driver.isPlaceholderPortrait = false;
      }
      g.store();
      ui.render();
      ui.toast(`Retrato de ${driver.name} atualizado com sucesso!`);
    };
    img.src = rawDataUrl;
  };
  reader.readAsDataURL(file);
}

export function handleExtraAction(g, action, data) {
  if (!g.handlePortraitFileUpload) {
    g.handlePortraitFileUpload = (file, targetKey, cb) =>
      handlePortraitFileUpload(g, file, targetKey, cb);
  }
  if (!g.downloadDriverPortrait) {
    g.downloadDriverPortrait = (key) => downloadDriverPortrait(g, key);
  }
  const s = g.save,
    ui = g.ui;
  const refresh = () => {
    g.store();
    ui.render();
  };
  const applySettings = () => {
    g.controls.configure(g.save.settings);
    g.audio.configure(g.save.settings);
    g.engineer.configure(g.save.settings);
    g.world.quality(g.save.settings);
  };
  switch (action) {
    case "venue-tour":
      g.world.venueFocus =
        ((g.world.venueFocus ?? -1) + 1) % g.world.venues.plan.length;
      g.world.setMode("venue-preview");
      ui.toast(
        "Arquibancada " +
          (g.world.venueFocus + 1) +
          " / 10 · " +
          g.world.venues.plan[g.world.venueFocus].label,
      );
      return true;
    case "track-overview":
      g.world.setMode("track-preview");
      return true;
    case "track-catalog":
      ui.closeModal();
      ui.navigate("tracks");
      return true;
    case "track-filter":
      ui.trackFilter = data.category;
      ui.render();
      g.world.setMode("track-preview");
      return true;
    case "choose-track":
      g.loadTrack(data.id, { page: true });
      return true;

    case "hud-mode": {
      const modes = ["standard", "compact", "immersive"];
      g.setting("hudMode", modes[(modes.indexOf(s.settings.hudMode) + 1) % 3]);
      return true;
    }
    case "preview-pu": {
      ui.previewOverrides = { powerUnitId: Number(data.id) };
      ui.render();
      ui.toast("Comparador atualizado com a Unidade de Potência selecionada.");
      return true;
    }
    case "select-pu": {
      const id = Number(data.id);
      const pu = powerUnits[id];
      if (!pu) return true;
      s.unlockedPowerUnits = s.unlockedPowerUnits || [0];
      if (!s.unlockedPowerUnits.includes(id)) {
        if (s.credits < pu.cost) {
          ui.toast("Créditos insuficientes para adquirir esta Unidade de Potência.");
          return true;
        }
        s.credits -= pu.cost;
        s.unlockedPowerUnits.push(id);
      }
      s.selectedPowerUnit = id;
      ui.previewOverrides = null;
      refresh();
      ui.toast(pu.name + " instalado no carro titular.");
      return true;
    }
    case "preview-part": {
      ui.previewOverrides = {
        carParts: { [data.key]: Number(data.level) },
      };
      ui.render();
      ui.toast("Comparador Antes × Depois atualizado.");
      return true;
    }
    case "buy-part": {
      const res = purchasePart(s, data.key);
      ui.previewOverrides = null;
      if (res.ok) {
        refresh();
        ui.toast(res.message);
      } else {
        ui.toast(res.message);
      }
      return true;
    }
    case "aero-setup": {
      s.aeroSetup = aeroSetupById(data.value).id;
      ui.previewOverrides = null;
      refresh();
      ui.toast("Acerto aerodinâmico: " + aeroSetupById(s.aeroSetup).name);
      return true;
    }
    case "team-principal": {
      const tp = teamPrincipalById(Number(data.value));
      s.teamPrincipal = tp.id;
      refresh();
      ui.toast("Chefe de Equipe ativo: " + tp.name);
      return true;
    }
    case "sponsor-primary": {
      const sp = sponsorById(data.value);
      s.sponsors = s.sponsors || {
        primary: "aether_ai",
        secondary: "pirex_tires",
        goalsCompleted: 0,
        totalEarned: 0,
      };
      s.sponsors.primary = sp.id;
      refresh();
      ui.toast("Patrocinador Master: " + sp.name);
      return true;
    }
    case "sponsor-secondary": {
      const sp = sponsorById(data.value);
      s.sponsors = s.sponsors || {
        primary: "aether_ai",
        secondary: "pirex_tires",
        goalsCompleted: 0,
        totalEarned: 0,
      };
      s.sponsors.secondary = sp.id;
      refresh();
      ui.toast("Patrocinador Técnico: " + sp.name);
      return true;
    }

    case "download-driver-image": {
      downloadDriverPortrait(g, data.driverKey);
      return true;
    }
    case "change-driver-image": {
      ui.pendingPortraitTargetKey = data.driverKey;
      const input = document.getElementById("driver-portrait-upload-input");
      if (input) {
        input.click();
      } else {
        ui.toast("Abra a aba Pilotos para enviar um retrato personalizado.");
      }
      return true;
    }
    case "open-academy-creator": {
      ui.academyDraft = generateRandomAcademyPreset(
        Date.now() + (s.academy?.length || 0) * 31,
      );
      ui.showModal("academy-creator");
      return true;
    }
    case "academy-randomize": {
      ui.academyDraft = generateRandomAcademyPreset(
        Math.floor(Math.random() * 100000) + Date.now(),
      );
      ui.showModal("academy-creator");
      ui.toast("Novo perfil de talento da base gerado.");
      return true;
    }
    case "academy-create": {
      s.academy = s.academy || [];
      if (s.academy.length >= 8) {
        ui.toast("Limite de 8 pilotos na Academia da Base atingido.");
        return true;
      }
      const portraitSel = document.getElementById("acad-portrait-select")?.value;
      const usePlaceholder = portraitSel === "placeholder";
      const portraitIndex = usePlaceholder ? 0 : Number(portraitSel) || 0;
      const draft = {
        ...(ui.academyDraft || {}),
        firstName: document.getElementById("acad-first-name")?.value,
        lastName: document.getElementById("acad-last-name")?.value,
        nationality: document.getElementById("acad-nationality")?.value,
        age: Number(document.getElementById("acad-age")?.value),
        number: Number(document.getElementById("acad-number")?.value),
        program: document.getElementById("acad-program")?.value,
        styleKey: document.getElementById("acad-style")?.value,
        skillId: document.getElementById("acad-skill")?.value,
        suitColor: document.getElementById("acad-suit-color")?.value,
        helmetColor: document.getElementById("acad-helmet-color")?.value,
        teamName:
          document.getElementById("acad-team")?.value ||
          s.team?.name ||
          "Academia Apex Motorsport",
        portraitIndex,
        usePlaceholder,
        customAttributes: {
          speed: Number(document.getElementById("acad-attr-speed")?.value),
          racecraft: Number(document.getElementById("acad-attr-racecraft")?.value),
          overtaking: Number(document.getElementById("acad-attr-overtaking")?.value),
          defense: Number(document.getElementById("acad-attr-defense")?.value),
          tireControl: Number(document.getElementById("acad-attr-tire")?.value),
          consistency: Number(document.getElementById("acad-attr-consistency")?.value),
        },
      };
      const created = createAcademyDriver(draft, s.academy);
      if (created.customPortrait) {
        s.customPortraits = s.customPortraits || {};
        s.customPortraits[created.uid] = created.customPortrait;
      }
      s.academy.push(created);
      ui.academyDraft = null;
      ui.closeModal();
      refresh();
      ui.toast(
        `${created.name} (OVR ${created.overall} / POT ${created.attributes.potential}) integrado à Equipe & Academia!`,
      );
      return true;
    }
    case "academy-train": {
      const doc = (s.academy || []).find((a) => a.uid === data.uid);
      if (!doc) return true;
      const cost = 350;
      if (s.credits < cost) {
        ui.toast("Créditos insuficientes para sessão de treinamento (350 CR).");
        return true;
      }
      const res = developAcademyDriver(doc, data.kind || "pace");
      if (res.gained <= 0) {
        ui.toast(res.message);
        return true;
      }
      s.credits -= cost;
      refresh();
      ui.toast(res.message);
      return true;
    }
    case "academy-promote": {
      const doc = (s.academy || []).find((a) => a.uid === data.uid);
      if (!doc) return true;
      if (s.promotedAcademyId === doc.uid) {
        s.promotedAcademyId = null;
        refresh();
        ui.toast(
          `${doc.name} retornou à Academia. ${driverCatalog[s.selectedDriver].name} reassumiu a vaga titular.`,
        );
      } else {
        s.promotedAcademyId = doc.uid;
        refresh();
        ui.toast(
          `${doc.name} promovido a Piloto Titular da ${s.team?.name || "equipe"}!`,
        );
      }
      return true;
    }
    case "pilot": {
      const id = Number(data.id),
        d = driverCatalog[id];
      if (!d) return true;
      if (!s.unlockedDrivers.includes(id)) {
        if (id === 30) {
          ui.toast("Vença o confronto Mega Baxter para desbloquear.");
          return true;
        }
        if (s.credits < d.cost) {
          ui.toast("Créditos insuficientes para contratar.");
          return true;
        }
        s.credits -= d.cost;
        s.unlockedDrivers.push(id);
      }
      s.selectedDriver = id;
      s.promotedAcademyId = null;
      refresh();
      ui.toast(d.name + " contratado e selecionado como titular.");
      return true;
    }
    case "buy-car": {
      const id = Number(data.id),
        v = vehicles[id];
      if (v?.cost && !s.unlockedCars.includes(id) && s.credits >= v.cost) {
        s.credits -= v.cost;
        s.unlockedCars.push(id);
        s.selectedCar = id;
        g.world.customization = s.customizations[id];
        g.world.setPreview(id);
        refresh();
        ui.toast("Novo carro adquirido.");
      } else ui.toast("Saldo ou requisito insuficiente.");
      return true;
    }
    case "paint-editor":
      ui.showModal("paint-editor");
      return true;
    case "save-paint": {
      const customTeamName = document.getElementById("team-custom-name")?.value;
      if (customTeamName && customTeamName.trim()) {
        s.team.name = customTeamName.trim().slice(0, 30);
      }
      const primary = document.getElementById("paint-primary").value,
        secondary = document.getElementById("paint-secondary").value,
        detail = document.getElementById("paint-detail").value,
        number = Math.round(
          Math.max(
            0,
            Math.min(
              99,
              Number(document.getElementById("paint-number").value) || 0,
            ),
          ),
        );
      s.customizations[s.selectedCar] = { primary, secondary, detail, number };
      g.world.customization = s.customizations[s.selectedCar];
      g.world.setPreview(s.selectedCar);
      ui.closeModal();
      refresh();
      ui.toast("Identidade da equipe, pintura e número aplicados ao carro.");
      return true;
    }
    case "reset-paint":
      delete s.customizations[s.selectedCar];
      g.world.customization = null;
      g.world.setPreview(s.selectedCar);
      ui.closeModal();
      refresh();
      return true;
    case "rotate":
      g.world.previewRotation += ((Number(data.direction) || 1) * Math.PI) / 4;
      g.world.showCar.rotation.y +=
        ((Number(data.direction) || 1) * Math.PI) / 4;
      return true;
    case "camera":
      ui.toast(nextCamera(g.world));
      return true;
    case "pit":
      if (g.race?.manager) {
        const c = g.race.cars.find(
          (c) => c.id === (g.race.isDelegated() ? g.world.focusId || 0 : 0),
        );
        if (g.race.manager.owns(c))
          g.race.manager.command(
            c.id,
            c.pit.requested ? "cancel" : "pit",
            c.pit.compound,
          );
        return true;
      }
      if (g.race?.state === "racing") {
        const c = g.race.localCar || g.race.cars[0];
        const yes = requestPit(c);
        g.engineer.say(
          yes
            ? "Boxes solicitados. Aproxime-se pelo lado sinalizado dos boxes antes da linha de chegada. Entrada guiada, sem teletransporte."
            : "Pedido de boxes cancelado.",
          2,
          g.race.time,
          "pit-" + g.race.time,
        );
      }
      return true;
    case "radio":
      g.engineer.report(g.race);
      return true;
    case "pit-options":
      if (g.race?.isDelegated()) {
        g.action("manager-open");
        return true;
      }
      if (g.race) {
        if (g.race.state !== "paused") g.pause(true);
        ui.showModal("pit-options");
      }
      return true;
    case "pit-cancel":
      if (g.race?.localCar?.pit.state === "track") {
        g.race.localCar.pit.requested = false;
        g.pause();
      }
      return true;
    case "pit-plan-save":
    case "pit-compound": {
      if (!g.race) return true;
      const c = g.race.cars[0],
        p = c.pit;
      const plan = document.getElementById("pit-plan");
      if (plan) {
        setPlan(
          c,
          plan.value.split(",").map((n) => Number(n.trim())),
        );
        if (g.race.manager)
          g.race.manager.order(c.id, {
            stops: p.plan.map((l) => ({
              from: l,
              to: l,
              compound: p.compound,
            })),
          });
        s.settings.pitPlan = p.plan.slice();
        g.store();
      }
      if (!["service", "release"].includes(p.state)) {
        for (const job of ["tires", "repair", "fuel"]) {
          const el = document.getElementById("pit-job-" + job);
          if (el)
            p.jobs[job] =
              el.checked && (job !== "fuel" || c.realism === "realistic");
        }
        const target = Number(
          document.getElementById("pit-fuel-target")?.value,
        );
        if ([0.25, 0.5, 0.75, 1].includes(target)) p.fuelTarget = target;
        if (action === "pit-compound" && compounds[data.key])
          p.compound = data.key;
      }
      if (g.race.state === "paused") g.pause();
      else ui.closeModal();
      if (action === "pit-compound" && !p.requested && p.state === "track")
        g.action("pit");
      if (action === "pit-plan-save")
        ui.toast(
          "Plano salvo: " + (p.plan.join(", ") || "sem paradas programadas"),
        );
      return true;
    }
    case "rebind": {
      const key = data.key;
      ui.toast("Pressione a nova tecla. Esc cancela.");
      g.controls.capture = (code) => {
        if (code === "Escape") return;
        if (!/^(Key[A-Z]|Digit[0-9])$/.test(code)) {
          ui.toast("Use uma letra ou número.");
          return;
        }
        if (
          Object.entries(s.settings.bindings).some(
            ([k, v]) => k !== key && v === code,
          )
        ) {
          ui.toast("Esta tecla já está em uso.");
          return;
        }
        s.settings.bindings[key] = code;
        g.controls.configure(s.settings);
        g.store();
        ui.showModal("settings");
      };
      return true;
    }
    case "reset-career":
      ui.showModal("reset-career");
      return true;
    case "confirm-reset":
      g.save = defaults();
      applySettings();
      g.switchTrack(g.save.settings.track);
      g.store();
      ui.closeModal();
      ui.navigate("home");
      ui.toast("Carreira reiniciada.");
      return true;
    case "exit-race":
      ui.showModal("confirm-exit");
      return true;
    case "confirm-exit":
      g.race = null;
      g.engineer.reset();
      g.controls.clear();
      g.loop.reset();
      ui.closeModal();
      ui.navigate("home");
      return true;
    case "team-upgrade": {
      const cost = 1200 + s.team.development * 700;
      if (
        s.team.development >= 5 ||
        s.upgrades.handling >= 5 ||
        s.credits < cost
      ) {
        ui.toast("Saldo insuficiente ou nível máximo.");
        return true;
      }
      s.credits -= cost;
      s.team.development++;
      s.upgrades.handling = Math.min(5, s.upgrades.handling + 1);
      refresh();
      ui.toast("Desenvolvimento de equipe aplicado ao controle dos carros.");
      return true;
    }
    case "partner":
      if (Number(data.id) === s.selectedDriver) {
        ui.toast("Contrate outro piloto para formar uma dupla.");
        return true;
      }
      if (s.unlockedDrivers.includes(Number(data.id))) {
        s.team.partner = Number(data.id);
        refresh();
      }
      return true;
    case "mega-event":
      if (!s.stats.seasons && !g.admin.active) {
        ui.toast("Complete um campeonato para desafiar Mega Baxter.");
        return true;
      }
      s.settings.mode = "mega";
      s.settings.difficulty = "elite";
      s.settings.realism = "arcade";
      g.store();
      ui.showModal("setup");
      return true;
    case "admin-login":
      ui.showModal("admin-login");
      return true;
    case "admin-enter":
      if (g.admin.enter(g, document.getElementById("admin-password").value)) {
        ui.closeModal();
        ui.navigate("admin");
      } else ui.toast("Senha incorreta.");
      return true;
    case "admin-exit":
      if (g.race) {
        ui.toast("Saia da corrida de teste antes de encerrar o laboratório.");
        return true;
      }
      g.admin.exit(g);
      applySettings();
      g.switchTrack(g.save.settings.track);
      ui.navigate("home");
      return true;
    case "admin-unlock":
      if (g.admin.active) {
        g.admin.unlock(g);
        refresh();
      }
      return true;
    case "admin-credit":
      if (g.admin.active) {
        s.credits = Math.max(
          0,
          Math.min(
            1e8,
            Number(document.getElementById("admin-credits").value) || 0,
          ),
        );
        refresh();
      }
      return true;
    case "admin-reset":
      if (g.admin.active) {
        g.admin.restore(g);
        applySettings();
        g.switchTrack(g.save.settings.track);
        refresh();
      }
      return true;
    case "admin-inspect":
      if (g.admin.active) {
        if (g.race && g.race.state !== "paused") g.pause(true);
        ui.showModal("admin-inspect");
      }
      return true;
    case "admin-damage":
      if (g.admin.active && g.race) {
        g.race.cars[0].damage = 0.65;
        g.race.cars[0].impact = 56;
        if (g.race.cars[0].ruleState) g.race.cars[0].ruleState.peakImpact = 56;
        if (g.race.time <= 8) g.race.time = 10;
        ui.toast("Impacto severo registrado · Safety Car acionado.");
      }
      return true;
    case "admin-pit":
      if (g.admin.active && g.race) {
        g.race.cars[0].pit.requested = true;
        g.race.cars[0].fuel = g.race.cars[0].fuelPerLap;
        ui.toast("Boxes solicitados. Nenhum teletransporte.");
      }
      return true;
    default:
      return false;
  }
}
