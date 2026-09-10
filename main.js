import { TaxiRunner } from './game.js';
import { GameAudio } from './audio.js';

const $ = id => document.getElementById(id);
const ui = { menu:$('menu'), gameover:$('gameover'), score:$('score'), coins:$('coins'), speed:$('speed'), toast:$('toast'), hint:$('swipe-hint'), pause:$('pause'), mute:$('mute'), final:$('final-score'), record:$('record') };
const audio = new GameAudio();
let highScore = Number(localStorage.getItem('taxiRushHighScore') || 0);
let toastTimer;

const game = new TaxiRunner($('game-container'), {
  onUpdate(score, coins, speed) {
    ui.score.textContent = String(score).padStart(5,'0');
    ui.coins.textContent = coins;
    ui.speed.textContent = `${Math.round(speed * 3.6)} KM/H`;
  },
  onMove(dir) { audio.tick(dir > 0 ? 390 : 310); ui.hint.style.opacity='0'; },
  onCoin() {
    audio.play('coin'); ui.toast.textContent='+100'; ui.toast.classList.remove('show');
    requestAnimationFrame(()=>ui.toast.classList.add('show')); clearTimeout(toastTimer); toastTimer=setTimeout(()=>ui.toast.classList.remove('show'),350);
  },
  onCrash(score) {
    audio.play('crash'); ui.final.textContent=score;
    const isRecord=score>highScore; if(isRecord){highScore=score;localStorage.setItem('taxiRushHighScore',String(highScore));}
    ui.record.textContent=isRecord?'★ NEUER HIGHSCORE!':`HIGHSCORE ${highScore}`;
    setTimeout(()=>ui.gameover.classList.remove('hidden'),650);
  }
});

function begin(){ audio.unlock();ui.menu.classList.add('hidden');ui.gameover.classList.add('hidden');ui.hint.style.opacity='1';ui.pause.textContent='Ⅱ';game.start(); }
$('start').addEventListener('click',begin); $('restart').addEventListener('click',begin);
ui.pause.addEventListener('click',()=>{const paused=game.togglePause();ui.pause.textContent=paused?'▶':'Ⅱ';audio.tick(paused?220:440);});
ui.mute.addEventListener('click',()=>{const muted=audio.toggle();ui.mute.textContent=muted?'×':'♫';});
document.querySelectorAll('.swatch').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.swatch').forEach(b=>b.classList.remove('selected'));button.classList.add('selected');game.setTaxiColor(button.dataset.color);audio.tick(460);}));

document.addEventListener('visibilitychange',()=>{if(document.hidden&&game.running&&!game.paused){game.togglePause();ui.pause.textContent='▶';}});
