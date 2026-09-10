// Wischsteuerung (primär, für Telegram/Handy) + Pfeiltasten/A-D als
// Bonus-Fallback für Desktop-Tests. Feuert onSwipe(-1 | 1) bei jeder
// erkannten Spurwechsel-Geste.

const SWIPE_THRESHOLD_PX = 32;

export class Input {
  constructor(target, onSwipe) {
    this.target = target;
    this.onSwipe = onSwipe;
    this.startX = null;
    this.startY = null;
    this.handled = false;

    this._onStart = this._onStart.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onEnd = this._onEnd.bind(this);
    this._onKey = this._onKey.bind(this);

    target.addEventListener('touchstart', this._onStart, { passive: true });
    target.addEventListener('touchmove', this._onMove, { passive: true });
    target.addEventListener('touchend', this._onEnd, { passive: true });
    window.addEventListener('keydown', this._onKey);
  }

  _onStart(e) {
    const t = e.touches[0];
    this.startX = t.clientX;
    this.startY = t.clientY;
    this.handled = false;
  }

  _onMove(e) {
    if (this.startX === null || this.handled) return;
    const t = e.touches[0];
    const dx = t.clientX - this.startX;
    const dy = t.clientY - this.startY;
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
      this.handled = true;
      this.onSwipe(dx > 0 ? 1 : -1);
    }
  }

  _onEnd() {
    this.startX = null;
    this.startY = null;
  }

  _onKey(e) {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.onSwipe(-1);
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.onSwipe(1);
  }

  dispose() {
    this.target.removeEventListener('touchstart', this._onStart);
    this.target.removeEventListener('touchmove', this._onMove);
    this.target.removeEventListener('touchend', this._onEnd);
    window.removeEventListener('keydown', this._onKey);
  }
}
