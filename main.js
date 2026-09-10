import { Api } from './api.js';
import { AppState } from './state.js';
import { Telegram } from './telegram.js';
import { Game } from './game/Game.js';
import * as UI from './ui.js';

async function boot() {
  UI.showLoader('Verbinde…');
  Telegram.init();

  if (!Telegram.available || !Telegram.initData) {
    UI.showLoader('Bitte öffne die App über deinen Telegram-Bot.');
    return;
  }

  let state;
  try {
    if (Api.hasToken()) {
      state = await Api.state();
    } else {
      throw new Error('no-token');
    }
  } catch (e) {
    try {
      state = await Api.auth(Telegram.initData);
    } catch (err) {
      UI.showLoader(`Anmeldung fehlgeschlagen: ${err.message}`);
      return;
    }
  }
  AppState.set(state);

  const canvas = document.getElementById('game-canvas');
  const game = new Game(canvas, {
    onHud: UI.updateHud,
    onFinish: (result) => onRunFinished(game, result),
  });

  UI.initUI({
    onPlay: () => {
      UI.showHud();
      game.start();
    },
  });

  UI.showMenu();
}

async function onRunFinished(game, { distance, zombies }) {
  // Für die Rangliste zählt jeder Lauf sofort, unabhängig vom Einlösen.
  Api.submitScore(distance, zombies).catch(() => {});

  UI.showSummary({ distance, zombies }, async () => {
    const res = await Api.run(distance, zombies);
    AppState.set(res.state);
    return res;
  });
}

boot();
