import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.querySelector('#game');
const container = document.querySelector('#game-container');
const panel = document.querySelector('#panel');
const card = document.querySelector('#card');
const scoreEl = document.querySelector('#score');
const coinsEl = document.querySelector('#coins');
const heartsEl = document.querySelector('#hearts');
const distEl = document.querySelector('#distance');
const comboEl = document.querySelector('#combo');
const muteBtn = document.querySelector('#mute');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x09060d);
scene.fog = new THREE.Fog(0x130b1b, 26, 145);
const camera = new THREE.PerspectiveCamera(56, 1, 0.1, 220);
camera.position.set(0, 5.4, 14.2);
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x09060d, 1);

const hemi = new THREE.HemisphereLight(0x4b376f, 0x100914, 1.25);
scene.add(hemi);
const moon = new THREE.DirectionalLight(0xb9a4ff, 1.8);
moon.position.set(-12, 24, 8); moon.castShadow = true; moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.left = -18; moon.shadow.camera.right = 18; moon.shadow.camera.top = 25; moon.shadow.camera.bottom = -15;
scene.add(moon);
const redFill = new THREE.PointLight(0xe32619, 2.8, 18, 2);
redFill.position.set(0, 5, 10); scene.add(redFill);
const halloweenFill = new THREE.PointLight(0x8b2cff, 2.2, 22, 2);
halloweenFill.position.set(-7, 4, -12); scene.add(halloweenFill);

const loader = new GLTFLoader();
const modelTemplates = {taxi:null};
const modelPaths = {taxi:'assets/models/zombie-taxi-3d.glb'};
for (const [key, path] of Object.entries(modelPaths)) {
  loader.load(path, gltf => {
    modelTemplates[key] = gltf.scene;
    modelTemplates[key].traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material?.roughness !== undefined) o.material.roughness = .88; } });
    if (key === 'taxi' && taxi.group) {
      const oldTaxi = taxi.group;
      taxi.group = makeActor('taxi');
      taxi.group.position.copy(oldTaxi.position);
      taxi.group.rotation.x = oldTaxi.rotation.x;
      taxi.group.rotation.z = oldTaxi.rotation.z;
      const underglow = new THREE.PointLight(0x8b2cff, 1.5, 7, 2); underglow.position.y = .35; taxi.group.add(underglow);
      scene.remove(oldTaxi); scene.add(taxi.group);
    }
  });
}

const audio = {
  music:new Audio('assets/audio/zombie-taxi-loop.mp3'),
  splat:new Audio('assets/audio/zombie-splat.mp3'), crash:new Audio('assets/audio/taxi-crash.mp3')
};
audio.music.loop = true; audio.music.volume = Math.max(0, Math.min(1, .22)); audio.splat.volume = Math.max(0, Math.min(1, .5)); audio.crash.volume = Math.max(0, Math.min(1, .55));

let muted = localStorage.getItem('ztMuted') === '1';
let bank = +(localStorage.getItem('ztCoins') || 0);
let best = +(localStorage.getItem('ztBest') || 0);
let upgrades = JSON.parse(localStorage.getItem('ztUpgrades') || '{"armor":0,"magnet":0}');
let totals = JSON.parse(localStorage.getItem('ztTotals') || '{"kills":0,"runs":0}');
let zombieBank = +(localStorage.getItem('ztZombieBank') || 0);
let claimed = JSON.parse(localStorage.getItem('ztClaimed') || '{}');
let state = 'menu', last = 0, roadScroll = 0, score = 0, runCoins = 0, distance = 0, lives = 1, elapsed = 0;
let spawnTimer = .8, invuln = 0, shake = 0, combo = 0, comboTimer = 0;
let laneIndex = 1;
const taxi = {x:0, targetX:0, z:6, group:null, tilt:0};
const objects = [];
const particles = [];
const stains = [];
const worldSegments = [];
const laneX = [-3.2, 0, 3.2];
const roadWidth = 11;
const textureLoader = new THREE.TextureLoader();
const zombieTexture = textureLoader.load('assets/unnamed-1.png', texture => { texture.colorSpace = THREE.SRGBColorSpace; });
zombieTexture.colorSpace = THREE.SRGBColorSpace;
const roadTexture = textureLoader.load('assets/ruined-asphalt-tile.webp', texture => {
  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(1, 12);
});
roadTexture.colorSpace = THREE.SRGBColorSpace;
const road = new THREE.Mesh(new THREE.PlaneGeometry(roadWidth, 250), new THREE.MeshStandardMaterial({map:roadTexture, color:0x9b9b9b, roughness:1}));
road.rotation.x = -Math.PI / 2; road.position.set(0, -0.05, -105); road.receiveShadow = true; scene.add(road);
const cityFloor = new THREE.Mesh(new THREE.PlaneGeometry(52, 250), new THREE.MeshStandardMaterial({color:0x0b0d0c, roughness:1}));
cityFloor.rotation.x = -Math.PI / 2; cityFloor.position.set(0, -0.11, -105); cityFloor.receiveShadow = true; scene.add(cityFloor);

function resize(){
  const width = container.clientWidth, height = container.clientHeight;
  renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

function save(){
  localStorage.setItem('ztCoins', bank); localStorage.setItem('ztBest', best); localStorage.setItem('ztUpgrades', JSON.stringify(upgrades));
  localStorage.setItem('ztTotals', JSON.stringify(totals)); localStorage.setItem('ztZombieBank', zombieBank); localStorage.setItem('ztClaimed', JSON.stringify(claimed));
}
function unlockAudio(){ if (!muted && audio.music.paused) audio.music.play().catch(() => {}); }
function playSound(name){ if (muted) return; const sound = audio[name].cloneNode(); sound.volume = Math.max(0, Math.min(1, audio[name].volume)); sound.play().catch(() => {}); }
function synth(freq=600, duration=.08){
  if (muted) return; const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) return;
  const ac = synth.ac || (synth.ac = new AudioContextClass()); const oscillator = ac.createOscillator(); const gain = ac.createGain(); oscillator.connect(gain); gain.connect(ac.destination);
  oscillator.frequency.value = freq; gain.gain.setValueAtTime(.07, ac.currentTime); gain.gain.exponentialRampToValueAtTime(.001, ac.currentTime + duration); oscillator.start(); oscillator.stop(ac.currentTime + duration);
}
function colorMaterial(color, emissive=0x000000){return new THREE.MeshStandardMaterial({color, roughness:.65, metalness:.08, emissive, emissiveIntensity:emissive?1.5:0});}
function box(w,h,d,color,y=0){const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d), colorMaterial(color));mesh.position.y=y;mesh.castShadow=true;mesh.receiveShadow=true;return mesh;}
function fallbackTaxi(){
  const g=new THREE.Group(); g.add(box(2.35,.7,4.1,0xf2b900,.72)); const cabin=box(1.82,.62,2.1,0x202936,1.32); cabin.position.z=-.25; g.add(cabin);
  const sign=box(.72,.18,.42,0xffcf16,1.8); sign.position.z=-.25; g.add(sign);
  for (const x of [-1.05,1.05]) for (const z of [-1.45,1.45]) {const wheel=box(.28,.48,.7,0x121212,.45);wheel.position.x=x;wheel.position.z=z;g.add(wheel)}
  const headMat=colorMaterial(0xfff1ad,0xffa000); for(const x of [-.72,.72]){const head=new THREE.Mesh(new THREE.BoxGeometry(.38,.18,.12),headMat);head.position.set(x,.68,-2.08);g.add(head)} return g;
}
function makeTaxiCanvasTexture(draw){
  const canvas=document.createElement('canvas'); canvas.width=256; canvas.height=256;
  draw(canvas.getContext('2d'),canvas.width,canvas.height);
  const texture=new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace; texture.needsUpdate=true; return texture;
}
const taxiBloodTexture=makeTaxiCanvasTexture((ctx,w,h)=>{
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#9d1016';
  const splats=[[46,55,22],[116,88,30],[196,48,18],[74,166,17],[164,187,27],[220,142,14],[31,220,13]];
  for(const [x,y,r] of splats){
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    for(let i=0;i<7;i++){const a=i*.88+.25, d=r*(1.35+(i%3)*.42), dot=Math.max(3,r*(.09+(i%2)*.05));ctx.beginPath();ctx.arc(x+Math.cos(a)*d,y+Math.sin(a)*d,dot,0,Math.PI*2);ctx.fill();}
  }
  ctx.fillStyle='#5f070d'; ctx.fillRect(111,112,8,60); ctx.fillRect(178,74,6,82);
});
const taxiSkullTexture=makeTaxiCanvasTexture((ctx,w,h)=>{
  ctx.clearRect(0,0,w,h); ctx.strokeStyle='#fff'; ctx.fillStyle='#fff'; ctx.lineWidth=10; ctx.lineCap='round';
  ctx.beginPath();ctx.moveTo(54,197);ctx.lineTo(202,55);ctx.moveTo(54,55);ctx.lineTo(202,197);ctx.stroke();
  ctx.beginPath();ctx.arc(128,106,55,Math.PI,0);ctx.lineTo(183,145);ctx.lineTo(164,190);ctx.lineTo(92,190);ctx.lineTo(73,145);ctx.closePath();ctx.fill();
  ctx.fillStyle='#17101d'; ctx.beginPath();ctx.ellipse(106,116,13,19,0,0,Math.PI*2);ctx.ellipse(150,116,13,19,0,0,Math.PI*2);ctx.fill();
  ctx.fillRect(120,138,16,18); for(let x=103;x<=153;x+=17)ctx.fillRect(x,165,9,18);
});
const taxiHandTexture=makeTaxiCanvasTexture((ctx,w,h)=>{
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#49b83d'; ctx.strokeStyle='#2b7c2b'; ctx.lineWidth=5; ctx.lineCap='round';
  ctx.beginPath();ctx.ellipse(128,176,48,57,0,0,Math.PI*2);ctx.fill();ctx.stroke();
  const fingers=[[88,116,18,62,-.2],[111,83,18,86,-.06],[137,75,18,94,.03],[164,91,17,77,.15],[193,122,16,54,.43]];
  for(const [x,y,rx,ry,rot] of fingers){ctx.save();ctx.translate(x,y);ctx.rotate(rot);ctx.beginPath();ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();}
  ctx.beginPath();ctx.moveTo(91,174);ctx.quadraticCurveTo(52,145,64,125);ctx.quadraticCurveTo(75,111,105,151);ctx.stroke();
});
function addTaxiDecal(g,texture,width,height,position,rotation){
  const material=new THREE.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.04,depthWrite:false,side:THREE.DoubleSide});
  const decal=new THREE.Mesh(new THREE.PlaneGeometry(width,height),material); decal.position.set(position.x,position.y,position.z); decal.rotation.set(rotation.x,rotation.y,rotation.z); g.add(decal);
}
function addHorrorTaxiSkin(g,scale){
  const s=scale;
  // Blood splashes cover the horizontal panels and both sides of the body.
  addTaxiDecal(g,taxiBloodTexture,.78,.56,{x:0,y:.465/s,z:0},{x:-Math.PI/2,y:0,z:0});
  addTaxiDecal(g,taxiBloodTexture,.68,.38,{x:0,y:.39/s,z:-.39},{x:-Math.PI/2,y:0,z:0});
  addTaxiDecal(g,taxiBloodTexture,.68,.38,{x:0,y:.39/s,z:.39},{x:-Math.PI/2,y:0,z:0});
  addTaxiDecal(g,taxiBloodTexture,.82,.5,{x:-.27/s,y:.34/s,z:0},{x:0,y:-Math.PI/2,z:0});
  addTaxiDecal(g,taxiBloodTexture,.82,.5,{x:.27/s,y:.34/s,z:0},{x:0,y:Math.PI/2,z:0});
  // Rear-facing decals: the taxi is rotated 180 degrees, so local -Z is its rear.
  addTaxiDecal(g,taxiSkullTexture,.28,.23,{x:-.06/s,y:.22/s,z:-.515},{x:0,y:Math.PI,z:0});
  addTaxiDecal(g,taxiHandTexture,.18,.23,{x:.19/s,y:.22/s,z:-.52},{x:0,y:Math.PI,z:0});
}
function fallbackZombie(brute=false){
  const g=new THREE.Group(); const skin=brute?0x819451:0x718a72, shirt=brute?0xe8751e:0x1e3b29; const scale=brute?1.22:1;
  g.add(box(.72*scale,1.1*scale,.44*scale,skin,.58*scale)); const head=new THREE.Mesh(new THREE.SphereGeometry(.35*scale,10,8),colorMaterial(0xa4b479));head.position.y=1.35*scale;head.castShadow=true;g.add(head);
  for(const side of [-1,1]){const arm=box(.2*scale,.9*scale,.2*scale,shirt,.7*scale);arm.position.x=side*.55*scale;arm.rotation.z=side*.22;g.add(arm)}
  const vest=box(.82*scale,.55*scale,.5*scale,shirt,.86*scale);g.add(vest); return g;
}
function makeUploadedZombie(type){
  const group = new THREE.Group();
  const brute = type === 'brute';
  const width = brute ? 2.5 : 2.0;
  const height = brute ? 2.5 : 2.15;
  const material = new THREE.MeshBasicMaterial({map:zombieTexture, transparent:true, alphaTest:.08, side:THREE.DoubleSide, color:brute?0xd5c8b0:0xffffff});
  const sprite = new THREE.Mesh(new THREE.PlaneGeometry(width,height), material);
  sprite.position.y = height * .52; sprite.castShadow = false; sprite.userData.isZombieBillboard = true;
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(brute?1.05:.8,18), new THREE.MeshBasicMaterial({color:0x050308, transparent:true, opacity:.7, depthWrite:false}));
  shadow.rotation.x = -Math.PI/2; shadow.position.y = .025; shadow.scale.y = .45;
  group.add(shadow, sprite); group.userData.billboard = sprite; return group;
}
function makeActor(type){
  if(type === 'zombie' || type === 'brute') return makeUploadedZombie(type);
  const g = modelTemplates[type] ? modelTemplates[type].clone(true) : fallbackTaxi();
  const scale = modelTemplates[type] ? 2.15 : .68;
  g.scale.setScalar(scale);
  // The taxi asset is authored facing the opposite direction from the runner lane.
  // Turn the whole vehicle around so its front points down the road toward -Z.
  g.rotation.y = Math.PI;
  g.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(g);
  const center = bounds.getCenter(new THREE.Vector3());
  g.position.x -= center.x;
  g.position.y -= bounds.min.y;
  g.position.z -= center.z;
  addHorrorTaxiSkin(g,scale);
  g.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}}); return g;
}
function createStreetSegment(i){
  const g=new THREE.Group(); g.position.z=-i*18;
  const sidewalkMat=colorMaterial(0x252724); const left=box(3.2,.18,18,0x252724,.03);left.position.x=-7.1;g.add(left);const right=left.clone();right.position.x=7.1;g.add(right);
  // Two dashed dividers make the road read as three clear driving lanes.
  for (const x of [-1.6, 1.6]) { const divider=box(.1,.025,6.5,0xffc13b,.035); divider.position.x=x; g.add(divider); }
  for(const side of [-1,1]){
    const building=box(2.2+Math.random()*1.4,3+Math.random()*7,4.2,side<0?0x100d17:0x1d1118,1.5+Math.random()*3.5);building.position.x=side*(10+Math.random()*2.2);building.position.z=(Math.random()-.5)*5;g.add(building);
    const windowMat=colorMaterial(side<0?0xff7a18:0xff3d23,side<0?0x8b16ff:0x920e00);
    for(let row=0;row<2;row++){const win=box(.08,.32,.6,windowMat,2.2+row*1.3);win.position.x=side*(8.9+Math.random()*1.4);win.position.z=-3+Math.random()*5;g.add(win)}
    const pole=box(.08,3.2,.08,0x3b3931,1.6);pole.position.x=side*5.9;pole.position.z=-5;g.add(pole);const lamp=new THREE.Mesh(new THREE.SphereGeometry(.17,8,6),colorMaterial(0xffb32b,0xff7b00));lamp.position.set(side*5.9,3.25,-5);g.add(lamp);
  }
  scene.add(g);worldSegments.push(g);
}
for(let i=0;i<13;i++)createStreetSegment(i);

function addTaxi(){
  taxi.group=makeActor('taxi'); taxi.group.position.set(0,0,taxi.z);
  const underglow = new THREE.PointLight(0x8b2cff, 1.5, 7, 2); underglow.position.y = .35; taxi.group.add(underglow);
  scene.add(taxi.group);
}
addTaxi();
function addStain(x,z,size){const mat=new THREE.MeshBasicMaterial({color:0x69070d,transparent:true,opacity:.78,depthWrite:false});const mesh=new THREE.Mesh(new THREE.CircleGeometry(size,10),mat);mesh.rotation.x=-Math.PI/2;mesh.position.set(x,.015,z);scene.add(mesh);stains.push({mesh,life:8});}
function addBurst(x,z,color,count=14){for(let i=0;i<count;i++){const mesh=new THREE.Mesh(new THREE.SphereGeometry(.045+Math.random()*.08,6,5),new THREE.MeshBasicMaterial({color}));mesh.position.set(x,.65,z);scene.add(mesh);particles.push({mesh,vx:(Math.random()-.5)*4,vy:2+Math.random()*4,vz:(Math.random()-.5)*3,life:.55+Math.random()*.55});}}
function makeCoin(){const g=new THREE.Group();const coin=new THREE.Mesh(new THREE.CylinderGeometry(.34,.34,.12,20),new THREE.MeshStandardMaterial({color:0xffd21a,metalness:.8,roughness:.22,emissive:0x7a3d00,emissiveIntensity:.4}));coin.rotation.z=Math.PI/2;g.add(coin);const ring=new THREE.Mesh(new THREE.TorusGeometry(.22,.035,6,16),new THREE.MeshBasicMaterial({color:0xfff0a1}));ring.rotation.y=Math.PI/2;g.add(ring);return g;}
function makeBarrier(){const g=new THREE.Group();g.add(box(2.1,.55,.55,0xb3261e,.35));const stripe=box(2.16,.18,.58,0xffd12a,.58);stripe.rotation.z=.12;g.add(stripe);return g;}
function spawn(){
  const lane=laneX[Math.floor(Math.random()*3)], r=Math.random(); let type, group, hp=1;
  if(r<.67){type=(elapsed>18&&Math.random()<.18)?'brute':'zombie';group=makeActor(type);hp=type==='brute'?2:1;}
  else if(r<.84){type='coin';group=makeCoin();}
  else {type='barrier';group=makeBarrier();}
  group.position.set(lane, type==='coin'?.65:0, -105); scene.add(group); objects.push({type,group,x:lane,z:-105,hp,spin:Math.random()*6,dead:false});
}
function hitObject(o){return Math.abs(taxi.x-o.x)<(o.type==='brute'?1.35:1.15) && Math.abs(taxi.z-o.z)<(o.type==='coin'?1.5:2.25);}
function damage(o){if(state!=='playing'||invuln>0)return;lives=0;invuln=.35;shake=.28;combo=0;playSound('crash');addBurst(o.x,o.z,0xff9f18,20);navigator.vibrate?.([50,30,80]);o.dead=true;scene.remove(o.group);updateHud();setTimeout(gameOver,350);}
function splat(o){
  o.hp--; shake=.12; playSound('splat'); navigator.vibrate?.(35); addBurst(o.x,o.z,0xa70f14,18); addStain(o.x,o.z,.45+Math.random()*.35);
  if(o.hp<=0){o.dead=true;scene.remove(o.group);combo++;comboTimer=2.1;const gain=(o.type==='brute'?40:15)*Math.max(1,combo);score+=gain;zombieBank++;totals.kills++;comboEl.textContent=`SPLAT COMBO ×${combo}`;comboEl.classList.add('show');save();}
  else{o.group.position.z-=1.1;addBurst(o.x,o.z,0xffb21c,10);} updateHud();
}
function updateHud(){scoreEl.textContent=String(Math.floor(score)).padStart(5,'0');coinsEl.textContent=`◉ ${state==='playing'?runCoins:bank}`;heartsEl.textContent=state==='playing'?'⚠ 1 HIT':'☠ END';distEl.textContent=`${Math.floor(distance)} M`;}

function update(dt){
  const worldSpeed=state==='playing'?Math.min(32,16+elapsed*.45):2.4; roadScroll+=worldSpeed*dt; roadTexture.offset.y=(roadScroll*.012)%1;
  for(const segment of worldSegments){segment.position.z+=worldSpeed*dt;if(segment.position.z>18)segment.position.z-=234;}
  for(const object of objects){if(object.group.userData.billboard)object.group.userData.billboard.quaternion.copy(camera.quaternion);}
  const idleTarget=state==='playing'?taxi.targetX:Math.sin(performance.now()*.00045)*1.2; taxi.x=THREE.MathUtils.damp(taxi.x,idleTarget,10,dt); taxi.x=THREE.MathUtils.clamp(taxi.x,-3.8,3.8);taxi.tilt=THREE.MathUtils.damp(taxi.tilt,(taxi.targetX-taxi.x)*-.08,8,dt);taxi.group.position.x=taxi.x;taxi.group.rotation.z=taxi.tilt;
  camera.position.x=THREE.MathUtils.damp(camera.position.x,taxi.x*.2,4,dt);const look=new THREE.Vector3(taxi.x*.12,.65,-1.5);camera.lookAt(look);
  if(state!=='playing'){updateEffects(dt);return;}
  elapsed+=dt;invuln=Math.max(0,invuln-dt);shake=Math.max(0,shake-dt);comboTimer-=dt;if(comboTimer<=0){combo=0;comboEl.classList.remove('show');}
  const speed=Math.min(32,16+elapsed*.45);distance+=speed*dt*.6;score+=dt*(10+elapsed*.18);taxi.group.position.y=invuln>0&&Math.floor(invuln*12)%2?.12:0;
  spawnTimer-=dt;if(spawnTimer<=0){spawn();spawnTimer=Math.max(.42,.85-elapsed*.006)+Math.random()*.3;}
  for(const o of objects){o.z+=speed*dt;o.group.position.z=o.z;if(o.type==='coin'){o.spin+=dt*7;o.group.rotation.y=o.spin;const magnet=upgrades.magnet*1.2;if(Math.hypot(o.x-taxi.x,o.z-taxi.z)<2.6+magnet){o.x=THREE.MathUtils.damp(o.x,taxi.x,7,dt);o.z=THREE.MathUtils.damp(o.z,taxi.z,7,dt);o.group.position.x=o.x;}}
    if(!o.dead&&hitObject(o)){if(o.type==='zombie'||o.type==='brute')splat(o);else if(o.type==='coin'){o.dead=true;runCoins+=5;score+=25;synth(880,.07);addBurst(o.x,o.z,0xffd51c,10);scene.remove(o.group);updateHud();}else damage(o);}
  }
  for(let i=objects.length-1;i>=0;i--){if(objects[i].dead||objects[i].z>15){if(!objects[i].dead)scene.remove(objects[i].group);objects.splice(i,1);}}
  updateEffects(dt);updateHud();
}
function updateEffects(dt){
  for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;p.mesh.position.x+=p.vx*dt;p.mesh.position.y+=p.vy*dt;p.mesh.position.z+=p.vz*dt;p.vy-=7*dt;if(p.life<=0){scene.remove(p.mesh);particles.splice(i,1);}}
  for(let i=stains.length-1;i>=0;i--){stains[i].life-=dt;if(stains[i].life<=0){scene.remove(stains[i].mesh);stains.splice(i,1);}}
}

function home(){showPanel(`<div class="eyebrow">THE LAST FARE · 3D EDITION</div><h1 class="title">ZOMBIE<br>TAXI</h1><p class="subtitle">Eine dreidimensionale Nachtfahrt: Lenke dein blutiges Taxi durch die Stadt, überfahre die Horde und sammle Zombie-Belohnungen.</p><div class="mini-row"><div class="mini"><b>${best}</b><small>BEST SCORE</small></div><div class="mini"><b>${bank}</b><small>COINS</small></div></div><button class="btn red" id="bigPlay">▶  3D-FAHRT STARTEN</button>`);document.querySelector('#bigPlay').onclick=startGame;}
function shop(){const magnetCost=100+upgrades.magnet*150;showPanel(`<div class="eyebrow">3D GARAGE</div><h2 class="title">SHOP</h2><p class="subtitle">Dauerhafte Upgrades für jede Fahrt. Dein Kontostand: <b class="coin">◉ ${bank}</b></p><div class="list">${shopItem('🧲','COIN-MAGNET',`Reichweite +${upgrades.magnet*35}% · Level ${upgrades.magnet}`,magnetCost,'magnet',upgrades.magnet>=3)}</div>`);card.querySelectorAll('[data-buy]').forEach(b=>b.onclick=()=>buy(b.dataset.buy,+b.dataset.cost));}
function shopItem(icon,name,desc,cost,key,max){return `<div class="item"><div class="item-icon">${icon}</div><div class="item-text"><b>${name}</b><small>${desc}</small></div><button class="pill" data-buy="${key}" data-cost="${cost}" ${max?'disabled':''}>${max?'MAX':'◉ '+cost}</button></div>`;}
function buy(key,cost){if(bank<cost){synth(120,.2);return;}bank-=cost;upgrades[key]++;save();synth(800,.12);shop();updateHud();}
function tasks(){const defs=[['kills',10,'ROAD CLEANER','10 Zombies überfahren',75],['kills',50,'EXTERMINATOR','50 Zombies überfahren',250],['runs',3,'NACHTSCHICHT','3 Fahrten starten',100]];showPanel(`<div class="eyebrow">DAILY GRIND</div><h2 class="title">TASKS</h2><div class="list">${defs.map(([k,n,t,d,r],i)=>taskItem(i,t,d,totals[k],n,r)).join('')}</div>`);card.querySelectorAll('[data-claim]').forEach(b=>b.onclick=()=>{const i=b.dataset.claim;if(claimed[i])return;claimed[i]=1;bank+=+b.dataset.reward;save();synth(950,.15);tasks();updateHud();});}
function taskItem(i,t,d,val,max,reward){const done=val>=max;return `<div class="item"><div class="item-icon">${done?'✅':'☣️'}</div><div class="item-text"><b>${t}</b><small>${d} · ${Math.min(val,max)}/${max}</small></div><button class="pill" data-claim="${i}" data-reward="${reward}" ${!done||claimed[i]?'disabled':''}>${claimed[i]?'✓':'◉ '+reward}</button></div>`;}
function wallet(){const reward=zombieBank*2;showPanel(`<div class="eyebrow">TELEGRAM REWARDS</div><h2 class="title">WALLET</h2><p class="subtitle">Tausche jeden überfahrenen Zombie gegen <b class="coin">2 Coins</b>. Dein Guthaben: <b class="coin">◉ ${bank}</b></p><div class="mini-row"><div class="mini"><b class="coin">◉ ${bank}</b><small>COINS</small></div><div class="mini"><b>${zombieBank}</b><small>ZOMBIES</small></div></div><button class="btn red" id="exchangeZombies" ${zombieBank===0?'disabled':''}>☣️  ${zombieBank?`EINLÖSEN · +${reward} COINS`:'KEINE ZOMBIES'}</button><div class="list"><div class="item"><div class="item-icon">🧟</div><div class="item-text"><b>ZOMBIE-BÖRSE</b><small>1 Zombie = 2 Coins · ${zombieBank} verfügbar</small></div></div><div class="item"><div class="item-icon">🎁</div><div class="item-text"><b>DAILY DROP</b><small>Neue Aufgaben geben zusätzliche Bonus-Coins.</small></div></div></div>`);document.querySelector('#exchangeZombies').onclick=exchangeZombies;}
function exchangeZombies(){if(zombieBank<=0)return;const reward=zombieBank*2;bank+=reward;zombieBank=0;save();synth(980,.18);wallet();updateHud();}
function showPanel(html){state='menu';container.classList.remove('playing');panel.classList.remove('hidden');card.innerHTML=html;}
function setNav(name){document.querySelectorAll('.nav-btn').forEach(button=>button.classList.toggle('active',button.dataset.page===name));}
function startGame(){unlockAudio();state='playing';panel.classList.add('hidden');container.classList.add('playing');setNav('play');score=0;runCoins=0;distance=0;elapsed=0;lives=1;laneIndex=1;objects.splice(0).forEach(o=>scene.remove(o.group));particles.splice(0).forEach(p=>scene.remove(p.mesh));stains.splice(0).forEach(s=>scene.remove(s.mesh));spawnTimer=.45;invuln=0;shake=0;combo=0;comboTimer=0;taxi.x=0;taxi.targetX=laneX[laneIndex];taxi.group.position.y=0;totals.runs++;save();updateHud();window.ProgressLogger?.logProgress('run_started',{runs:totals.runs});}
function gameOver(){state='over';container.classList.remove('playing');bank+=runCoins;best=Math.max(best,Math.floor(score));save();window.ProgressLogger?.logProgress('run_finished',{score:Math.floor(score),distance:Math.floor(distance),kills:totals.kills});showPanel(`<div class="eyebrow">KEIN ZWEITER VERSUCH</div><h2 class="title">CRASHED</h2><p class="subtitle">Du hast kein Leben. Die Fahrt ist vorbei — starte wieder ganz von vorne.</p><div class="mini-row"><div class="mini"><b>${Math.floor(score)}</b><small>SCORE</small></div><div class="mini"><b>${Math.floor(distance)}m</b><small>DISTANZ</small></div><div class="mini"><b class="coin">+${runCoins}</b><small>COINS</small></div></div><button class="btn red" id="again">↻  VON VORNE STARTEN</button>`);setNav('play');document.querySelector('#again').onclick=startGame;}

function tapSteer(event){
  if(state!=='playing')return;
  const rect=canvas.getBoundingClientRect();
  const tappedLeft=event.clientX-rect.left < rect.width/2;
  laneIndex=THREE.MathUtils.clamp(laneIndex+(tappedLeft?-1:1),0,laneX.length-1);
  taxi.targetX=laneX[laneIndex];
  unlockAudio();
  event.preventDefault();
}
canvas.addEventListener('pointerdown',tapSteer);
document.querySelectorAll('.nav-btn').forEach(button=>button.onclick=()=>{unlockAudio();const page=button.dataset.page;setNav(page);if(page==='play')startGame();else({home,shop,tasks,wallet}[page]||home)();});
muteBtn.onclick=()=>{muted=!muted;localStorage.setItem('ztMuted',muted?'1':'0');muteBtn.textContent=muted?'🔇':'🔊';if(muted)audio.music.pause();else unlockAudio();};muteBtn.textContent=muted?'🔇':'🔊';

function animate(time){const dt=Math.min(.034,(time-last)/1000||0);last=time;update(dt);if(shake>0)camera.position.x+=(Math.random()-.5)*shake;renderer.render(scene,camera);requestAnimationFrame(animate);}requestAnimationFrame(animate);
home();updateHud();
