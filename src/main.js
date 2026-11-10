import "./ui/manager.css";
import "./style.css";
import "./ui/extras.css";
import "./ui/race.css";
import "./ui/competitions.css";
import "./ui/ranking.css";
import { Game } from "./core/Game.js";

// Keep the original synchronous Game creation; assets/shader readiness is async.
(async () => {
  const loading = document.getElementById("boot-loading");
  try {
    const game = new Game();
    if (new URLSearchParams(location.search).has("test")) window.__game = game;
    await game.world.ready;
    loading?.remove();
    if (game.world.assetErrors.length)
      game.ui.toast(
        "Alguns recursos não carregaram. Verifique a conexão e recarregue; detalhes no console.",
      );
  } catch (error) {
    console.error("Falha na preparação do jogo", error);
    loading.replaceChildren();
    const text = document.createElement("p");
    text.textContent =
      "Não foi possível preparar o jogo. Verifique WebGL/aceleração gráfica e o carregamento dos recursos.";
    const retry = document.createElement("button");
    retry.textContent = "TENTAR NOVAMENTE";
    retry.onclick = () => location.reload();
    loading.append(text, retry);
  }
})();
