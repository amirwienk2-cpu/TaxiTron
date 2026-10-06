// Gemeinsame Spiel-Logik (Teams, Zeitplan, Ergebnisse) – identisch mit index.html


const TIP=60000, PLAY=120000, POST=25000, CYCLE=TIP+PLAY+POST, LINE=2.5, P_OU=0.1;
const TEAMS=[["ستاره دانوب","#E94F4F","#FFFFFF","DAN"],["عقاب‌های آلپ","#3D7BE0","#FFFFFF","ALP"],["اتحاد شمال","#F2B84B","#1B1B1B","SHM"],["شیرهای کوهستان","#E94F4F","#2B2B6B","KOH"],["طوفان جنوب","#2FA866","#FFFFFF","TOF"],["دریاشهر","#16A3B8","#0B2A3A","DAR"],["دینامو پراتر","#7A4BD6","#FFFFFF","DIN"],["پلنگ‌های سیاه","#1B1B1B","#F2B84B","PAL"],["قطار غرب","#F28A3B","#FFFFFF","GHA"],["رئال سیمرینگ","#FFFFFF","#C9354A","REA"],["اینتر شهر","#2B4FA8","#111111","INT"],["آدمیرا بندر","#D93A8C","#FFFFFF","BAN"],["المپیا","#4A9E3F","#F2D04B","OLY"],["جنگل‌نشینان","#2E6B4F","#E8D9B0","JAN"],["پیشروان","#B8322E","#F4F4F4","PIS"],["اتحاد بریگیت","#5B6B7A","#FFFFFF","BRI"]];

const code=t=>t[3];
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function poisson(r,l){let L=Math.exp(-l),k=0,p=1;do{k++;p*=r()}while(p>L);return k-1}
const cache={};
function match(id){
  if(cache[id])return cache[id];
  const r=rng(id*2654435761%4294967296+17);
  const hi=Math.floor(r()*TEAMS.length);let ai;do{ai=Math.floor(r()*TEAMS.length)}while(ai===hi);
  const sh=.8+r()*.9, sa=.7+r()*.9;
  const gh=Math.min(poisson(r,sh*1.15),6),ga=Math.min(poisson(r,sa),6);
  const used=new Set(),min=()=>{let m;do{m=1+Math.floor(r()*90)}while(used.has(m));used.add(m);return m};
  const ev=[];
  for(let i=0;i<gh;i++)ev.push({m:min(),t:"goal",s:0});
  for(let i=0;i<ga;i++)ev.push({m:min(),t:"goal",s:1});
  const extra=4+Math.floor(r()*5);
  for(let i=0;i<extra;i++){const k=r();ev.push({m:min(),t:k<.45?"save":k<.75?"card":"post",s:r()<.5?0:1})}
  ev.sort((a,b)=>a.m-b.m);
  const ph=[r()*6,r()*6,r()*6,r()*6];
  // extra broadcast stats (drawn after the result, so results stay unchanged)
  const shots=[],corners=[],pos=Math.round(50+(sh-sa)*14+(r()-.5)*8);
  const ns=6+Math.floor(r()*8);for(let i=0;i<ns;i++)shots.push({m:1+Math.floor(r()*90),s:r()<sh/(sh+sa)?0:1});
  const nc=4+Math.floor(r()*7);for(let i=0;i<nc;i++)corners.push({m:1+Math.floor(r()*90),s:r()<sh/(sh+sa)?0:1});
  const nums=[[1,2,4,5,3,6,8,10,7,9,11],[1,2,4,5,3,6,8,10,7,9,11]].map(a=>a.map(n=>n+(r()<.2?10:0)));
  return cache[id]={id,h:TEAMS[hi],a:TEAMS[ai],sh,sa,gh,ga,ev,ph,shots,corners,pos:Math.max(35,Math.min(65,pos)),nums};
}
function clock(now){const id=Math.floor(now/CYCLE),t=now-id*CYCLE;
  if(t<TIP)return{id,ph:"tips",left:TIP-t,min:0};
  if(t<TIP+PLAY)return{id,ph:"live",min:(t-TIP)/PLAY*90,left:TIP+PLAY-t};
  return{id,ph:"post",min:90,left:CYCLE-t}}
function scoreAt(m,min){let h=0,a=0;for(const e of m.ev)if(e.t==="goal"&&e.m<=min){if(e.s)a++;else h++}return[h,a]}
function prize(m,tip){if(!tip||!tip.ou)return{ou:null,sum:0};const ou=(tip.ou==="over")===(m.gh+m.ga>LINE);return{ou,sum:ou?P_OU:0}}
function crest(t){const l=t[0].split(" ")[0][0];return `<svg viewBox="0 0 46 52" aria-hidden="true"><path d="M23 2 L42 8 V25 C42 38 33 46 23 50 C13 46 4 38 4 25 V8Z" fill="${t[1]}"/><path d="M23 2 L42 8 V25 C42 38 33 46 23 50Z" fill="#000" opacity=".12"/><path d="M4 18 H42 V24 H4Z" fill="${t[2]}" opacity=".95"/><circle cx="23" cy="31" r="8" fill="${t[2]}"/><text x="23" y="35" text-anchor="middle" font-family="Vazirmatn,Tahoma,sans-serif" font-weight="800" font-size="11" fill="${t[1]}">${l}</text></svg>`}
const tonFmt=v=>v.toFixed(1).replace(".",",");
const fmt=ms=>{const s=Math.ceil(ms/1000);return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")};


const SEASON=10,PTS=3,PRIZES=[2,1,0.5,0.1,0.1,0.1,0.1,0.1,0.1,0.1];
const seasonOf=id=>Math.floor(id/SEASON),firstOf=s=>s*SEASON;
const correct=(m,tip)=>!!tip&&!!tip.ou&&((tip.ou==="over")===(m.gh+m.ga>LINE));
// Tabelle einer Saison aus allen Tipps: {uid:{tips:{matchId:{ou,ts}}}}
function table(S,docs,now){
  const c=clock(now),fin=id=>id<c.id||(id===c.id&&c.ph==="post"),rows=[];
  for(const [id,d] of Object.entries(docs)){const tips=(d&&d.tips)||{};let pts=0,hits=0,played=0,sp=0,n=0;
    for(let mid=firstOf(S);mid<firstOf(S)+SEASON;mid++){const t=tips[mid];if(!t||!t.ou)continue;
      sp+=typeof t.ts==="number"?Math.max(0,t.ts-mid*CYCLE):TIP;n++;
      if(fin(mid)){played++;if(correct(match(mid),t)){pts+=PTS;hits++}}}
    if(n)rows.push({id,pts,hits,played,sp:sp/n})}
  rows.sort((a,b)=>b.pts-a.pts||a.sp-b.sp||(a.id<b.id?-1:1));rows.forEach((r,i)=>r.rank=i+1);return rows;
}
module.exports={TIP,PLAY,POST,CYCLE,SEASON,PRIZES,clock,match,seasonOf,firstOf,table};
