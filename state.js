// Minimaler Store: hält den zuletzt vom Server bestätigten Kontostand und
// benachrichtigt alle Listener (HUD, Menü, Wallet) wenn er sich ändert.
// Der Client rechnet Coins/TON NIE selbst hoch — jeder Wert kommt vom Server.

const listeners = new Set();

export const AppState = {
  data: {
    coins: 0,
    ton: 0,
    tonToday: 0,
    dailyCap: 1,
    best: 0,
    runs: 0,
  },

  set(partial) {
    this.data = { ...this.data, ...partial };
    listeners.forEach((fn) => fn(this.data));
  },

  subscribe(fn) {
    listeners.add(fn);
    fn(this.data);
    return () => listeners.delete(fn);
  },
};
