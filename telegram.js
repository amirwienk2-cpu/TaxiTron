// Kapselt window.Telegram.WebApp. Läuft die App außerhalb von Telegram
// (z.B. normaler Browser während der Entwicklung), sind tg und initData null —
// main.js zeigt dann einen Hinweis statt einen Absturz zu produzieren.

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

export const Telegram = {
  available: !!tg,

  init() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    try { tg.disableVerticalSwipes(); } catch (e) { /* ältere Client-Version */ }
    try {
      tg.setHeaderColor('#0a0c09');
      tg.setBackgroundColor('#0a0c09');
    } catch (e) { /* ältere Client-Version */ }
  },

  get initData() {
    return tg ? tg.initData : '';
  },

  haptic(style = 'light') {
    if (!tg || !tg.HapticFeedback) return;
    try { tg.HapticFeedback.impactOccurred(style); } catch (e) {}
  },

  notify(type = 'success') {
    if (!tg || !tg.HapticFeedback) return;
    try { tg.HapticFeedback.notificationOccurred(type); } catch (e) {}
  },

  onBack(fn) {
    if (!tg || !tg.BackButton) return () => {};
    tg.BackButton.onClick(fn);
    return () => tg.BackButton.offClick(fn);
  },
  showBack() { if (tg && tg.BackButton) tg.BackButton.show(); },
  hideBack() { if (tg && tg.BackButton) tg.BackButton.hide(); },
};
