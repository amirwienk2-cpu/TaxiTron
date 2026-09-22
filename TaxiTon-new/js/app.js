// Telegram Mini App hooks (only active inside Telegram)
try{
  const tg=window.Telegram&&window.Telegram.WebApp;
  if(tg){
    tg.ready();
    tg.expand();
    if(typeof tg.disableVerticalSwipes==='function'&&(!tg.isVersionAtLeast||tg.isVersionAtLeast('7.7'))) tg.disableVerticalSwipes();
  }
}catch(e){console.warn('[TaxiTron] Telegram WebApp initialization failed',e)}


// Language (flags above the play button)
const I18N={
 fa:{h1t:'کنترل ماشین',h1:'کلید های جهت نما، A/D یا کشیدن انگشت برای تغییر مسیر',h2t:'زامبی‌ها رو نابود کن',h2:'هرچقد زامبی بیشتری نابود کنی درامدت بیشتر میشه',h3t:'برخورد نکن!',h3:'از برخورد با ماشین های دیگر خودداری کن - یک برخورد به مسیر پایان میدهد.',h4t:'معاوضه با سکه',h4:'زامبی های جمع شده را در کیف پول با سکه معاوضه کن',h4b:'(۱۰۰ سکه به ازای هر زامبی)',pw:'در مسیر بازی، آیتم‌های قدرتی قرار دارند که با برخورد تاکسی، فعال می‌شوند.',invDesc:'کاربران واقعی تلگرام را با لینک شخصی خود دعوت کنید. ۳ بازیکنی که بیشترین دعوت را داشته باشند TON می‌برند! 🥇 ۲۰ TON · 🥈 ۱۰ TON · 🥉 ۵ TON',invTime:'زمان کمپین تا',invEnded:'کمپین پایان یافت',ivYourRank:'رتبه شما',ivInvites:'دعوت',ivNoInvites:'هنوز کسی دعوت نشده. اولین نفر باشید!',ivSettled:'کمپین پایان یافت · جوایز برندگان پرداخت شد.',invBtn:'از طریق لینک خود دعوت کنید',invShare:'به من در تاکسی‌ترون بپیوند! 🚕🧟',tkDesc2:'برای انجام این وظیفه در کانال رسمی تاکسی‌تون عضو شوید.',designer:'دیزاینر',m3:'رنگ‌ها و آیکون‌های جدید فردا می‌آیند 🎨',admin:'ادمین',onlineShort:'آنلاین',onlineUsers:'کاربران آنلاین:',howT:'آموزش بازی',sBest:'بهترین امتیاز',sRoutes:'تعداد مسیرها',sLevel:'سطح',tonLeft:'TON باقی‌مانده',lvlWord:'سطح',triesLeft:'تلاش باقی‌مانده',tkJoinAll:'عضویت در کانال‌ها',tkDescAll:'برای انجام این وظیفه در کانال‌های زیر عضو شوید.',tkRewardAll:'پاداش هر کانال: +{n} زامبی',tkJoin:'عضویت در',tkDesc:'برای انجام این وظیفه در کانال اخبار برداشت عضو شوید.',tkReward:'پاداش: +{n} زامبی',tkOpen:'باز کردن کانال تلگرام',tkCheck:'بررسی عضویت',tkDone:'انجام شد. +{n} زامبی به کیف پول شما اضافه شد.',tkNo:'هنوز عضو کانال نشده‌اید.',bal:'موجودی',daily:'سقف روزانه',soon:'به‌زودی',buyLv:'خرید سطح',skins:'اسکین چت',level:'لول',coinsShort:'سکه',buy:'خرید',owned:'خریداری شد',use:'استفاده',inUse:'فعال',free:'رایگان',hi:'سلام!',sk_yellow:'زرد',sk_red:'قرمز',sk_white:'سفید',sk_green:'سبز',sk_black:'مشکی',sk_platinum:'پلاتینیوم',youTag:'شما',lbEmpty:'هنوز کسی امتیاز نگرفته',langs:'زبان‌ها',chat:'چت',chatT:'چت راننده‌ها',m1:'کی امروز بیشتر از ۵۰۰ تا زامبی زده؟',m2:'من! فقط ۱۰ امتیاز تا مقام اول مونده 🔥',chatPh:'پیام بنویس…',send:'ارسال',me:'من',game:'بازی‌ها',tasks:'تسک‌ها',home:'خانه',shop:'فروشگاه',play:'بازی',tour:'مسابقه',wallet:'کیف پول',homeT:'تاکسی‌ترون',homeP:'خوش اومدی راننده! سکه جمع کن، زامبی بزن و تو مسابقه هفتگی TON ببر.',coins:'سکه‌ها',zweek:'زامبی‌های این هفته',shopP:'تاکسی‌ها و ارتقاها به‌زودی اینجا اضافه می‌شن.',gameP:'حالت‌های بازی و مراحل.',playP:'سوار تاکسی شو و تا می‌تونی زامبی جمع کن.',start:'شروع بازی',walletP:'کیف پول TON خودت رو وصل کن تا جایزه‌ها رو دریافت کنی.',connect:'اتصال کیف پول',t1:'عضویت در کانال',t2:'دعوت از دوستان',t3:'ورود روزانه',t4:'تماشای ۱۰ ویدیو',adsDesc:'با تماشای ۱۰ ویدیوی جایزه‌دار، مجموعاً ۰.۰۳ TON دریافت کن.',watchVideo:'مشاهده ویدیو',adsCompleted:'انجام شد',adsDone:'انجام شد. ۰.۰۳ TON به موجودی شما اضافه شد.',adsNotReady:'برای تماشای ویدیوهای جایزه‌دار، این اپ را داخل تلگرام باز کنید.',adsFailed:'ویدیو کامل نشد. جایزه‌ای اضافه نشد.',d:'ر',h:'س',m:'م',
  skinPerDay:'روز',skinPerDayFor:'در روز به مدت',skinDays:'روز',skinDaysLeft:'روز باقی‌مانده',skinRewardActive:'پاداش روزانه فعال است',skinTodayLeft:'امروز: {amount} تون باقی‌مانده',skinRewardOffer:'پاداش روزانه تون دریافت کنید',skinNeedMore:'{amount} تون دیگر برای باز کردن لازم است'},
 de:{h1t:'Taxi steuern',h1:'Pfeiltasten, A/D oder Wischen zum Spurwechsel',h2t:'Sammle Zombies',h2:'Je mehr Zombies mitfahren, desto schneller wird dein Auto.',h3t:'Kein Unfall!',h3:'Weiche anderen Autos aus – ein Zusammenstoß beendet die Fahrt.',h4t:'Gegen Münzen tauschen',h4:'Tausche deine Zombies in der Wallet gegen Münzen',h4b:'(100 Münzen pro Zombie)',pw:'Auf der Strecke liegen Power-up-Items, die aktiviert werden, sobald das Taxi sie berührt.',invDesc:'Lade echte Telegram-Nutzer mit deinem Link ein. Die Top 3 der Einlader gewinnen TON! 🥇 20 TON · 🥈 10 TON · 🥉 5 TON',invTime:'Kampagne endet in',invEnded:'Kampagne beendet',ivYourRank:'Dein Rang',ivInvites:'Einladungen',ivNoInvites:'Noch keine Einladungen. Sei der Erste!',ivSettled:'Kampagne beendet · Gewinner wurden ausgezahlt.',invBtn:'Mit deinem Link einladen',invShare:'Spiel mit mir TaxiTron! 🚕🧟',tkDesc2:'Tritt für diese Aufgabe dem offiziellen TaxiTon-Kanal bei.',designer:'Designer',m3:'Neue Farben und Icons kommen morgen 🎨',admin:'Admin',onlineShort:'Online',onlineUsers:'Nutzer online:',howT:'Anleitung',sBest:'Rekord',sRoutes:'Fahrten',sLevel:'Level',tonLeft:'TON übrig',lvlWord:'Level',triesLeft:'Versuche übrig',tkJoinAll:'Kanäle beitreten',tkDescAll:'Tritt für diese Aufgabe den folgenden Kanälen bei.',tkRewardAll:'Belohnung pro Kanal: +{n} Zombies',tkJoin:'Tritt bei',tkDesc:'Tritt für diese Aufgabe dem Kanal „Auszahlungs-News“ bei.',tkReward:'Belohnung: +{n} Zombies',tkOpen:'Telegram-Kanal öffnen',tkCheck:'Mitgliedschaft prüfen',tkDone:'Erledigt. +{n} Zombies zu deiner Wallet hinzugefügt.',tkNo:'Du bist noch kein Mitglied des Kanals.',bal:'Guthaben',daily:'Tageslimit',soon:'Demnächst',buyLv:'Level kaufen',skins:'Chat-Skins',level:'Level',coinsShort:'Münzen',buy:'Kaufen',owned:'Gekauft',use:'Benutzen',inUse:'Aktiv',free:'Gratis',hi:'Hallo!',sk_yellow:'Gelb',sk_red:'Rot',sk_white:'Weiß',sk_green:'Grün',sk_black:'Schwarz',sk_platinum:'Platin',youTag:'Du',lbEmpty:'Noch keine Punkte',langs:'Sprachen',chat:'Chat',chatT:'Fahrer-Chat',m1:'Wer hat heute mehr als 500 Zombies erwischt?',m2:'Ich! Nur noch 10 Punkte bis Platz 1 🔥',chatPh:'Nachricht schreiben…',send:'Senden',me:'Ich',game:'Spiele',tasks:'Aufgaben',home:'Start',shop:'Shop',play:'Spielen',tour:'Turnier',wallet:'Wallet',homeT:'TaxiTron',homeP:'Willkommen, Fahrer! Sammle Münzen, erwisch Zombies und gewinne TON im Wochenturnier.',coins:'Münzen',zweek:'Zombies diese Woche',shopP:'Taxis und Upgrades kommen hier bald.',gameP:'Spielmodi und Level.',playP:'Steig ins Taxi und sammle so viele Zombies wie möglich.',start:'Spiel starten',walletP:'Verbinde deine TON-Wallet, um Preise zu erhalten.',connect:'Wallet verbinden',t1:'Kanal beitreten',t2:'Freunde einladen',t3:'Täglicher Login',t4:'Sieh dir 10 Videos an',adsDesc:'Sieh dir 10 Bonus-Videos an und erhalte insgesamt 0,03 TON.',watchVideo:'Video ansehen',adsCompleted:'Erledigt',adsDone:'Erledigt. 0,03 TON wurden deinem Guthaben hinzugefügt.',adsNotReady:'Öffne das Spiel in Telegram, um Bonus-Videos anzusehen.',adsFailed:'Video wurde nicht abgeschlossen. Keine Belohnung hinzugefügt.',d:'T',h:'h',m:'min',
  skinPerDay:'Tag',skinPerDayFor:'pro Tag für',skinDays:'Tage',skinDaysLeft:'Tage übrig',skinRewardActive:'Tägliche Belohnung aktiv',skinTodayLeft:'Heute: {amount} TON übrig',skinRewardOffer:'Verdiene eine tägliche TON-Belohnung',skinNeedMore:'Noch {amount} TON nötig zum Freischalten'},
 en:{h1t:'Steer your taxi',h1:'Arrow keys, A/D or swipe to change lanes',h2t:'Collect zombies',h2:'The more zombies ride with you, the faster your car gets.',h3t:"Don't crash!",h3:'Avoid other cars – one crash ends the run.',h4t:'Swap for coins',h4:'Exchange your zombies for coins in the wallet',h4b:'(100 coins per zombie)',pw:'There are power-up items on the route that activate when the taxi hits them.',invDesc:'Invite real Telegram users with your personal link. The top 3 inviters win TON! 🥇 20 TON · 🥈 10 TON · 🥉 5 TON',invTime:'Campaign ends in',invEnded:'Campaign ended',ivYourRank:'Your rank',ivInvites:'invites',ivNoInvites:'No invites yet. Be the first!',ivSettled:'Campaign ended · winners have been paid out.',invBtn:'Invite with your link',invShare:'Join me in TaxiTron! 🚕🧟',tkDesc2:'Join the official TaxiTon channel to complete this task.',designer:'Designer',m3:'New colors and icons are coming tomorrow 🎨',admin:'Admin',onlineShort:'Online',onlineUsers:'Users online:',howT:'How to play',sBest:'Best score',sRoutes:'Routes',sLevel:'Level',tonLeft:'TON left',lvlWord:'Level',triesLeft:'Tries left',tkJoinAll:'Join channels',tkDescAll:'Join the channels below to complete this task.',tkRewardAll:'Reward per channel: +{n} zombies',tkJoin:'Join',tkDesc:'Join the withdrawal news channel to complete this task.',tkReward:'Reward: +{n} zombies',tkOpen:'Open Telegram channel',tkCheck:'Check membership',tkDone:'Completed. +{n} Zombies added to your wallet.',tkNo:'You have not joined the channel yet.',bal:'Balance',daily:'Daily limit',soon:'Coming soon',buyLv:'Buy levels',skins:'Chat skins',level:'Level',coinsShort:'coins',buy:'Buy',owned:'Owned',use:'Use',inUse:'Active',free:'Free',hi:'Hi!',sk_yellow:'Yellow',sk_red:'Red',sk_white:'White',sk_green:'Green',sk_black:'Black',sk_platinum:'Platinum',youTag:'You',lbEmpty:'No scores yet',langs:'Languages',chat:'Chat',chatT:'Drivers chat',m1:'Who hit more than 500 zombies today?',m2:'Me! Only 10 points left to first place 🔥',chatPh:'Write a message…',send:'Send',me:'Me',game:'Game',tasks:'Tasks',home:'Home',shop:'Shop',play:'Play',tour:'Tournament',wallet:'Wallet',homeT:'TaxiTron',homeP:'Welcome, driver! Collect coins, hit zombies and win TON in the weekly tournament.',coins:'Coins',zweek:'Zombies this week',shopP:'Taxis and upgrades are coming here soon.',gameP:'Game modes and levels.',playP:'Hop in your taxi and collect as many zombies as you can.',start:'Start game',walletP:'Connect your TON wallet to receive prizes.',connect:'Connect wallet',t1:'Join the channel',t2:'Invite friends',t3:'Daily login',t4:'Watch 10 videos',adsDesc:'Watch 10 rewarded videos and receive 0.03 TON in total.',watchVideo:'Watch video',adsCompleted:'Completed',adsDone:'Completed. 0.03 TON was added to your balance.',adsNotReady:'Open the game in Telegram to watch rewarded videos.',adsFailed:'Video was not completed. No reward was added.',d:'d',h:'h',m:'m',
  skinPerDay:'day',skinPerDayFor:'per day for',skinDays:'days',skinDaysLeft:'days left',skinRewardActive:'Daily reward active',skinTodayLeft:'Today: {amount} TON left',skinRewardOffer:'Earn a daily TON reward',skinNeedMore:'Need {amount} TON more to unlock'}
};
Object.assign(I18N.fa,{levelLocked:'قفل شده',randomWinner:'{name} برنده رندوم شد: ۰.۰۰۱ TON 🎉'});
Object.assign(I18N.de,{levelLocked:'Gesperrt',randomWinner:'{name} hat random gewonnen: 0.001 TON 🎉'});
Object.assign(I18N.en,{levelLocked:'Locked',randomWinner:'{name} won the random draw: 0.001 TON 🎉'});
let lang='fa'; try{lang=localStorage.getItem('tt_lang')||'fa'}catch(e){}
const T=()=>I18N[lang];
const nf=n=>lang==='fa'?String(n).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]):String(n);
const TOURNAMENT_ART={
  fa:{src:'../sprites/turnier-fa.jpg',alt:'مسابقه زامبی'},
  de:{src:'../sprites/turnier-de.jpg',alt:'Zombie-Wettbewerb'},
  en:{src:'../sprites/turnier-en.jpg',alt:'Zombie Competition'}
};
function applyLang(){
  document.body.classList.toggle('en',lang!=='fa');document.documentElement.lang=lang;
  const tournamentArt=document.getElementById('tournamentArt');
  if(tournamentArt){
    const art=TOURNAMENT_ART[lang]||TOURNAMENT_ART.en;
    tournamentArt.src=art.src;tournamentArt.alt=art.alt;
  }
  document.querySelectorAll('[data-i]').forEach(el=>{const v=T()[el.dataset.i]; if(v) el.textContent=v;});
  document.querySelectorAll('[data-i-html]').forEach(el=>{const v=T()[el.dataset.iHtml]; if(v) el.innerHTML=v;});
  document.querySelectorAll('[data-ph]').forEach(el=>{el.placeholder=T()[el.dataset.ph]});
  document.querySelectorAll('.flag').forEach(f=>{f.classList.toggle('on',f.dataset.lang===lang);f.setAttribute('aria-pressed',f.dataset.lang===lang)});
  document.querySelectorAll('[data-n]').forEach(el=>{el.textContent=lang==='fa'?el.dataset.n.replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]):el.dataset.n});
  if(typeof renderShop==='function') renderShop();
  if(typeof renderHome==='function' && typeof HOME!=='undefined') renderHome();
  if(typeof renderOnline==='function') renderOnline();
  if(typeof renderChatBadges==='function') renderChatBadges();
  if(typeof renderRandomWinnerMessages==='function') renderRandomWinnerMessages();
  if(typeof renderTask==='function') renderTask();
  if(typeof renderAdsTask==='function') renderAdsTask();
  if(typeof renderInviteLeaderboard==='function') renderInviteLeaderboard(IV_LAST_DATA);
  if(typeof tick==='function') tick();
}
const flagBox=document.querySelector('.flags');
document.querySelectorAll('.flag').forEach(f=>f.addEventListener('click',e=>{
  e.stopPropagation();
  if(!flagBox.classList.contains('open')){flagBox.classList.add('open');return;}   // 1. tap: open list
  lang=f.dataset.lang;try{localStorage.setItem('tt_lang',lang)}catch(e){}           // 2. tap: choose
  flagBox.classList.remove('open');applyLang();
}));
document.addEventListener('click',()=>flagBox.classList.remove('open'));

// Wallet / Tasks switch
// (works for every page with a .seg switch: Wallet/Tasks, Shop)
document.querySelectorAll('.seg-btn').forEach(b=>b.addEventListener('click',()=>{
  const sec=b.closest('.screen');
  sec.querySelectorAll('.seg-btn').forEach(x=>{x.classList.toggle('on',x===b);x.setAttribute('aria-selected',x===b)});
  sec.querySelectorAll('.sub').forEach(s=>s.classList.toggle('on',s.id==='sub-'+b.dataset.sub));
}));

// Chat (local demo – connect to your server later)
const chatList=document.getElementById('chatList'), chatText=document.getElementById('chatText');
function scrollChatToEnd(smooth=true){
  chatList.scrollTo({top:chatList.scrollHeight,behavior:smooth?'smooth':'auto'});
}
// Keep the chat pinned to the REAL visible area (visualViewport), not just 100dvh:
// on some mobile WebViews (incl. Telegram's), the on-screen keyboard overlays the page
// instead of shrinking the layout viewport, so 100dvh alone can leave the input box + the
// message right above it hidden behind the keyboard while the user is typing. Tracking
// visualViewport.height keeps the chat column sized to what's actually visible, and
// re-scrolling to the bottom whenever the keyboard opens/closes keeps the last message in view.
function applyChatViewportHeight(){
  if(!window.visualViewport) return;
  document.documentElement.style.setProperty('--app-vh', window.visualViewport.height+'px');
}
if(window.visualViewport){
  applyChatViewportHeight();
  window.visualViewport.addEventListener('resize',()=>{
    applyChatViewportHeight();
    if(document.body.classList.contains('chat-open')) requestAnimationFrame(()=>scrollChatToEnd(false));
  });
}
chatText.addEventListener('focus',()=>requestAnimationFrame(()=>scrollChatToEnd(false)));
// chatText is a <textarea> (not a single-line <input>) so a long message wraps onto multiple
// visible lines instead of scrolling its own content sideways/forward and hiding what was
// already typed. It grows with the content up to CHAT_INPUT_MAX_HEIGHT, then scrolls
// internally like a normal textarea. Growing it also shrinks the message list (flex:1)
// above it, so we re-pin the last message into view every time it grows.
const CHAT_INPUT_MAX_HEIGHT=140;
function autoGrowChatInput(){
  chatText.style.height='auto';
  chatText.style.height=Math.min(chatText.scrollHeight,CHAT_INPUT_MAX_HEIGHT)+'px';
  if(document.body.classList.contains('chat-open')) scrollChatToEnd(false);
}
chatText.addEventListener('input',autoGrowChatInput);
// When TT.onSendMessage is wired to a real server (see server-bridge.js), the message is only
// rendered (via TT.addMessage) after the server confirms it - no local-only fabricated bubble.
// Without a server hook (pure demo/offline), it still renders immediately as before.
function sendMsg(){
  const v=chatText.value.trim(); if(!v) return;
  if(typeof chatBlocked==='function' && chatBlocked()) return;   // muted / chat-banned by an admin
  if(editing){ finishEdit(v); return; }                              // editing an own message
  const rep=replyTo;
  if(typeof TT.onSendMessage==='function'){
    chatText.value=''; autoGrowChatInput(); cancelReply();
    try{ Promise.resolve(TT.onSendMessage({text:v, replyTo:rep})).catch(()=>{}); }catch(e){}
    return;
  }
  const d=document.createElement('div'); d.className='msg me skin-'+skin;
  const b=document.createElement('b'); b.textContent=T().me; const s=document.createElement('span'); s.textContent=v;
  d.append(b); if(rep) d.append(buildQuote(rep)); d.append(s);
  chatList.append(d); decorateMsg(d); chatText.value=''; autoGrowChatInput(); cancelReply(); scrollChatToEnd();
}
document.getElementById('chatSend').addEventListener('click',sendMsg);
// Enter sends the message (matches the old single-line input's behavior); Shift+Enter
// still inserts a newline, like Telegram/WhatsApp, now that this is a growable textarea.
chatText.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } });

// Shop – real car skins/levels from the server (POST /api/buy-skin: red=1 TON->lvl2,
// white=3 TON->lvl3, green=10 TON->lvl4). 'yellow' is the free default everyone owns.
// The "Chat Skins" tab lets you pick which OWNED skin decorates your own chat bubbles -
// that active choice has no server field, so it stays a local (client-only) preference,
// same as the language picker; the list itself always reflects real server ownership.
// dailyReward/rewardDays mirror the server's real skinRewards system (server.js: rewardDays,
// LEVEL_TWO/THREE/FOUR_DAILY_PTS_CAP) - same values the legacy game shows.
const SKINS=[
  {id:'yellow',price:0,level:1,dailyReward:0,   rewardDays:0},
  {id:'red',   price:1,level:2,dailyReward:0.067,rewardDays:30},
  {id:'white', price:3,level:3,dailyReward:0.2, rewardDays:30},
  {id:'green', price:10,level:4,dailyReward:0.66,rewardDays:30},
  {id:'black', price:0,level:5,soon:true,dailyReward:0,rewardDays:0},
  {id:'platinum',price:0,level:6,soon:true,dailyReward:0,rewardDays:0}];
const store=(k,v)=>{try{if(v===undefined)return JSON.parse(localStorage.getItem(k));localStorage.setItem(k,JSON.stringify(v))}catch(e){return null}};
let SHOP={ton:0,level:1,ownedSkins:['yellow'],skinRewards:{},tonTodayByLevel:{1:0,2:0,3:0,4:0}};
let skin=store('tt_skin')||'yellow';
const num=n=>lang==='fa'?String(n).replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]):String(n);
const SKIN_IMG={yellow:'assets/images/level1.jpg',red:'assets/images/level2.jpg',white:'assets/images/level3.jpg',green:'assets/images/level4.jpg',black:'assets/images/level5.jpg',platinum:'assets/images/level6.jpg'};
// Per-level driver ability info shown in the "?" popup on each level card.
// Fill in real texts per skin id once available (fa/de/en); falls back to a "coming soon" note.
const LV_INFO={fa:{},de:{},en:{}};
// If a skin id has an image per language here, the popup shows that image instead of the text above.
const LV_INFO_IMG={yellow:{fa:'assets/images/ability/ability1_fa.jpg',de:'assets/images/ability/ability1_de.jpg',en:'assets/images/ability/ability1_en.jpg'},red:{fa:'assets/images/ability/ability2_fa.jpg',de:'assets/images/ability/ability2_de.jpg',en:'assets/images/ability/ability2_en.jpg'},white:{fa:'assets/images/ability/ability3_fa.jpg',de:'assets/images/ability/ability3_de.jpg',en:'assets/images/ability/ability3_en.jpg'},green:{fa:'assets/images/ability/ability4_fa.jpg',de:'assets/images/ability/ability4_de.jpg',en:'assets/images/ability/ability4_en.jpg'}};
const LOCK='<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff07a"/><stop offset=".55" stop-color="#ffc21a"/><stop offset="1" stop-color="#d97f00"/></linearGradient></defs><path d="M20 28v-8a12 12 0 0 1 24 0v8" fill="none" stroke="#1a1206" stroke-width="10" stroke-linecap="round"/><path d="M20 28v-8a12 12 0 0 1 24 0v8" fill="none" stroke="url(#lk)" stroke-width="5" stroke-linecap="round"/><rect x="11" y="27" width="42" height="31" rx="7" fill="url(#lk)" stroke="#1a1206" stroke-width="4"/><circle cx="32" cy="40" r="4.5" fill="#1a1206"/><rect x="30" y="41" width="4" height="9" rx="2" fill="#1a1206"/></svg>';
// Mirrors the server's real daily TON-earning caps per level (server.js: DAILY_PTS_CAP and
// LEVEL_TWO/THREE/FOUR_DAILY_PTS_CAP) - not exposed via any endpoint, so duplicated here only
// to render the reward progress bar, same approach as server-bridge.js's own copy.
const DAILY_CAP_BY_LEVEL={1:1,2:0.067,3:0.2,4:0.66};
const fmtTon=n=>(Math.round(n*100)/100).toString().replace(/\.0+$/,'').replace(/(\.\d*[1-9])0+$/,'$1');
const fmtTonOnline=n=>{ n=Number(n)||0; return n<=0?'0.0000':fmtTon(n); };
function currentActiveLevel(){
  const stored=Number(store('tt_active_level'))||0;
  const storedDef=SKINS.find(s=>s.level===stored);
  const ownsPremium=SHOP.ownedSkins.some(id=>SKINS.some(s=>s.id===id&&s.level>=2&&!s.soon));
  if(storedDef&&SHOP.ownedSkins.includes(storedDef.id)&&!(stored===1&&ownsPremium)) return stored;
  return SKINS.reduce((highest,s)=>SHOP.ownedSkins.includes(s.id)&&!s.soon&&s.level>highest?s.level:highest,1);
}
function renderShop(){
  const owns=id=>SHOP.ownedSkins.includes(id);
  const active=currentActiveLevel();
  const ownsPremium=SHOP.ownedSkins.some(id=>SKINS.some(s=>s.id===id&&s.level>=2&&!s.soon));
  document.getElementById('levelList').innerHTML=SKINS.map(s=>{
    const has=owns(s.id);
    const lock=s.soon?`<div class="lock">${LOCK}<span>${T().soon}</span></div>`:'';
    const pic=`<div class="lvpic"><img src="${SKIN_IMG[s.id]||''}" alt="${T().level} ${num(s.level)}" loading="lazy">${lock}<button type="button" class="lv-info" data-info-lv="${s.level}" data-info-sk="${s.id}" aria-label="Info">?</button></div>`;
    const isActive=has&&s.level===active;
    const isLocked=has&&s.level===1&&ownsPremium;
    const btn=s.soon?`<button class="btn buy" disabled>${T().soon}</button>`
      :isLocked?`<button class="btn buy" disabled>${T().levelLocked}</button>`
      :has?`<button class="btn buy" data-select-lv="${s.level}" ${isActive?'disabled':''}>${isActive?T().inUse:T().use}</button>`
      :`<button class="btn buy" data-lv="${s.id}">${T().buy}</button>`;
    const rewardTag=(!s.soon&&s.dailyReward>0)?`<span class="lv-reward-tag">⚡ +${fmtTon(s.dailyReward)} TON/${T().skinPerDay}</span>`:'';
    let rewardBox='';
    if(!s.soon&&s.dailyReward>0){
      const reward=SHOP.skinRewards[s.id];
      const remainingDays=Number(reward&&reward.remainingDays||0);
      if(has&&remainingDays>0){
        const todayNow=Number(SHOP.tonTodayByLevel[s.level]||0);
        const cap=DAILY_CAP_BY_LEVEL[s.level]||0;
        const todayRemaining=Math.max(0,cap-todayNow);
        const pct=cap>0?Math.max(0,Math.min(100,Math.round((todayNow/cap)*100))):0;
        rewardBox=`<div class="lv-reward-box active">
          <div class="lv-reward-row"><span>🎁 ${T().skinRewardActive}</span><span>${num(remainingDays)} ${T().skinDaysLeft}</span></div>
          <div class="lv-reward-track"><div class="lv-reward-fill" style="width:${pct}%"></div></div>
          <div class="lv-reward-hint">${T().skinTodayLeft.replace('{amount}',fmtTon(todayRemaining))}</div>
        </div>`;
      } else if(!has){
        rewardBox=`<div class="lv-reward-box">
          <div class="lv-reward-row"><span>🎁 ${T().skinRewardOffer}</span></div>
          <div class="lv-reward-hint">+${fmtTon(s.dailyReward)} TON ${T().skinPerDayFor} ${num(s.rewardDays)} ${T().skinDays}</div>
        </div>`;
      }
    }
    return `<div class="lvcard${has?' has':''}${s.soon?' soon':''}">${pic}
      <div class="lvbar"><span class="price">${s.soon?'':(s.price?num(s.price)+' TON':T().free)}${rewardTag}</span>
      ${btn}</div>${rewardBox}</div>`;}).join('');
  // Chat skins aren't for sale yet - just show a single locked "coming soon" placeholder.
  document.getElementById('skinList').innerHTML=`<div class="lv-info-soon skins-soon"><div class="lv-info-soon-lock">${LOCK}</div>
    <div class="lv-info-soon-txt">${T().soon}</div></div>`;
}
document.getElementById('shop').addEventListener('click',e=>{
  const info=e.target.closest('.lv-info');
  if(info){ openLvInfo(Number(info.dataset.infoLv),info.dataset.infoSk); return; }
  const b=e.target.closest('.buy'); if(!b||b.disabled) return;
  if(b.dataset.sk){ skin=b.dataset.sk; store('tt_skin',skin); renderShop(); return; }
  if(b.dataset.selectLv){
    const lvl=Number(b.dataset.selectLv);
    if(lvl===1&&SHOP.ownedSkins.some(id=>SKINS.some(s=>s.id===id&&s.level>=2&&!s.soon))) return;
    if(typeof TT.selectLevel==='function') TT.selectLevel(lvl);
    store('tt_active_level',lvl);
    renderShop();
    return;
  }
  if(b.dataset.lv){
    if(typeof TT.buySkin!=='function') return;
    b.disabled=true;
    TT.buySkin(b.dataset.lv).then(r=>{
      if(!r||!r.ok){ toast(r&&r.error==='insufficient-funds'?T().wdNoFunds:T().buyErr); }
      else{
        // Newly bought level becomes the active one, exactly like the old
        // design's shop (buying always also equips) - so also tell the
        // embedded game to switch immediately, not just update this UI.
        const def=SKINS.find(s=>s.id===b.dataset.lv);
        if(def){ store('tt_active_level',def.level); if(typeof TT.selectLevel==='function') TT.selectLevel(def.level); }
      }
      renderShop();
    });
  }
});
// "?" popup with per-level driver info (fa/de/en text, filled in via LV_INFO once available)
let lvInfoSheet=null;
function buildLvInfoSheet(){
  lvInfoSheet=document.createElement('div'); lvInfoSheet.className='adm-sheet lv-info-sheet'; lvInfoSheet.hidden=true;
  lvInfoSheet.innerHTML='<div class="as-back"></div><div class="as-panel" role="dialog" aria-modal="true" aria-labelledby="lvInfoName">'+
    '<div class="as-head"><b id="lvInfoName"></b><button type="button" class="as-x" aria-label="close">✕</button></div>'+
    '<div class="lv-info-body"></div></div>';
  document.body.append(lvInfoSheet);
  lvInfoSheet.querySelector('.as-back').addEventListener('click',closeLvInfo);
  lvInfoSheet.querySelector('.as-x').addEventListener('click',closeLvInfo);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!lvInfoSheet.hidden) closeLvInfo(); });
}
function openLvInfo(level,skinId){
  if(!lvInfoSheet) buildLvInfoSheet();
  lvInfoSheet.querySelector('.as-x').setAttribute('aria-label',T().aClose);
  const body=lvInfoSheet.querySelector('.lv-info-body');
  const imgSet=LV_INFO_IMG[skinId];
  const img=imgSet&&(imgSet[lang]||imgSet.en||imgSet.fa);
  const title=lvInfoSheet.querySelector('#lvInfoName');
  const sk=SKINS.find(s=>s.id===skinId);
  if(img){ title.textContent=''; body.innerHTML=`<img src="${img}" alt="">`; }
  else if(sk&&sk.soon){ title.textContent=''; body.innerHTML=`<div class="lv-info-soon"><div class="lv-info-soon-lock">${LOCK}</div><div class="lv-info-soon-txt">${T().soon}</div></div>`; }
  else{ title.textContent=T().lvInfoTitle.replace('{n}',num(level)); body.textContent=(LV_INFO[lang]&&LV_INFO[lang][skinId])||T().lvInfoSoon; }
  lvInfoSheet.hidden=false;
  requestAnimationFrame(()=>lvInfoSheet.classList.add('on'));
}
function closeLvInfo(){
  if(!lvInfoSheet) return; lvInfoSheet.classList.remove('on');
  setTimeout(()=>{ lvInfoSheet.hidden=true; },200);
}
// Live real data from the server: TT.setShop({ton:2.5, level:2, ownedSkins:['yellow','red']})
window.TT=window.TT||{};
TT.setShop=o=>{ o=o||{}; SHOP.ton=Number(o.ton)||0; SHOP.level=Number(o.level)||1;
  SHOP.ownedSkins=Array.isArray(o.ownedSkins)&&o.ownedSkins.length?o.ownedSkins:['yellow'];
  SHOP.skinRewards=(o.skinRewards&&typeof o.skinRewards==='object')?o.skinRewards:{};
  SHOP.tonTodayByLevel=(o.tonTodayByLevel&&typeof o.tonTodayByLevel==='object')?o.tonTodayByLevel:{1:0,2:0,3:0,4:0};
  if(!SHOP.ownedSkins.includes(skin)){ skin=SHOP.ownedSkins[0]; store('tt_skin',skin); }
  const active=currentActiveLevel();
  if(Number(store('tt_active_level'))!==active) store('tt_active_level',active);
  if(typeof TT.selectLevel==='function') TT.selectLevel(active);
  renderShop(); };
renderShop(); // render with defaults immediately; TT.setShop() refreshes it once real server data arrives

// Home values (demo – later load these from your server, e.g. fetch('/api/me'))
const HOME={gram:0.000775, tonLeft:1, level:'1-1', levelNo:1, routes:1, best:775, wallet:775, tries:7, triesMax:10, progress:Math.max(0,Math.min(100,+store('tt_progress')||0))};
function renderHome(){
  const $=id=>document.getElementById(id);
  $('hBal').innerHTML=`<span class="num">${HOME.gram.toFixed(6)}</span><span class="cap">${T().daily}</span>`;
  $('hLeft').innerHTML=`<span>${T().tonLeft} ${nf(HOME.tonLeft)}</span><span class="dot">·</span><span>${T().lvlWord} ${nf(HOME.levelNo)}</span>`;
  const stat=(id,v)=>{const el=$(id), s=nf(v); el.firstElementChild.textContent=s;
    el.style.setProperty('--fs', s.length<=3?'5.4cqw':s.length===4?'4.4cqw':'3.5cqw');};
  stat('hBest',HOME.best); stat('hRoute',HOME.routes); stat('hLvl',HOME.level);
  $('hTries').textContent=`${T().triesLeft} ${nf(HOME.tries)} / ${nf(HOME.triesMax)}`;
  renderProgress();
}
// Progress bar on Home (0-100). Call TT.setProgress(percent) whenever the value changes while playing.
function renderProgress(){
  const p=HOME.progress, $=id=>document.getElementById(id);
  $('hBar').style.width=p+'%';
  const el=$('hPct'); el.firstElementChild.textContent=p; el.classList.toggle('big',p>=100);
}
function setProgress(p){
  p=Math.max(0,Math.min(100,Math.round(+p||0)));
  HOME.progress=p; store('tt_progress',p); renderProgress();
}
window.TT=window.TT||{};
TT.setProgress=setProgress;
TT.addProgress=d=>setProgress(HOME.progress+(+d||0));
TT.getProgress=()=>HOME.progress;
// Change the numbers shown on Home, e.g. TT.setStats({best:1200, routes:8, level:'2-3', levelNo:2, gram:0.0012, tonLeft:1, tries:5, triesMax:10, progress:40})
TT.setStats=o=>{ o=o||{}; const {progress,...rest}=o; Object.assign(HOME,rest); renderHome(); if(progress!==undefined) setProgress(progress); };
window.addEventListener('message',e=>{const d=e.data; if(d&&d.type==='tt-progress') setProgress(d.value);});   // game iframe: parent.postMessage({type:'tt-progress',value:42},'*')
// Live sync from the real driving game running in the #play iframe:
// it posts {type:'tt-level', level, best, runs, coins, ton} whenever the active skin/level or
// stats change, so Home stays correct even without Telegram auth (server-bridge.js only runs
// with real Telegram initData).
window.addEventListener('message',e=>{
  const d=e.data; if(!d||d.type!=='tt-level') return;
  const lvl=Number(d.level)||1;
  TT.setStats({ levelNo:lvl, level:lvl+'-1', best:Number(d.best)||HOME.best, routes:Number(d.runs)||HOME.routes,
    tonLeft:(typeof d.tonLeft==='number')?d.tonLeft:HOME.tonLeft, gram:(typeof d.gramToday==='number')?d.gramToday:HOME.gram,
    progress:(typeof d.progress==='number')?d.progress:undefined });
});
renderHome();

// ---- Chat: online users --------------------------------------------------------
// Demo data. Set real data with TT.setOnline(128)  |  TT.setOnline(['Ali','Sara'])  |  TT.setOnline({count:342, users:['Ali','Sara','Max']})
const CHAT={online:{count:128,users:[{name:'TaxiBoss',admin:'boy'},{name:'ZombieHunter',admin:'girl'},{name:'Designer',badge:'designer'},'NightRider','TonMaster','SuperTaxiDriver99','Sara','Max','Kian','Nima','Dara','Roya','Ali']}};
const AV_COLORS=[['#ffe36a','#f0a000'],['#9dff8a','#2aa84a'],['#8fd0ff','#1e6bff'],['#ffa08a','#d8341a'],['#d9a8ff','#8a3cff']];
const ADM_IMG={boy:'assets/images/adm-boy.png',girl:'assets/images/adm-girl.png',designer:'../sprites/alipro.png'};
// Admin badge: kind = 'boy' | 'girl'
function admBadge(kind,h){
  const s=document.createElement('span'); s.className='adm adm-'+kind; if(h) s.style.setProperty('--ah',h+'px');
  const i=document.createElement('img'); i.src=ADM_IMG[kind]||ADM_IMG.boy; i.alt='';
  s.title=kind==='designer'?T().designer:T().admin; s.append(i);
  if(kind!=='designer'){ const t=document.createElement('em'); t.className='adm-t'; t.textContent=T().admin; s.append(t); }
  return s;
}
// Messages with data-admin="boy|girl" get the badge next to the name
function renderChatBadges(){
  document.querySelectorAll('#chatList .msg[data-badge],#chatList .msg[data-admin]').forEach(m=>{
    const nameEl=m.querySelector(':scope > b'); if(!nameEl) return;
    nameEl.querySelectorAll('.adm').forEach(x=>x.remove());
    const kind=m.dataset.badge||m.dataset.admin;
    const badge=admBadge(kind,34);
    if(kind==='designer') nameEl.prepend(badge); else nameEl.append(badge);
  });
}
function renderOnline(){
  const box=document.getElementById('onlineAvs'); if(!box) return;
  const o=CHAT.online, extra=Math.max(0,o.count-o.users.length);
  document.getElementById('onlineCount').textContent=nf(o.count);
  box.textContent='';
  o.users.forEach(u=>{
    const n=typeof u==='string'?u:u.name, adm=typeof u==='string'?null:(u.badge||u.admin);
    const chip=document.createElement('span'); chip.className='ou'; chip.setAttribute('role','listitem'); chip.title=n;
    if(typeof u!=='string'&&u.id!==undefined) chip.dataset.uid=u.id;
    if(typeof u!=='string'&&u.muted!==undefined) chip.dataset.muted=u.muted?'true':'false';
    if(typeof u!=='string'&&u.me===true) chip.dataset.me='true';
    const av=document.createElement('span'); av.className='av'; av.textContent=[...String(n)][0]||'?';
    let hsh=0; for(const ch of String(n)) hsh=(hsh*31+ch.charCodeAt(0))>>>0;
    const [a,b]=AV_COLORS[hsh%AV_COLORS.length]; av.style.background=`linear-gradient(180deg,${a},${b})`;
    const dot=document.createElement('i'); av.append(dot);
    const nm=document.createElement('span'); nm.className='ou-name'; nm.textContent=n;
    const bal=document.createElement('span'); bal.className='ou-bal'; bal.textContent=nf(fmtTonOnline(typeof u==='string'?0:u.ton))+' TON';
    chip.append(av); if(adm==='designer') chip.append(admBadge(adm,20)); chip.append(nm,bal); if(adm&&adm!=='designer') chip.append(admBadge(adm,20)); box.append(chip);
  });
  if(extra>0){ const m=document.createElement('span'); m.className='ou more'; m.textContent='+'+nf(extra); box.append(m); }
}
const _u=u=>typeof u==='string'?u:{id:u&&(u.id!==undefined?u.id:u.uid),name:(u&&u.name)||'?',badge:u&&(u.badge||u.admin),muted:!!(u&&u.muted),me:!!(u&&u.me),ton:Number(u&&u.ton)||0};
TT.setOnline=x=>{
  const o=CHAT.online;
  if(typeof x==='number') o.count=Math.max(0,Math.round(x));
  else if(Array.isArray(x)){ o.users=x.map(_u); o.count=x.length; }
  else if(x&&typeof x==='object'){ if(Array.isArray(x.users)) o.users=x.users.map(_u); o.count=Math.max(0,Math.round(x.count!==undefined?x.count:o.users.length)); }
  renderOnline();
};
// Add an incoming message: TT.addMessage({name:'Sara', text:'Hi!', admin:'girl'})   (admin: 'boy' | 'girl' | omitted)
// As a reply:             TT.addMessage({name:'Sara', text:'Yes!', mid:'42', reply:{mid:'41', name:'Ali', text:'Anyone here?'}})
TT.addMessage=(m)=>{
  m=m||{};
  if(m.mid!==undefined&&Array.from(chatList.querySelectorAll('.msg[data-mid]')).some(el=>el.dataset.mid===String(m.mid))) return;
  const d=document.createElement('div'); d.className='msg'+(m.me?' me':'')+(m.randomWinner?' random-winner':''); if(m.badge||m.admin) d.dataset.badge=m.badge||m.admin;
  if(m.id!==undefined) d.dataset.uid=m.id;
  if(m.mid!==undefined) d.dataset.mid=m.mid;
  if(m.muted!==undefined) d.dataset.muted=m.muted?'true':'false';
  if(m.randomWinner){
    d.dataset.randomWinnerName=m.randomWinnerName||'';
    d.dataset.randomWinnerText=m.text||'';
  }
  if(m.time!==undefined){ const t=new Date(m.time).getTime(); if(!isNaN(t)) d.dataset.ts=t; }
  const b=document.createElement('b'); b.textContent=m.name||'?'; const s=document.createElement('span'); s.textContent=m.text||'';
  d.append(b); if(m.reply) d.append(buildQuote(m.reply)); d.append(s);
  chatList.append(d); decorateMsg(d); renderChatBadges(); renderModMarks(); scrollChatToEnd();
};
function renderRandomWinnerMessages(){
  document.querySelectorAll('#chatList .msg.random-winner').forEach((message)=>{
    const name=message.dataset.randomWinnerName;
    const text=name && T().randomWinner ? T().randomWinner.replace('{name}',name) : message.dataset.randomWinnerText;
    const body=message.querySelector(':scope > span:last-of-type');
    if(body && text) body.textContent=text;
  });
}

// ---- Chat: reply ---------------------------------------------------------------------
// Reply = tap the ↩ button on a message, or swipe the message sideways.
// Your server: TT.onSendMessage = ({text, mid, replyTo}) => { … }   replyTo: {mid, name, text} or null
Object.assign(I18N.fa,{reply:'پاسخ',replyTo:'پاسخ به',replyX:'لغو پاسخ',edit:'ویرایش',editing:'ویرایش پیام',editX:'لغو ویرایش',save:'ذخیره',edited:'ویرایش شد'});
Object.assign(I18N.de,{reply:'Antworten',replyTo:'Antwort an',replyX:'Antwort abbrechen',edit:'Bearbeiten',editing:'Nachricht bearbeiten',editX:'Bearbeiten abbrechen',save:'Speichern',edited:'bearbeitet'});
Object.assign(I18N.en,{reply:'Reply',replyTo:'Reply to',replyX:'Cancel reply',edit:'Edit',editing:'Edit message',editX:'Cancel edit',save:'Save',edited:'edited'});
let msgSeq=0, replyTo=null, editing=null;
const ED_SVG='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17.3V21h3.7L17.8 9.9l-3.7-3.7L3 17.3zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>';
const RP_SVG='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>';
const msgBody=m=>{ const s=m.querySelector(':scope > span:last-of-type'); return s?s.textContent.trim():''; };
const cut=(t,n)=>{ t=[...String(t||'')]; return t.length>n?t.slice(0,n).join('')+'…':t.join(''); };
// date + time under every message (data-ts = milliseconds). Incoming: TT.addMessage({… time: 1726830000000 or '2026-09-20T14:32:00Z'})
const LOCALE={fa:'fa-IR',de:'de-DE',en:'en-GB'};
function fmtTs(ts){
  const d=new Date(+ts), loc=LOCALE[lang]||'en-GB';
  const date=d.toLocaleDateString(loc,{year:'numeric',month:'2-digit',day:'2-digit'});
  const time=d.toLocaleTimeString(loc,{hour:'2-digit',minute:'2-digit',hour12:false});
  return {text:date+'  '+time, iso:d.toISOString()};
}
function renderTime(m){
  let mt=m.querySelector(':scope > .mt');
  if(!mt){ mt=document.createElement('div'); mt.className='mt';
    const sp=m.querySelector(':scope > span:last-of-type'); sp?sp.after(mt):m.append(mt); }
  let t=mt.querySelector('time'); if(!t){ t=document.createElement('time'); t.className='ts'; mt.append(t); }
  if(m.dataset.ts){ const f=fmtTs(m.dataset.ts); t.textContent=f.text; t.dateTime=f.iso; }
  return mt;
}
function decorateMsg(m){
  if(!m.dataset.mid) m.dataset.mid='l'+(++msgSeq);
  if(!m.dataset.ts) m.dataset.ts=Date.now();
  renderTime(m);
  if(m.querySelector(':scope > .rp')) return;
  const r=document.createElement('button'); r.type='button'; r.className='rp'; r.innerHTML=RP_SVG;
  r.setAttribute('aria-label',T().reply); r.title=T().reply;
  r.addEventListener('click',e=>{ e.stopPropagation(); startReply(m); });
  m.append(r);
  const rb=document.createElement('button'); rb.type='button'; rb.className='rx-btn'; rb.innerHTML=RX_SVG;
  rb.setAttribute('aria-label',T().react); rb.title=T().react; rb.setAttribute('aria-haspopup','true');
  rb.addEventListener('click',e=>{ e.stopPropagation(); openPicker(m,rb); });
  m.append(rb);
  if(m.classList.contains('me')){
    const ed=document.createElement('button'); ed.type='button'; ed.className='ed'; ed.innerHTML=ED_SVG;
    ed.setAttribute('aria-label',T().edit); ed.title=T().edit;
    ed.addEventListener('click',e=>{ e.stopPropagation(); startEdit(m); });
    m.append(ed);
  }
}
function buildQuote(r){
  const q=document.createElement('div'); q.className='rq'; if(r.mid!==undefined) q.dataset.ref=r.mid;
  const b=document.createElement('b'); b.textContent=r.name||'?';
  const s=document.createElement('span'); s.textContent=cut(r.text,90);
  q.append(b,s);
  q.addEventListener('click',e=>{
    e.stopPropagation();
    const t=r.mid!==undefined&&chatList.querySelector(`.msg[data-mid="${CSS.escape(String(r.mid))}"]`);
    if(!t||t.classList.contains('mod-hidden')&&!document.body.classList.contains('is-admin')) return;
    t.scrollIntoView({behavior:'smooth',block:'center'});
    t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  });
  return q;
}
// reply bar above the input
const replyBar=document.createElement('div'); replyBar.className='reply-bar'; replyBar.hidden=true;
replyBar.innerHTML='<span class="rb-ic"></span><div class="rb-txt"><b></b><span></span></div><button type="button" class="rb-x">✕</button>';
replyBar.querySelector('.rb-ic').innerHTML=RP_SVG;
chatText.closest('.chat-input').before(replyBar);
replyBar.querySelector('.rb-x').addEventListener('click',()=>{ if(editing) cancelEdit(); else cancelReply(); chatText.focus(); });
function startReply(m){
  if(editing) cancelEdit();
  replyTo={mid:m.dataset.mid, name:msgUser(m).name, text:msgBody(m)};
  if(m.dataset.uid) replyTo.uid=m.dataset.uid;
  renderReplyBar(); replyBar.hidden=false;
  try{ Telegram.WebApp.HapticFeedback.impactOccurred('light'); }catch(e){}
  if(!chatText.disabled) chatText.focus();
}
function cancelReply(){ replyTo=null; replyBar.hidden=true; }
function renderReplyBar(){
  const send=document.getElementById('chatSend');
  send.textContent=editing?T().save:T().send;
  replyBar.classList.toggle('is-edit',!!editing);
  document.querySelectorAll('#chatList .ed').forEach(x=>{x.setAttribute('aria-label',T().edit);x.title=T().edit;});
  document.querySelectorAll('#chatList .ed-tag').forEach(x=>x.textContent=T().edited);
  if(editing){
    replyBar.querySelector('.rb-ic').innerHTML=ED_SVG;
    replyBar.querySelector('.rb-txt b').textContent=T().editing;
    replyBar.querySelector('.rb-txt span').textContent=cut(editing.old,70);
    replyBar.querySelector('.rb-x').setAttribute('aria-label',T().editX);
    return;
  }
  replyBar.querySelector('.rb-ic').innerHTML=RP_SVG;
  if(!replyTo) return;
  replyBar.querySelector('.rb-txt b').textContent=T().replyTo+' '+replyTo.name;
  replyBar.querySelector('.rb-txt span').textContent=cut(replyTo.text,70);
  replyBar.querySelector('.rb-x').setAttribute('aria-label',T().replyX);
}
chatText.addEventListener('keydown',e=>{ if(e.key==='Escape'){ if(editing) cancelEdit(); else if(replyTo) cancelReply(); } });

// ---- Chat: edit own messages ---------------------------------------------------------
// Tap ✏️ on your own message -> text goes into the input, "Send" becomes "Save".
// Your server: TT.onEditMessage = ({mid, text}) => { … }
// Show an edit from the server: TT.editMessage(mid, 'new text')
function startEdit(m){
  if(typeof chatBlocked==='function' && chatBlocked()) return;
  if(editing) cancelEdit(true);
  replyTo=null;
  editing={m, old:msgBody(m)};
  m.classList.add('editing');
  chatText.value=editing.old; renderReplyBar(); replyBar.hidden=false; autoGrowChatInput();
  chatText.focus(); try{ chatText.setSelectionRange(chatText.value.length,chatText.value.length); }catch(e){}
}
function cancelEdit(keepText){
  if(!editing) return; editing.m.classList.remove('editing'); editing=null;
  if(!keepText) chatText.value=''; replyBar.hidden=true; renderReplyBar(); autoGrowChatInput();
}
function setMsgText(m,text){
  const sp=m.querySelector(':scope > span:last-of-type'); if(sp){ sp.textContent=text; sp.removeAttribute('data-i'); }
  const mt=renderTime(m);
  if(!mt.querySelector('.ed-tag')){ const t=document.createElement('small'); t.className='ed-tag'; t.textContent=T().edited; mt.prepend(t); }
  chatList.querySelectorAll(`.rq[data-ref="${CSS.escape(String(m.dataset.mid))}"] span`).forEach(q=>q.textContent=cut(text,90));   // quotes of this message
}
function finishEdit(v){
  const {m,old}=editing;
  if(v!==old){
    setMsgText(m,v);
    if(typeof TT.onEditMessage==='function') try{ TT.onEditMessage({mid:m.dataset.mid, text:v}); }catch(e){}
    m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash');
  }
  cancelEdit();
}
TT.editMessage=(mid,text)=>{ const m=chatList.querySelector(`.msg[data-mid="${CSS.escape(String(mid))}"]`); if(m) setMsgText(m,String(text||'')); };
// swipe a message sideways to reply
let sw=null, swUntil=0;
chatList.addEventListener('pointerdown',e=>{
  const m=e.target.closest('.msg'); if(!m||e.target.closest('.rp,.rq,.rx-btn,.ed,.rx')||e.button>0) return;
  sw={m,x:e.clientX,y:e.clientY,dx:0,on:false};
});
chatList.addEventListener('pointermove',e=>{
  if(!sw) return; const dx=e.clientX-sw.x, dy=e.clientY-sw.y;
  if(!sw.on){ if(Math.abs(dy)>10&&Math.abs(dy)>Math.abs(dx)){ sw=null; return; } if(Math.abs(dx)<10) return; sw.on=true; sw.m.classList.add('swiping'); }
  sw.dx=Math.max(-80,Math.min(80,dx)); sw.m.style.transform=`translateX(${sw.dx}px)`;
  sw.m.classList.toggle('sw-ready',Math.abs(sw.dx)>=55);
});
function endSwipe(){
  if(!sw) return; const {m,on,dx}=sw; sw=null; if(!on) return;
  m.classList.remove('swiping','sw-ready'); m.style.transform='';
  swUntil=Date.now()+350; if(Math.abs(dx)>=55) startReply(m);
}
chatList.addEventListener('pointerup',endSwipe); chatList.addEventListener('pointercancel',endSwipe);
chatList.addEventListener('click',e=>{ if(Date.now()<swUntil||lpJust){ lpJust=false; e.stopImmediatePropagation(); e.preventDefault(); } },true);   // no admin sheet after a swipe / long-press

// ---- Chat: emoji reactions -----------------------------------------------------------
// Tap ☺ on a message (or hold the message) -> pick an emoji. One reaction per user; tap it again to remove it.
// Reactions show under the message; tap a chip to react with that emoji too.
// Your server:  TT.onReact = ({mid, emoji, on}) => { … }         (on:false = removed)
// From server:  TT.setReactions(mid, {'👍':3,'❤️':1}, '👍')      (3rd arg = my own reaction or null)
const RX_EMOJIS=['👍','❤️','😂','😮','😢','🔥','👏','😡'];
const RX_SVG='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 17.5c2.3 0 4.3-1.4 5-3.5H7c.7 2.1 2.7 3.5 5 3.5z"/></svg>';
Object.assign(I18N.fa,{react:'واکنش'}); Object.assign(I18N.de,{react:'Reagieren'}); Object.assign(I18N.en,{react:'React'});
const REACT={};   // mid -> {counts:{emoji:n}, mine:emoji|null}
function rxOf(mid){ return REACT[mid]||(REACT[mid]={counts:{},mine:null}); }
function renderReactions(m){
  const st=REACT[m.dataset.mid]; let row=m.querySelector(':scope > .rx');
  const list=st?Object.entries(st.counts).filter(([,n])=>n>0):[];
  if(!list.length){ if(row) row.remove(); return; }
  if(!row){ row=document.createElement('div'); row.className='rx'; m.append(row); }
  row.textContent='';
  list.forEach(([em,n])=>{
    const c=document.createElement('button'); c.type='button'; c.className='rx-chip'+(st.mine===em?' mine':'');
    c.setAttribute('aria-pressed',st.mine===em);
    const e=document.createElement('span'); e.className='rx-e'; e.textContent=em;
    const k=document.createElement('span'); k.className='rx-n'; k.textContent=nf(n);
    c.append(e,k); c.addEventListener('click',ev=>{ ev.stopPropagation(); react(m,em); }); row.append(c);
  });
}
function react(m,em){
  const mid=m.dataset.mid, st=rxOf(mid), old=st.mine;
  if(old){ st.counts[old]=Math.max(0,(st.counts[old]||1)-1); if(!st.counts[old]) delete st.counts[old]; }
  const on=old!==em;
  if(on){ st.counts[em]=(st.counts[em]||0)+1; st.mine=em; } else st.mine=null;
  renderReactions(m);
  const chip=[...m.querySelectorAll('.rx-chip')].find(c=>c.firstChild.textContent===em);
  if(chip&&on){ chip.classList.remove('pop'); void chip.offsetWidth; chip.classList.add('pop'); }
  try{ Telegram.WebApp.HapticFeedback.selectionChanged(); }catch(e){}
  if(typeof TT.onReact==='function') try{
    if(old&&old!==em) TT.onReact({mid, emoji:old, on:false});
    TT.onReact({mid, emoji:em, on});
  }catch(e){}
}
TT.setReactions=(mid,counts,mine)=>{
  const m=chatList.querySelector(`.msg[data-mid="${CSS.escape(String(mid))}"]`); if(!m) return;
  REACT[mid]={counts:Object.assign({},counts||{}), mine:mine===undefined?rxOf(mid).mine:mine};
  renderReactions(m);
};
// emoji picker
const picker=document.createElement('div'); picker.className='rx-pick'; picker.hidden=true; picker.setAttribute('role','menu');
RX_EMOJIS.forEach(em=>{ const b=document.createElement('button'); b.type='button'; b.textContent=em; b.setAttribute('role','menuitem'); b.dataset.e=em; picker.append(b); });
document.body.append(picker);
let pickFor=null, pickBtn=null;
picker.addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b||!pickFor) return; e.stopPropagation(); const m=pickFor; closePicker(); react(m,b.dataset.e); });
function openPicker(m,btn){
  if(pickFor===m){ closePicker(); return; }
  pickFor=m; pickBtn=btn||null; const mine=rxOf(m.dataset.mid).mine;
  picker.querySelectorAll('button').forEach(b=>b.classList.toggle('mine',b.dataset.e===mine));
  picker.hidden=false; picker.classList.remove('on');
  const r=m.getBoundingClientRect(), pw=picker.offsetWidth, ph=picker.offsetHeight, vw=document.documentElement.clientWidth;
  let top=r.top-ph-8; if(top<8) top=r.bottom+8;
  let left=r.left+r.width/2-pw/2; left=Math.max(8,Math.min(vw-pw-8,left));
  picker.style.top=top+'px'; picker.style.left=left+'px';
  requestAnimationFrame(()=>picker.classList.add('on'));
  try{ Telegram.WebApp.HapticFeedback.impactOccurred('light'); }catch(e){}
  picker.querySelector('button').focus({preventScroll:true});
}
function closePicker(){ if(!pickFor) return; picker.classList.remove('on'); picker.hidden=true; const b=pickBtn; pickFor=null; pickBtn=null; if(b&&document.activeElement&&picker.contains(document.activeElement)) b.focus({preventScroll:true}); }
document.addEventListener('click',e=>{ if(pickFor&&!picker.contains(e.target)) closePicker(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&pickFor) closePicker(); });
chatList.addEventListener('scroll',closePicker,{passive:true});
window.addEventListener('resize',closePicker);
// hold a message to open the picker
let lp=null, lpJust=false;
chatList.addEventListener('pointerdown',e=>{
  lpJust=false; const m=e.target.closest('.msg'); if(!m||e.target.closest('button,.rq')||e.button>0) return;
  lp={m,x:e.clientX,y:e.clientY,t:setTimeout(()=>{ if(lp&&lp.m===m){ lpJust=true; lp=null; openPicker(m); } },480)};
});
chatList.addEventListener('pointermove',e=>{ if(lp&&Math.hypot(e.clientX-lp.x,e.clientY-lp.y)>10){ clearTimeout(lp.t); lp=null; } });
['pointerup','pointercancel'].forEach(t=>chatList.addEventListener(t,()=>{ if(lp){ clearTimeout(lp.t); lp=null; } }));
chatList.addEventListener('contextmenu',e=>{ if(e.target.closest('.msg')) e.preventDefault(); });
document.querySelectorAll('#chatList .msg').forEach((m,i,all)=>{ if(!m.dataset.ts) m.dataset.ts=Date.now()-(all.length-i)*4*60000; });   // demo times for the sample messages
document.querySelectorAll('#chatList .msg').forEach(decorateMsg);
{ const ms=document.querySelectorAll('#chatList .msg');   // demo reactions – remove when your server sends real ones
  if(ms[0]) TT.setReactions(ms[0].dataset.mid,{'🔥':3,'👍':2},null);
  if(ms[1]) TT.setReactions(ms[1].dataset.mid,{'😂':1},null); }

// ---- Chat: admin tools (tap a user in the chat or in the online list) --------------
// ADMIN.demo:true  -> everybody is admin (for testing only!). For live: demo:false and put the
//                     Telegram user IDs of your admins into ADMIN.ids (or set TT.isAdmin = () => true/false).
// Buttons:  چت نکن (chat ban) <-> چت بکن (lift ban)   |   حذف پیام (delete selected message)
// Server:   TT.adminAction = async (action, user) => true/false   is called for every action
//           action: 'chatOff' | 'chatOn' | 'delete',  user: {name, id, mid}
//           Your server must check that the sender really is an admin (Telegram initData) and enforce it.
// The punished user's app: TT.setMyChatState({muted:true | untilTimestamp, banned:true})  -> input is locked.
// demo:false because server-bridge.js wires TT.isAdmin()/TT.adminAction() to the real
// state.isChatAdmin/state.isDesigner flags and to /api/chat/moderate + /api/chat/delete.
const ADMIN={demo:false, ids:[]};
Object.assign(I18N.fa,{aMute:'خفشو',aTalk:'زر بزن',aChatOff:'چت نکن',aChatOn:'چت بکن',aDel:'حذف پیام',aClose:'بستن',
  aDelQ:'این پیام حذف شود؟',aDone:'انجام شد ✔',aFail:'خطا – دوباره امتحان کن',aMutedFor:'ساکت تا {t}',aMutedTag:'ساکت',aBannedTag:'بدون چت',
  youMuted:'ادمین تو را ساکت کرده 🔇',youBanned:'ادمین چت را برایت بسته 🚫'});
Object.assign(I18N.de,{aMute:'Stumm schalten',aTalk:'Sprechen lassen',aChatOff:'Chat sperren',aChatOn:'Chat erlauben',aDel:'Nachricht löschen',aClose:'Schließen',
  aDelQ:'Diese Nachricht löschen?',aDone:'Erledigt ✔',aFail:'Fehler – bitte nochmal',aMutedFor:'stumm bis {t}',aMutedTag:'stumm',aBannedTag:'gesperrt',
  youMuted:'Ein Admin hat dich stumm geschaltet 🔇',youBanned:'Ein Admin hat dir den Chat gesperrt 🚫'});
Object.assign(I18N.en,{aMute:'Mute',aTalk:'Unmute',aChatOff:'Block chat',aChatOn:'Allow chat',aDel:'Delete message',aClose:'Close',
  aDelQ:'Delete this message?',aDone:'Done ✔',aFail:'Error – try again',aMutedFor:'muted until {t}',aMutedTag:'muted',aBannedTag:'blocked',
  youMuted:'An admin has muted you 🔇',youBanned:'An admin has blocked your chat 🚫'});
Object.assign(I18N.fa,{chatClose:'بستن چت',chatOpen:'باز کردن چت',chatClosed:'چت توسط ادمین بسته شده'});
Object.assign(I18N.de,{chatClose:'Chat schließen',chatOpen:'Chat öffnen',chatClosed:'Der Chat wurde vom Admin geschlossen'});
Object.assign(I18N.en,{chatClose:'Close chat',chatOpen:'Open chat',chatClosed:'The chat was closed by an admin'});
Object.assign(I18N.fa,{lvInfoTitle:'راننده لول {n}',lvInfoSoon:'اطلاعات این راننده به‌زودی اضافه می‌شود.'});
Object.assign(I18N.de,{lvInfoTitle:'Fahrer Level {n}',lvInfoSoon:'Infos zu diesem Fahrer folgen in Kürze.'});
Object.assign(I18N.en,{lvInfoTitle:'Level {n} driver',lvInfoSoon:'Details about this driver are coming soon.'});
const ADM_BTN={chatOff:'assets/images/adm-chat-off.png',chatOn:'assets/images/adm-chat-on.png',delete:'assets/images/adm-del.png'};
const ADM_TXT={chatOff:'aChatOff',chatOn:'aChatOn',delete:'aDel'};
Object.values(ADM_BTN).forEach(src=>{const i=new Image(); i.src=src;});   // preload

const tgUser=()=>{ try{ return Telegram.WebApp.initDataUnsafe.user||null; }catch(e){ return null; } };
function isAdmin(){
  if(typeof TT.isAdmin==='function') return !!TT.isAdmin();
  if(ADMIN.demo) return true;
  const u=tgUser(); return !!(u && ADMIN.ids.map(String).includes(String(u.id)));
}
// moderation state per user (demo: kept in the browser; live: comes from your server)
let MOD={}; try{ MOD=JSON.parse(localStorage.getItem('tt_mod')||'{}')||{}; }catch(e){}
const saveMod=()=>{ try{ localStorage.setItem('tt_mod',JSON.stringify(MOD)); }catch(e){} };
const modKey=u=>u&&u.id!==undefined&&u.id!==''?'id:'+u.id:'n:'+(u&&u.name||typeof u==='string'&&u||'');
function modState(u){
  if(typeof u==='string') u={name:u};
  const st=MOD[modKey(u)]||{}, now=Date.now();
  const muted=u&&u.muted===true || st.mute===-1 || (st.mute>now);
  return {muted, until:st.mute>0?st.mute:0, banned:!!st.ban};
}
function setMod(u,patch){
  const k=modKey(u), st=Object.assign({},MOD[k]||{},patch);
  if(!st.mute) delete st.mute; if(!st.ban) delete st.ban;
  if(Object.keys(st).length) MOD[k]=st; else delete MOD[k];
  saveMod(); renderModMarks();
}
// small 🔇 / 🚫 marks next to names
function renderModMarks(){
  document.querySelectorAll('#chatList .msg:not(.me)').forEach(m=>{
    const b=m.querySelector(':scope > b'); if(!b) return;
    b.querySelectorAll('.modmark').forEach(x=>x.remove());
    const st=modState(msgUser(m)); if(st.banned) m.classList.add('mod-hidden'); else m.classList.remove('mod-hidden');
    [[st.muted,'🔇',T().aMutedTag],[st.banned,'🚫',T().aBannedTag]].forEach(([on,ic,tt])=>{
      if(!on) return; const i=document.createElement('i'); i.className='modmark'; i.textContent=ic; i.title=tt; b.append(i);
    });
  });
  document.querySelectorAll('#onlineAvs .ou:not(.more)').forEach(c=>{
    c.querySelectorAll('.modmark').forEach(x=>x.remove());
    const st=modState({name:c.title,id:c.dataset.uid,muted:c.dataset.muted==='true'});
    const mk=st.banned?'🚫':st.muted?'🔇':''; if(!mk) return;
    const i=document.createElement('i'); i.className='modmark'; i.textContent=mk; c.querySelector('.av').append(i);
  });
}
function msgUser(m){
  const b=m.querySelector(':scope > b'); let n='';
  if(b) b.childNodes.forEach(x=>{ if(x.nodeType===3) n+=x.textContent; });
  return {name:n.trim(), id:m.dataset.uid, muted:m.dataset.muted==='true'};
}
// toast
function toast(msg){
  let t=document.getElementById('ttToast');
  if(!t){ t=document.createElement('div'); t.id='ttToast'; t.className='tt-toast'; t.setAttribute('role','status'); document.body.append(t); }
  t.textContent=msg; t.classList.add('on'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('on'),2200);
}
function askConfirm(msg){
  return new Promise(res=>{
    try{ const tg=window.Telegram&&Telegram.WebApp; if(tg&&tg.showConfirm&&tg.initData){ tg.showConfirm(msg,ok=>res(!!ok)); return; } }catch(e){}
    res(window.confirm(msg));
  });
}

// the sheet with the buttons
let admSheet=null, admUser=null;
function buildSheet(){
  admSheet=document.createElement('div'); admSheet.className='adm-sheet'; admSheet.hidden=true;
  admSheet.innerHTML='<div class="as-back"></div><div class="as-panel" role="dialog" aria-modal="true" aria-labelledby="asName">'+
    '<div class="as-head"><span class="av as-av"></span><b id="asName"></b><button type="button" class="as-x" aria-label="close">✕</button></div>'+
    '<div class="as-state"></div><div class="as-btns"></div></div>';
  document.body.append(admSheet);
  admSheet.querySelector('.as-back').addEventListener('click',closeAdmin);
  admSheet.querySelector('.as-x').addEventListener('click',closeAdmin);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!admSheet.hidden) closeAdmin(); });
}
function renderSheet(){
  if(!admSheet||!admUser) return;
  const u=admUser, st=modState(u), n=u.name;
  admSheet.querySelector('#asName').textContent=n;
  admSheet.querySelector('.as-x').setAttribute('aria-label',T().aClose);
  const av=admSheet.querySelector('.as-av'); av.textContent=[...n][0]||'?';
  let h=0; for(const ch of n) h=(h*31+ch.charCodeAt(0))>>>0; const [c1,c2]=AV_COLORS[h%AV_COLORS.length];
  av.style.background=`linear-gradient(180deg,${c1},${c2})`;
  const tags=[];
  if(st.muted) tags.push('🔇 '+(st.until?T().aMutedFor.replace('{t}',new Date(st.until).toLocaleTimeString(lang==='fa'?'fa-IR':lang,{hour:'2-digit',minute:'2-digit'})):T().aMutedTag));
  if(st.banned) tags.push('🚫 '+T().aBannedTag);
  admSheet.querySelector('.as-state').textContent=tags.join('  ·  ');
  const box=admSheet.querySelector('.as-btns'); box.textContent='';
  const actions=[];
  if(!u.me) actions.push(st.muted?'chatOn':'chatOff');
  if(u.mid!==undefined) actions.push('delete');
  actions.forEach(a=>{
    const btn=document.createElement('button'); btn.type='button'; btn.className='as-btn as-'+a; btn.dataset.a=a;
    btn.setAttribute('aria-label',T()[ADM_TXT[a]]);
    const img=document.createElement('img'); img.src=ADM_BTN[a]; img.alt='';
    const cap=document.createElement('span'); cap.className='as-cap'; cap.textContent=T()[ADM_TXT[a]];
    btn.append(img,cap); btn.addEventListener('click',()=>runAdmin(a)); box.append(btn);
  });
}
function openAdmin(u){
  if(!isAdmin()||!u||!u.name) return;
  if(!admSheet) buildSheet();
  admUser=u; renderSheet(); admSheet.hidden=false;
  requestAnimationFrame(()=>admSheet.classList.add('on'));
  try{ Telegram.WebApp.HapticFeedback.impactOccurred('light'); }catch(e){}
}
function closeAdmin(){
  if(!admSheet) return; admSheet.classList.remove('on');
  setTimeout(()=>{ admSheet.hidden=true; },200); admUser=null;
}
async function runAdmin(a){
  const u=admUser; if(!u) return;
  if(a==='delete' && !(await askConfirm(T().aDelQ))) return;
  admSheet.querySelectorAll('.as-btn').forEach(b=>b.disabled=true);
  let ok=true;
  try{ if(typeof TT.adminAction==='function') ok=(await TT.adminAction(a,{name:u.name,id:u.id,mid:u.mid}))!==false; }catch(e){ ok=false; }
  if(!ok){ toast(T().aFail); renderSheet(); return; }
  if(a==='chatOff'||a==='chatOn') TT.setUserMod(u,{muted:a==='chatOff'});
  if(a==='delete')  deleteSelectedMsg(u.mid);
  try{ Telegram.WebApp.HapticFeedback.notificationOccurred('success'); }catch(e){}
  toast(T().aDone); closeAdmin();
}
function deleteSelectedMsg(mid){
  if(mid===undefined) return;
  const m=chatList.querySelector(`.msg[data-mid="${CSS.escape(String(mid))}"]`);
  if(m){ m.classList.add('bye'); setTimeout(()=>m.remove(),250); }
}
// taps on messages and on online users
chatList.addEventListener('click',e=>{
  const m=e.target.closest('.msg'); if(!m) return;
  openAdmin({...msgUser(m),mid:m.dataset.mid,me:m.classList.contains('me')});
});
document.getElementById('onlineAvs').addEventListener('click',e=>{
  const c=e.target.closest('.ou'); if(!c||c.classList.contains('more')) return;
  if(c.dataset.me==='true') return;
  openAdmin({name:c.title,id:c.dataset.uid,muted:c.dataset.muted==='true'});
});
function markClickable(){
  const a=isAdmin(); document.body.classList.toggle('is-admin',a);
  document.querySelectorAll('#onlineAvs .ou:not(.more)').forEach(c=>{
    const clickable=a&&c.dataset.me!=='true';
    if(clickable){c.tabIndex=0;c.setAttribute('role','button');}
    else{c.removeAttribute('tabindex');c.setAttribute('role','listitem');}
  });
}
document.getElementById('onlineAvs').addEventListener('keydown',e=>{
  if((e.key==='Enter'||e.key===' ')&&e.target.classList.contains('ou')&&e.target.dataset.me!=='true'){ e.preventDefault(); e.target.click(); }
});

// ---- Chat: search in the online list -------------------------------------------------
// Filters the online users by name. Optional server search (for users not in the list):
// TT.searchOnline = async (query) => [{name:'Sara'}, {name:'Ali', admin:'boy'}]
Object.assign(I18N.fa,{searchPh:'جستجو',noUsers:'کسی پیدا نشد'});
Object.assign(I18N.de,{searchPh:'Suchen',noUsers:'Niemand gefunden'});
Object.assign(I18N.en,{searchPh:'Search',noUsers:'No one found'});
const onSearch=document.getElementById('onlineSearch'), onNone=document.getElementById('onlineNone');
const normQ=t=>String(t||'').toLowerCase().replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[\u200c\s_@.-]/g,'')
  .replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
let srvSeq=0;
function filterOnline(){
  const q=normQ(onSearch.value); let shown=0;
  document.querySelectorAll('#onlineAvs .ou').forEach(c=>{
    if(c.classList.contains('more')){ c.hidden=!!q; return; }
    const hit=!q||normQ(c.title).includes(q); c.hidden=!hit; if(hit) shown++;
  });
  onNone.hidden=!(q&&shown===0);
  document.getElementById('onlineBar').classList.toggle('searching',!!q);
  if(q&&typeof TT.searchOnline==='function'){
    const my=++srvSeq, raw=onSearch.value.trim();
    clearTimeout(filterOnline._t);
    filterOnline._t=setTimeout(async()=>{
      try{ const list=await TT.searchOnline(raw); if(my!==srvSeq||!Array.isArray(list)) return;
        const have=new Set([...document.querySelectorAll('#onlineAvs .ou:not(.more)')].map(c=>c.title));
        const add=list.map(_u).filter(u=>!have.has(typeof u==='string'?u:u.name));
        if(add.length){ CHAT.online.users.push(...add); renderOnline(); }
      }catch(e){}
    },300);
  }
}
onSearch.addEventListener('input',filterOnline);
onSearch.addEventListener('keydown',e=>{ if(e.key==='Escape'){ onSearch.value=''; filterOnline(); } if(e.key==='Enter') onSearch.blur(); });
const _renderOnline2=renderOnline;
renderOnline=function(){ _renderOnline2(); filterOnline(); };

// own state (the user who got muted / banned)
const MY={muted:false,banned:false};
let CHAT_ENABLED=true;
const chatToggle=document.getElementById('chatToggle');
const canManageChat=()=>typeof TT.isChatAdmin==='function'?!!TT.isChatAdmin():isAdmin();
TT.setMyChatState=o=>{ o=o||{}; if('muted' in o) MY.muted=o.muted; if('banned' in o) MY.banned=!!o.banned; renderMyState(); };
TT.setChatEnabled=enabled=>{ CHAT_ENABLED=enabled!==false; renderMyState(); };
function myMuted(){ return MY.muted===true || (typeof MY.muted==='number' && MY.muted>Date.now()); }
function chatBlocked(){
  if(!CHAT_ENABLED&&!canManageChat()){ toast(T().chatClosed); return true; }
  if(MY.banned){ toast(T().youBanned); return true; }
  if(myMuted()){ toast(T().youMuted); return true; }
  return false;
}
function renderMyState(){
  const manager=canManageChat(), closed=!CHAT_ENABLED&&!manager, off=closed||MY.banned||myMuted();
  chatText.disabled=off; document.getElementById('chatSend').disabled=off;
  chatText.placeholder=closed?T().chatClosed:MY.banned?T().youBanned:off?T().youMuted:T().chatPh;
  chatToggle.hidden=!manager;
  chatToggle.textContent=CHAT_ENABLED?T().chatClose:T().chatOpen;
  chatToggle.classList.toggle('open',!CHAT_ENABLED);
}
chatToggle.addEventListener('click',async()=>{
  if(!canManageChat()||typeof TT.setChatEnabledServer!=='function') return;
  chatToggle.disabled=true;
  let ok=false;
  try{ ok=await TT.setChatEnabledServer(!CHAT_ENABLED); }catch(e){ console.error('[chat] global toggle failed',e); }
  chatToggle.disabled=false;
  if(!ok) toast(T().aFail);
});
// hooks for your server / refresh
TT.setUserMod=(u,st)=>{
  st=st||{}; u=typeof u==='string'?{name:u}:u;
  if(u&&u.id!==undefined){
    const id=CSS.escape(String(u.id)), muted=st.muted===true?'true':'false';
    document.querySelectorAll(`#chatList .msg[data-uid="${id}"],#onlineAvs .ou[data-uid="${id}"]`).forEach(el=>{el.dataset.muted=muted});
  }
  setMod(u,{mute:st.muted===true?-1:(+st.muted||0),ban:st.banned?1:0});
};
const _renderOnline=renderOnline;
renderOnline=function(){ _renderOnline(); markClickable(); renderModMarks(); };
const _applyLang=applyLang;
applyLang=function(){ _applyLang(); onSearch.setAttribute('aria-label',T().searchPh); renderModMarks(); renderReplyBar(); document.querySelectorAll('#chatList .rp').forEach(r=>{r.setAttribute('aria-label',T().reply);r.title=T().reply;}); document.querySelectorAll('#chatList .rx-btn').forEach(r=>{r.setAttribute('aria-label',T().react);r.title=T().react;}); document.querySelectorAll('#chatList .msg').forEach(renderReactions); document.querySelectorAll('#chatList .msg').forEach(renderTime); renderMyState(); if(admSheet&&!admSheet.hidden) renderSheet(); };
setInterval(()=>{ renderModMarks(); renderMyState(); if(admSheet&&!admSheet.hidden) renderSheet(); },30000);   // mutes run out
renderOnline(); renderMyState();

// ---- Task: join Telegram channels ------------------------------------------------
// TASK.demo:true -> "Check membership" completes right away (frontend demo only).
// For production set demo:false and provide TT.verifyMembership(channel) -> Promise<boolean>
// that asks YOUR server (bot getChatMember). Credit the reward on the server, not here.
// Add another channel = add one entry to TASKS; it appears as another row inside the same card.
// demo:false because server-bridge.js wires TT.verifyMembership() to the real
// /api/tasks/channel-claim, /api/tasks/withdraw-channel-claim & /api/tasks/third-channel-claim
// endpoints for all 3 channels below.
const TASK={demo:false};
// Reward is 5 TT per channel (the server persists each claim exactly once).
const TASKS=[
  {id:'withdraw', channel:'TaxitonWithdraw', reward:5, desc:'tkDesc',  key:'tt_task_channel'},
  {id:'main',     channel:'TaxiiTon',        reward:5, desc:'tkDesc2', key:'tt_task_main'},
  {id:'third',    channel:'taxiiiton',       reward:5, desc:'tkDesc2', key:'tt_task_third'}
];
const tkRow=t=>`<div class="tk-ch" data-task="${t.id}">
    <div class="tk-row">
      <button class="tk-open" type="button"><img src="assets/images/tg-btn.png" alt=""><span>@${t.channel}</span></button>
      <button class="tk-check" type="button" data-i="tkCheck"></button>
    </div>
    <div class="tk-status" hidden>
      <svg class="tk-ico" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="tkG_${t.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cc4ff"/><stop offset="1" stop-color="#1e6bff"/></linearGradient></defs>
        <path d="M8 6h32a3 3 0 0 1 2.4 4.8L26 41a3 3 0 0 1-4 0L5.6 10.8A3 3 0 0 1 8 6z" fill="url(#tkG_${t.id})" stroke="#bfe6ff" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M14 14h20L24 34z" fill="#fff"/></svg>
      <span class="tk-stxt"></span>
    </div>
  </div>`;
// ONE card with all channels inside
const tkHtml=()=>`<div class="art task-art" id="taskArt">
  <img src="assets/images/task-channel.jpg" alt="">
  <div class="tk-content">
    <div class="tk-title" data-i="tkJoinAll"></div>
    <div class="tk-desc" data-i="tkDescAll"></div>
    <div class="tk-reward"></div>
    ${TASKS.map(tkRow).join('')}
  </div>
</div>`;
function renderTask(){
  const card=document.getElementById('taskArt'); if(!card) return;
  card.querySelector('.tk-reward').textContent=T().tkRewardAll.replace('{n}',nf(TASKS[0].reward));
  TASKS.forEach(t=>{
    const el=t.el; if(!el) return;
    const st=el.querySelector('.tk-status'); st.hidden=!t.msg; st.dataset.s=t.msg;
    el.querySelector('.tk-stxt').textContent=t.msg==='done'?T().tkDone.replace('{n}',nf(t.reward)):t.msg==='no'?T().tkNo:'';
    el.classList.toggle('done',t.done);
    el.querySelector('.tk-open').setAttribute('aria-label',T().tkOpen+' @'+t.channel);
  });
}
function completeTask(t){
  t.done=true; store(t.key,true); t.msg='done'; renderTask();
  try{ TT.onTaskComplete && TT.onTaskComplete(t.id,t.reward,t.channel); }catch(e){}
}
const tasksBox=document.getElementById('taskCards');
tasksBox.innerHTML=tkHtml();
TASKS.forEach(t=>{
  t.done=!!store(t.key); t.msg=t.done?'done':'';
  t.el=tasksBox.querySelector(`.tk-ch[data-task="${t.id}"]`);
  t.el.querySelector('.tk-open').addEventListener('click',()=>{
    const url='https://t.me/'+t.channel;
    try{ const tg=window.Telegram&&Telegram.WebApp; if(tg&&tg.openTelegramLink){ tg.openTelegramLink(url); return; } }catch(e){}
    window.open(url,'_blank','noopener');
  });
  t.el.querySelector('.tk-check').addEventListener('click',async()=>{
    if(t.done) return;
    let ok=TASK.demo;
    try{ if(typeof TT.verifyMembership==='function') ok=await TT.verifyMembership(t.channel); }catch(e){ ok=false; }
    if(ok) completeTask(t); else { t.msg='no'; renderTask(); }
  });
});
// Real: server-bridge.js calls TT.setTasks({withdraw:true/false, main:true/false}) on load,
// using the server's own taskChannelRewardClaimed/withdrawChannelTaskRewardClaimed flags -
// so a task already completed on the server shows as done immediately, without re-clicking
// "Check membership" first (exactly like the old design's server-driven task cards).
TT.setTasks=o=>{
  o=o||{};
  TASKS.forEach(t=>{ if(o[t.id]===true && !t.done){ t.done=true; store(t.key,true); t.msg='done'; } });
  renderTask();
};

// ---- Task: watch rewarded videos (matches the old design's real "Watch 10 videos" task,
// which pays 0.03 TON total via Adsgram + POST /api/tasks/ad-video-claim). ------------------
// Real: server-bridge.js provides TT.watchRewardedAd() -> Promise<{ok, watched, completed}>
// and feeds initial state via TT.setAdsTask({watched, completed}) from the server session.
// Local/demo fallback only (no TT.watchRewardedAd defined): just increments a local counter
// so the UI/flow can still be tested outside Telegram.
const ADS={watched:0, completed:false};
function renderAdsTask(){
  const prog=document.getElementById('adsProgress'), btn=document.getElementById('adsWatchBtn'), st=document.getElementById('adsStatus');
  if(!prog||!btn||!st) return;
  prog.textContent=nf(ADS.watched)+' / '+nf(10);
  btn.disabled=ADS.completed;
  btn.textContent=ADS.completed?T().adsCompleted:T().watchVideo;
  st.textContent=ADS.completed?T().adsDone:'';
}
document.getElementById('adsWatchBtn').addEventListener('click',async()=>{
  const btn=document.getElementById('adsWatchBtn'), st=document.getElementById('adsStatus');
  if(ADS.completed) return;
  btn.disabled=true; st.textContent='';
  try{
    if(typeof TT.watchRewardedAd==='function'){
      const r=await TT.watchRewardedAd();
      if(r&&r.notReady){ st.textContent=T().adsNotReady; }
      else if(!r||!r.ok){ st.textContent=T().adsFailed; }
      if(r&&r.watched!==undefined) ADS.watched=Math.max(0,Math.min(10,+r.watched||0));
      if(r&&r.completed!==undefined) ADS.completed=!!r.completed;
    } else {
      ADS.watched=Math.min(10,ADS.watched+1);
      if(ADS.watched>=10) ADS.completed=true;
    }
  }catch(e){ st.textContent=T().adsFailed; }
  renderAdsTask();
});
TT.setAdsTask=o=>{ o=o||{}; if(o.watched!==undefined) ADS.watched=Math.max(0,Math.min(10,+o.watched||0)); if(o.completed!==undefined) ADS.completed=!!o.completed; renderAdsTask(); };
renderAdsTask();

// ---- Invite friends -------------------------------------------------------------
// bot: your bot's username (the personal link is t.me/<bot>?start=ref_<telegramUserId>).
// endsAt: campaign end (ISO string / Date). null = same weekly reset as the tournament.
// Handle the "ref_<id>" start parameter in your bot/backend to count invites.
const INVITE={bot:'TaxiTronBot', endsAt:null};
function inviteLink(){
  let uid=null;
  try{ const u=window.Telegram&&Telegram.WebApp.initDataUnsafe&&Telegram.WebApp.initDataUnsafe.user; uid=u&&u.id; }catch(e){}
  return 'https://t.me/'+INVITE.bot+(uid?'?start=ref_'+uid:'');
}
document.getElementById('ivBtn').addEventListener('click',()=>{
  const link=(typeof TT.inviteLink==='function')?TT.inviteLink():inviteLink();
  const url='https://t.me/share/url?url='+encodeURIComponent(link)+'&text='+encodeURIComponent(T().invShare);
  try{ const tg=window.Telegram&&Telegram.WebApp; if(tg&&tg.openTelegramLink){ tg.openTelegramLink(url); return; } }catch(e){}
  window.open(url,'_blank','noopener');
});
function ivTick(){
  const el=document.getElementById('ivCount'); if(!el) return;
  const end=INVITE.endsAt?new Date(INVITE.endsAt):nextReset();
  const diff=end-new Date();
  if(diff<=0 && INVITE.endsAt){ el.textContent=T().invEnded||'Campaign ended'; return; }
  let s=Math.max(0,Math.floor(diff/1000));
  const d=Math.floor(s/86400); s%=86400; const h=Math.floor(s/3600); s%=3600; const m=Math.floor(s/60); s%=60;
  const p=n=>String(n).padStart(2,'0');
  el.textContent=`${d}d ${p(h)}h ${p(m)}m ${p(s)}s`;
}

// Invite leaderboard (top 3 inviters win TON): fed by server-bridge.js via TT.setInviteLeaderboard(data).
var IV_LAST_DATA=null;
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderInviteLeaderboard(data){
  data=data||IV_LAST_DATA; if(!data) return;
  IV_LAST_DATA=data;
  if(data.endsAt) INVITE.endsAt=data.endsAt;
  const you=document.getElementById('ivYou');
  const list=document.getElementById('ivList');
  if(you){
    if(data.settled){
      you.textContent=T().ivSettled;
    }else if(data.you && data.you.rank){
      you.textContent=`${T().ivYourRank}: #${data.you.rank} · ${data.you.invites||0} ${T().ivInvites}`;
    }else{
      you.textContent=T().ivNoInvites;
    }
  }
  if(list){
    const rows=data.settled?(data.winners||[]):(data.top||[]);
    if(!rows.length){
      list.innerHTML=`<div class="tk-lb-empty">${escapeHtml(T().ivNoInvites)}</div>`;
    }else{
      list.innerHTML=rows.map((r,i)=>{
        const rank=i+1;
        return `<div class="tk-lb-row rank-${rank}"><span class="rank">#${rank}</span><span class="name">${escapeHtml(r.name||'')}</span><span class="invites">${r.invites||0} ${escapeHtml(T().ivInvites)}</span><span class="reward">${r.reward} TON</span></div>`;
      }).join('');
    }
  }
  ivTick();
}
TT.setInviteLeaderboard=renderInviteLeaderboard;

// Tabs
const tabs=document.querySelectorAll('.tab');
document.body.classList.toggle('chat-open',document.querySelector('#chat').classList.contains('active'));
tabs.forEach(t=>{
  t.setAttribute('aria-selected',t.classList.contains('active'));
  t.addEventListener('click',()=>{
    // "Game" tab opens the real Monster Crash game directly (matches old design's
    // navButtons handler: dataset.screen==='game-menu' -> location.href='/monster-crash/').
    if(t.dataset.s==='game'){ window.location.href='/monster-crash/'; return; }
    tabs.forEach(x=>{x.classList.remove('active');x.setAttribute('aria-selected','false')});
    t.classList.add('active');t.setAttribute('aria-selected','true');
    document.querySelectorAll('.screen').forEach(s=>s.classList.toggle('active',s.id===t.dataset.s));
    document.body.classList.toggle('chat-open',t.dataset.s==='chat');
    if(t.dataset.s==='chat') requestAnimationFrame(()=>scrollChatToEnd(false));
    window.scrollTo(0,0);
    try{window.Telegram&&Telegram.WebApp.HapticFeedback.selectionChanged()}catch(e){}
  });
});

// Weekly reset: matches the real server (server.js berlinDayKey/berlinWeekKey) - the
// tournament resets every Sunday 00:00 Europe/Berlin time, not a fixed UTC weekday/hour.
function berlinOffsetMinutes(date){
  const utcStr=date.toLocaleString('en-US',{timeZone:'UTC'});
  const berlinStr=date.toLocaleString('en-US',{timeZone:'Europe/Berlin'});
  return (new Date(berlinStr)-new Date(utcStr))/60000;
}
function nextReset(){
  const now=new Date();
  const offsetMin=berlinOffsetMinutes(now);
  const berlinNow=new Date(now.getTime()+offsetMin*60000);
  const dow=berlinNow.getUTCDay(); // 0 = Sunday, using UTC getters on the shifted date = Berlin wall clock
  const daysUntilSunday=(7-dow)%7;
  let target=new Date(Date.UTC(berlinNow.getUTCFullYear(),berlinNow.getUTCMonth(),berlinNow.getUTCDate()+daysUntilSunday,0,0,0,0));
  if(target<=berlinNow) target=new Date(target.getTime()+7*86400000);
  const targetOffsetMin=berlinOffsetMinutes(new Date(target.getTime()-offsetMin*60000));
  return new Date(target.getTime()-targetOffsetMin*60000);
}
const fa=n=>{const s=String(n).padStart(2,'0');return lang==='fa'?s.replace(/\d/g,d=>'۰۱۲۳۴۵۶۷۸۹'[d]):s;};
const cd=document.getElementById('countdown');
function tick(){
  // Matches old design: always show days + hours + minutes together (never collapse
  // to just h/m once a day is left), so a multi-day countdown still shows the minutes.
  let m=Math.max(0,Math.floor((nextReset()-new Date())/60000));
  const d=Math.floor(m/1440); m%=1440; const h=Math.floor(m/60); m%=60;
  cd.innerHTML=`${fa(d)} <small>${T().d}</small> ${fa(h)} <small>${T().h}</small> ${fa(m)} <small>${T().m}</small>`;
}

// ---- Tournament leaderboard --------------------------------------------------------------
// Your server: TT.setLeaderboard([{name, score, me}, ...])  already sorted best-first;
// 'me' flags your own row (rendered with an extra "You" badge next to the name).
const lbList=document.getElementById('lbList');
TT.setLeaderboard=(entries)=>{
  if(!lbList) return;
  entries=Array.isArray(entries)?entries:[];
  lbList.innerHTML='';
  if(!entries.length){ const e=document.createElement('div'); e.className='lb-empty'; e.textContent=T().lbEmpty; lbList.append(e); return; }
  entries.forEach((e,i)=>{
    const rank=i+1;
    const row=document.createElement('div');
    row.className='lb-row'+(e.me?' me':'')+(rank<=3?' r'+rank:'');
    const rk=document.createElement('div'); rk.className='lb-rank'; rk.textContent=rank;
    const av=document.createElement('span'); av.className='lb-av'; av.textContent='🧟';
    const nm=document.createElement('div'); nm.className='lb-name';
    const nameText=document.createElement('span'); nameText.className='lb-user-name'; nameText.textContent=e.name||T().youTag;
    nm.append(nameText);
    if(e.admin) nm.append(admBadge(e.admin,26));
    if(e.me){ const tag=document.createElement('span'); tag.className='lb-you'; tag.textContent=T().youTag; nm.append(tag); }
    const sc=document.createElement('div'); sc.className='lb-score'; sc.textContent=(e.score||0)+' 🧟';
    row.append(rk,av,nm,sc);
    lbList.append(row);
  });
};
applyLang(); setInterval(tick,15000);
ivTick(); setInterval(ivTick,1000);

// ---- Wallet: exchange zombies -> coins --------------------------------------------------
// EX.rate = coins per zombie. Demo values are kept in the browser (tt_zombies / tt_coins).
// Live: TT.setWallet({zombies:1287, coins:5000})   after fetch('/api/me')
//       TT.exchange = async (zombies) => ({zombies:0, coins:newBalance})   -> your server does the exchange (return false = error)
//       TT.addZombies(n)   e.g. after a run or a task
const tonFmt=(n,d)=>{ const s=(+n).toLocaleString('en-US',{minimumFractionDigits:d===undefined?2:d,maximumFractionDigits:d===undefined?6:d,useGrouping:false}); return lang==='fa'?s.replace(/\d/g,x=>'۰۱۲۳۴۵۶۷۸۹'[x]):s; };
const EX={rate:100, zombies:store('tt_zombies'), coins:store('tt_coins'), points:store('tt_wd_bal'), tt:store('tt_balance')};
if(typeof EX.zombies!=='number') EX.zombies=10000;   // demo start value
if(typeof EX.coins!=='number') EX.coins=0;
if(typeof EX.points!=='number') EX.points=0;
if(typeof EX.tt!=='number') EX.tt=0;
Object.assign(I18N.fa,{exZcap:'جمع‌آوری شده – هنوز معاوضه نشده',exRate:'{n} سکه به ازای هر زامبی',exBtn:'معاوضه ({n} {c} به ازای هر زامبی)',exBal:'موجودی TON:',ttBal:'موجودی TT:',tkRewardAll:'پاداش: {n} TT',tkDone:'+{n} TT دریافت شد',exDone:'+{n} سکه به کیف پول اضافه شد 🎉',exNone:'زامبی برای معاوضه نداری',exFail:'معاوضه انجام نشد – دوباره امتحان کن'});
Object.assign(I18N.de,{exZcap:'Gesammelt – noch nicht getauscht',exRate:'{n} Münzen pro Zombie',exBtn:'Tauschen ({n} {c} pro Zombie)',exBal:'TON-Guthaben:',ttBal:'TT-Guthaben:',tkRewardAll:'Belohnung: {n} TT',tkDone:'+{n} TT erhalten',exDone:'+{n} Münzen gutgeschrieben 🎉',exNone:'Du hast keine Zombies zum Tauschen',exFail:'Tausch fehlgeschlagen – bitte nochmal'});
Object.assign(I18N.en,{exZcap:'Collected – not yet exchanged',exRate:'{n} coins per zombie',exBtn:'Exchange ({n} {c} per zombie)',exBal:'TON balance:',ttBal:'TT balance:',tkRewardAll:'Reward: {n} TT',tkDone:'+{n} TT received',exDone:'+{n} coins added to your wallet 🎉',exNone:'You have no zombies to exchange',exFail:'Exchange failed – try again'});
const bigN=n=>Math.round(n).toLocaleString(LOCALE[lang]||'en-GB');
function renderWallet(){
  const $=id=>document.getElementById(id);
  $('exZ').textContent=bigN(EX.zombies);
  $('exC').textContent=bigN(EX.zombies*EX.rate);
  $('exRate').textContent=T().exRate.replace('{n}',bigN(EX.rate));
  $('exBalN').textContent=tonFmt(EX.points,6);
  $('ttBalN').textContent=tonFmt(EX.tt,0);
  const [a,b]=T().exBtn.split('{c}'), btn=$('exBtn'); btn.textContent='';
  const coin=document.createElement('img'); coin.src='assets/images/ex-coin.png'; coin.alt=T().coinsShort; coin.className='ex-bcoin';
  btn.append(a.replace('{n}',bigN(EX.rate)),coin,b);
  btn.classList.toggle('empty',EX.zombies<=0);
}
function saveWallet(){ store('tt_zombies',EX.zombies); store('tt_coins',EX.coins); store('tt_wd_bal',EX.points); store('tt_balance',EX.tt); }
function countUp(el,from,to,ms){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){ el.textContent=bigN(to); return; }
  const t0=performance.now();
  (function f(t){ const k=Math.min(1,(t-t0)/ms), e=1-Math.pow(1-k,3); el.textContent=bigN(from+(to-from)*e); if(k<1) requestAnimationFrame(f); })(t0);
}
function countUpTon(el,from,to,ms){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){ el.textContent=tonFmt(to,6); return; }
  const t0=performance.now();
  (function f(t){ const k=Math.min(1,(t-t0)/ms), e=1-Math.pow(1-k,3); el.textContent=tonFmt(from+(to-from)*e,6); if(k<1) requestAnimationFrame(f); })(t0);
}
let exBusy=false;
document.getElementById('exBtn').addEventListener('click',async()=>{
  if(exBusy) return;
  if(EX.zombies<=0){ toast(T().exNone); return; }
  exBusy=true; const btn=document.getElementById('exBtn'); btn.disabled=true;
  const z=EX.zombies, gain=z*EX.rate, oldCoins=EX.coins, oldPoints=EX.points;
  let res={zombies:0, coins:oldCoins+gain, points:oldPoints};
  try{ if(typeof TT.exchange==='function'){ const r=await TT.exchange(z); if(r===false) throw 0; if(r&&typeof r==='object') res={zombies:+r.zombies||0, coins:+r.coins||0, points:r.points!==undefined?+r.points||0:oldPoints}; } }
  catch(e){ toast(T().exFail); exBusy=false; btn.disabled=false; return; }
  EX.zombies=res.zombies; EX.coins=res.coins; EX.points=res.points; saveWallet();
  const $=id=>document.getElementById(id);
  countUp($('exZ'),z,EX.zombies,700); countUp($('exC'),gain,EX.zombies*EX.rate,700); countUpTon($('exBalN'),oldPoints,EX.points,900);
  $('exBalN').parentElement.classList.remove('pop'); void $('exBalN').offsetWidth; $('exBalN').parentElement.classList.add('pop');
  try{ Telegram.WebApp.HapticFeedback.notificationOccurred('success'); }catch(e){}
  toast(T().exDone.replace('{n}',bigN(res.coins-oldCoins)));
  setTimeout(()=>{ exBusy=false; btn.disabled=false; renderWallet(); },950);
});
TT.setWallet=o=>{ o=o||{}; if(o.zombies!==undefined) EX.zombies=Math.max(0,+o.zombies||0); if(o.coins!==undefined) EX.coins=Math.max(0,+o.coins||0); if(o.rate) EX.rate=+o.rate; if(o.points!==undefined) EX.points=Math.max(0,+o.points||0); if(o.tt!==undefined) EX.tt=Math.max(0,+o.tt||0); saveWallet(); renderWallet(); };
TT.addZombies=n=>{ EX.zombies=Math.max(0,EX.zombies+(+n||0)); saveWallet(); renderWallet(); };
TT.getWallet=()=>({zombies:EX.zombies, coins:EX.coins, rate:EX.rate, points:EX.points, tt:EX.tt});
const _applyLangW=applyLang;
applyLang=function(){ _applyLangW(); renderWallet(); };
renderWallet();

// ---- Wallet: deposit TON ----------------------------------------------------------------
// !!! Put YOUR real TON wallet address here (copy it from Tonkeeper) – money sent to a wrong address is lost !!!
// Memo = 'TT' + Telegram user ID, so your server can match the deposit to the player.
// Server hook: TT.checkDeposit = async (txHash, memo) => ({ok:true, amount:1.5})  |  ({ok:false})
// Set from server/config: TT.setDeposit({address:'UQ…', memo:'TT123'})
const DEPOSIT={address:'', memoPrefix:'TT'};
Object.assign(I18N.fa,{depT:'واریز تون',depSub:'برای افزایش موجودی درون‌بازی، تون را به این آدرس ارسال کنید.',depCopy:'کپی آدرس',depCopied:'آدرس کپی شد ✔',depMemoCopied:'کد memo کپی شد ✔',
  depMemoTxt:'مهم: این کد را به‌عنوان توضیح/یادداشت (memo) انتقال وارد کنید، در غیر این صورت واریز شما به‌طور خودکار به حساب شما تطبیق داده نمی‌شود.',
  depTx:'شناسه تراکنش TON',depTxPh:'هش تراکنش را وارد کنید',depCheck:'بررسی واریز',depChecking:'در حال بررسی…',depNoHash:'اول شناسه تراکنش را وارد کن',
  depFound:'واریز {n} TON تأیید شد 🎉',depNotYet:'هنوز پیدا نشد – چند دقیقه دیگر دوباره امتحان کن',
  depNote:'فقط از شبکه TON استفاده کنید. واریزها چند دقیقه پس از تأیید شبکه به حساب شما اضافه می‌شوند.',depHome:'بازگشت به خانه',depNoAddr:'آدرس هنوز تنظیم نشده'});
Object.assign(I18N.de,{depT:'TON einzahlen',depSub:'Sende TON an diese Adresse, um dein Spielguthaben aufzuladen.',depCopy:'Adresse kopieren',depCopied:'Adresse kopiert ✔',depMemoCopied:'Memo-Code kopiert ✔',
  depMemoTxt:'Wichtig: Gib diesen Code als Kommentar/Memo der Überweisung ein, sonst kann deine Einzahlung nicht automatisch deinem Konto zugeordnet werden.',
  depTx:'TON-Transaktions-ID',depTxPh:'Transaktions-Hash eingeben',depCheck:'Einzahlung prüfen',depChecking:'Wird geprüft…',depNoHash:'Bitte zuerst die Transaktions-ID eingeben',
  depFound:'Einzahlung von {n} TON bestätigt 🎉',depNotYet:'Noch nicht gefunden – bitte in ein paar Minuten nochmal',
  depNote:'Nur das TON-Netzwerk verwenden. Einzahlungen erscheinen wenige Minuten nach der Bestätigung auf deinem Konto.',depHome:'Zurück zum Start',depNoAddr:'Adresse noch nicht eingestellt'});
Object.assign(I18N.en,{depT:'Deposit TON',depSub:'Send TON to this address to top up your in-game balance.',depCopy:'Copy address',depCopied:'Address copied ✔',depMemoCopied:'Memo code copied ✔',
  depMemoTxt:'Important: enter this code as the comment/memo of the transfer, otherwise your deposit cannot be matched to your account automatically.',
  depTx:'TON transaction ID',depTxPh:'Enter the transaction hash',depCheck:'Check deposit',depChecking:'Checking…',depNoHash:'Enter the transaction ID first',
  depFound:'Deposit of {n} TON confirmed 🎉',depNotYet:'Not found yet – try again in a few minutes',
  depNote:'Use the TON network only. Deposits show up on your account a few minutes after confirmation.',depHome:'Back to home',depNoAddr:'Address not set yet'});
function depMemo(){
  if(DEPOSIT.memo) return DEPOSIT.memo;
  const u=tgUser(); if(u&&u.id) return DEPOSIT.memoPrefix+u.id;
  let id=store('tt_uid'); if(!id){ id=String(Math.floor(1e9+Math.random()*9e9)); store('tt_uid',id); }   // outside Telegram (testing)
  return DEPOSIT.memoPrefix+id;
}
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); return true; }catch(e){}
  try{ const a=document.createElement('textarea'); a.value=t; a.setAttribute('readonly',''); a.style.cssText='position:fixed;opacity:0;top:0';
    document.body.append(a); a.select(); const ok=document.execCommand('copy'); a.remove(); return ok; }catch(e){ return false; }
}
function renderDeposit(){
  const $=id=>document.getElementById(id), has=!!DEPOSIT.address;
  $('depAddr').textContent=has?DEPOSIT.address:T().depNoAddr; $('depAddr').classList.toggle('none',!has);
  $('depCopy').disabled=!has; $('depCopyIc').disabled=!has;
  $('depCopyIc').setAttribute('aria-label',T().depCopy);
  $('depMemo').textContent=depMemo(); $('depMemo').setAttribute('aria-label',T().depMemoCopied.replace(' ✔',''));
}
const doCopyAddr=async()=>{ if(DEPOSIT.address&&await copyText(DEPOSIT.address)){ toast(T().depCopied); try{Telegram.WebApp.HapticFeedback.notificationOccurred('success')}catch(e){} } };
document.getElementById('depCopy').addEventListener('click',doCopyAddr);
document.getElementById('depCopyIc').addEventListener('click',doCopyAddr);
document.getElementById('depMemo').addEventListener('click',async()=>{ if(await copyText(depMemo())) toast(T().depMemoCopied); });
TT.setDeposit=o=>{ o=o||{}; if(o.address!==undefined) DEPOSIT.address=String(o.address).trim(); if(o.memo!==undefined) DEPOSIT.memo=o.memo; if(o.memoPrefix) DEPOSIT.memoPrefix=o.memoPrefix; renderDeposit(); };
const _applyLangD=applyLang;
applyLang=function(){ _applyLangD(); renderDeposit(); };
renderDeposit();

// ---- Wallet: withdraw TON ---------------------------------------------------------------
// Switch Deposit / Withdraw with the two tabs at the top of the second card.
// WD.balance = withdrawable TON (demo: kept in the browser). Live: TT.setWithdraw({balance:0.051078, status:'pending'})
// Server: TT.requestWithdraw = async ({address, amount, fee, receive, memo}) => ({ok:true, balance:newBalance, status:'pending'})
// memo is optional (user-entered, e.g. exchange deposit tag) and is undefined when left blank.
//         The server must check the balance and send the TON itself – never trust the page.
const WD={balance:+store('tt_wd_bal')||0, min:1, fee:0.01, last:store('tt_wd_last')};
Object.assign(I18N.fa,{dwDep:'واریز',dwWd:'برداشت',wdT:'برداشت TON',wdAvail:'قابل برداشت',wdAddrPh:'UQ… آدرس کیف پول TON',wdAmtPh:'مقدار (حداقل {n} TON)',wdMemoPh:'یادداشت (در صورت نیاز)',
  wdReq:'درخواست برداشت',wdMinL:'حداقل برداشت',wdMyAddrL:'آدرس کیف پول شما',wdRecv:'دریافتی شما: {n} TON (کارمزد {f} TON)',
  wdNote1:'حداقل برداشت {n} TON است. درخواست‌ها بررسی و به آدرس کیف پول شما ارسال می‌شوند.',wdNote2:'{p}٪ کارمزد برداشت کسر می‌شود. شما {r}٪ مبلغ درخواستی را دریافت می‌کنید.',
  wdBadAddr:'آدرس کیف پول TON معتبر نیست',wdBadAmt:'مقدار را وارد کن',wdLow:'حداقل برداشت {n} TON است',wdNoFunds:'موجودی کافی نیست',buyErr:'خرید انجام نشد. دوباره تلاش کنید.',
  wdSent:'درخواست برداشت ثبت شد ✔',wdFail:'درخواست ثبت نشد – دوباره امتحان کن',stNone:'بدون درخواست',stPending:'در حال بررسی\n{n} TON',stDone:'انجام شد',stRejected:'رد شد'});
Object.assign(I18N.de,{dwDep:'Einzahlen',dwWd:'Auszahlen',wdT:'TON auszahlen',wdAvail:'verfügbar',wdAddrPh:'UQ… TON-Wallet-Adresse',wdAmtPh:'Betrag (min. {n} TON)',wdMemoPh:'Memo (falls nötig)',
  wdReq:'Auszahlung anfordern',wdMinL:'Mindestauszahlung',wdMyAddrL:'Deine Wallet-Adresse',wdRecv:'Du erhältst: {n} TON (Gebühr {f} TON)',
  wdNote1:'Mindestauszahlung ist {n} TON. Anfragen werden geprüft und an deine Wallet-Adresse gesendet.',wdNote2:'Es wird {p} % Auszahlungsgebühr abgezogen. Du erhältst {r} % des Betrags.',
  wdBadAddr:'Keine gültige TON-Wallet-Adresse',wdBadAmt:'Bitte Betrag eingeben',wdLow:'Mindestauszahlung ist {n} TON',wdNoFunds:'Nicht genug Guthaben',buyErr:'Kauf fehlgeschlagen. Bitte erneut versuchen.',
  wdSent:'Auszahlung angefordert ✔',wdFail:'Anfrage fehlgeschlagen – bitte nochmal',stNone:'Keine Anfrage',stPending:'Wird geprüft\n{n} TON',stDone:'Erledigt',stRejected:'Abgelehnt'});
Object.assign(I18N.en,{dwDep:'Deposit',dwWd:'Withdraw',wdT:'Withdraw TON',wdAvail:'available',wdAddrPh:'UQ… TON wallet address',wdAmtPh:'Amount (min {n} TON)',wdMemoPh:'Memo (if required)',
  wdReq:'Request withdrawal',wdMinL:'Minimum withdrawal',wdMyAddrL:'Your wallet address',wdRecv:'You receive: {n} TON (fee {f} TON)',
  wdNote1:'Minimum withdrawal is {n} TON. Requests are reviewed and sent to your wallet address.',wdNote2:'A {p}% withdrawal fee is deducted. You receive {r}% of the requested amount.',
  wdBadAddr:'Not a valid TON wallet address',wdBadAmt:'Enter an amount',wdLow:'Minimum withdrawal is {n} TON',wdNoFunds:'Not enough balance',buyErr:'Purchase failed. Please try again.',
  wdSent:'Withdrawal requested ✔',wdFail:'Request failed – try again',stNone:'No request',stPending:'Under review\n{n} TON',stDone:'Completed',stRejected:'Rejected'});
const TON_ADDR=/^(?:[EUk0]Q[A-Za-z0-9_-]{46}|-?[0-9]:[0-9a-fA-F]{64})$/;
const toLatin=t=>String(t||'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٫,]/g,'.').replace(/\s/g,'');
const shortAddr=a=>a&&a.length>12?a.slice(0,4)+'…'+a.slice(-4):(a||'—');
function wdAmount(){ const v=parseFloat(toLatin(document.getElementById('wdAmt').value)); return isNaN(v)?0:v; }
function renderWithdraw(){
  const $=id=>document.getElementById(id), T_=T();
  $('wdBal').textContent=tonFmt(WD.balance,6)+' TON';
  $('wdMin').textContent=tonFmt(WD.min)+' TON';
  $('wdAmt').placeholder=T_.wdAmtPh.replace('{n}',tonFmt(WD.min,0));
  $('wdAddr').placeholder=T_.wdAddrPh;
  $('wdMemo').placeholder=T_.wdMemoPh;
  const pct=Math.round(WD.fee*1000)/10;
  $('wdNote1').textContent=T_.wdNote1.replace('{n}',tonFmt(WD.min,0));
  $('wdNote2').textContent=T_.wdNote2.replace('{p}',lang==='fa'?nf(pct):pct).replace('{r}',lang==='fa'?nf(100-pct):100-pct);
  const a=wdAmount(); $('wdRecv').textContent=a>0?T_.wdRecv.replace('{n}',tonFmt(a*(1-WD.fee),4)).replace('{f}',tonFmt(a*WD.fee,4)):'';
  const L=WD.last; $('wdMyAddr').textContent=shortAddr((L&&L.address)||store('tt_wd_addr')||'');
  const st=L?L.status:'none', map={none:'stNone',pending:'stPending',completed:'stDone',rejected:'stRejected'};
  const el=$('wdStatus'); el.className='wd-status st-'+st;
  el.textContent=st==='pending' && L && Number.isFinite(Number(L.amount))
    ? T_[map[st]].replace('{n}',tonFmt(Number(L.amount),6))
    : T_[map[st]||'stNone'];
}
// tabs
document.querySelectorAll('.dw-tab').forEach(b=>b.addEventListener('click',()=>{
  const wd=b.dataset.dw==='wd';
  document.querySelectorAll('.dw-tab').forEach(x=>{ x.classList.toggle('on',x===b); x.setAttribute('aria-selected',x===b); });
  document.getElementById('depCard').hidden=wd; document.getElementById('wdCard').hidden=!wd;
}));
{ const saved=store('tt_wd_addr'); if(saved) document.getElementById('wdAddr').value=saved; }
{ const savedMemo=store('tt_wd_memo'); if(savedMemo) document.getElementById('wdMemo').value=savedMemo; }
document.getElementById('wdAmt').addEventListener('input',renderWithdraw);
document.getElementById('wdMax').addEventListener('click',()=>{ document.getElementById('wdAmt').value=String(Math.floor(WD.balance*1e6)/1e6); renderWithdraw(); });
document.getElementById('wdAddr').addEventListener('input',e=>e.target.classList.remove('bad'));
let wdBusy=false;
document.getElementById('wdBtn').addEventListener('click',async()=>{
  if(wdBusy) return;
  const $=id=>document.getElementById(id), addr=$('wdAddr').value.trim(), amt=wdAmount(), memo=$('wdMemo').value.trim();
  if(!TON_ADDR.test(addr)){ $('wdAddr').classList.add('bad'); toast(T().wdBadAddr); $('wdAddr').focus(); return; }
  if(!(amt>0)){ toast(T().wdBadAmt); $('wdAmt').focus(); return; }
  if(amt<WD.min){ toast(T().wdLow.replace('{n}',tonFmt(WD.min,0))); return; }
  if(amt>WD.balance+1e-9){ toast(T().wdNoFunds); return; }
  wdBusy=true; $('wdBtn').disabled=true;
  const req={address:addr, amount:amt, fee:+(amt*WD.fee).toFixed(9), receive:+(amt*(1-WD.fee)).toFixed(9), memo:memo||undefined};
  let r={ok:true, balance:WD.balance-amt, status:'pending'};
  try{ if(typeof TT.requestWithdraw==='function'){ const x=await TT.requestWithdraw(req); r=x&&typeof x==='object'?x:{ok:!!x}; } }catch(e){ r={ok:false}; }
  if(r.ok){
    if(r.balance!==undefined) WD.balance=Math.max(0,+r.balance);
    WD.last={address:addr, amount:amt, memo:memo||undefined, status:r.status||'pending', t:Date.now()};
    store('tt_wd_bal',WD.balance); store('tt_wd_last',WD.last); store('tt_wd_addr',addr); if(memo) store('tt_wd_memo',memo);
    $('wdAmt').value=''; toast(T().wdSent);
    try{ Telegram.WebApp.HapticFeedback.notificationOccurred('success'); }catch(e){}
  } else toast(T().wdFail);
  wdBusy=false; $('wdBtn').disabled=false; renderWithdraw();
});
TT.setWithdraw=o=>{ o=o||{};
  if(o.balance!==undefined){ WD.balance=Math.max(0,+o.balance||0); store('tt_wd_bal',WD.balance); }
  if(o.min!==undefined) WD.min=+o.min; if(o.fee!==undefined) WD.fee=+o.fee;
  if(o.status){ WD.last=Object.assign({},WD.last||{},{status:o.status}); store('tt_wd_last',WD.last); }
  renderWithdraw(); };
// Feed the real withdrawal history from GET /api/withdrawals so #wdStatus/#wdMyAddr reflect
// the actual most-recent request instead of only what was just submitted in this session.
TT.setWithdrawHistory=list=>{
  if(!Array.isArray(list) || !list.length) return;
  const l=list[list.length-1];
  WD.last={address:l.address, amount:l.amount, status:l.status||'pending', t:l.ts||Date.now()};
  store('tt_wd_last',WD.last);
  renderWithdraw();
};
const _applyLangWd=applyLang;
applyLang=function(){ _applyLangWd(); renderWithdraw(); };
renderWithdraw();
applyLang();   // once more, now that all texts (wallet, deposit) are registered
