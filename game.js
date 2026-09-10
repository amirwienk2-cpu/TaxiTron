import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const LANES = [-3.15, 0, 3.15];
const ROAD_LENGTH = 240;
const clamp = THREE.MathUtils.clamp;

export class TaxiRunner {
  constructor(container, callbacks = {}) {
    this.callbacks = callbacks;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x9edceb, 35, 132);
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 260);
    this.camera.position.set(0, 6.3, 12.5);
    this.camera.lookAt(0, 1.1, -15);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.timer = new THREE.Timer();
    this.loader = new GLTFLoader();
    this.assets = {};
    this.entities = [];
    this.particles = [];
    this.roadMarkers = [];
    this.scenery = [];
    this.running = false;
    this.paused = false;
    this.lane = 1;
    this.targetX = 0;
    this.speed = 22;
    this.distance = 0;
    this.coins = 0;
    this.score = 0;
    this.spawnTimer = 0;
    this.safeLane = 1;
    this.taxiColor = new THREE.Color('#ffd21c');
    this.setupWorld();
    this.loadAssets();
    this.bindInput();
    requestAnimationFrame(time => this.animate(time));
    addEventListener('resize', () => this.resize());
  }

  setupWorld() {
    const skyLoader = new THREE.TextureLoader();
    skyLoader.load('assets/bright-lowpoly-city.webp', tex => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.scene.background = tex;
      this.scene.environment = tex;
    });
    this.scene.add(new THREE.HemisphereLight(0xe7fbff, 0x435267, 2.1));
    const sun = new THREE.DirectionalLight(0xfff1cf, 3.2);
    sun.position.set(-12, 22, 9); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 20; sun.shadow.camera.bottom = -20;
    this.scene.add(sun);

    const asphalt = new THREE.TextureLoader().load('assets/taxi-runner-asphalt.webp');
    asphalt.colorSpace = THREE.SRGBColorSpace; asphalt.wrapS = asphalt.wrapT = THREE.RepeatWrapping; asphalt.repeat.set(5, 45);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(12, ROAD_LENGTH), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92, color: 0x604066 }));
    road.rotation.x = -Math.PI / 2; road.position.z = -94; road.receiveShadow = true; this.scene.add(road);
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xb8c7cb, roughness: 0.88 });
    for (const side of [-1, 1]) {
      const walk = new THREE.Mesh(new THREE.BoxGeometry(5.5, .28, ROAD_LENGTH), sidewalkMat);
      walk.position.set(side * 8.7, .05, -94); walk.receiveShadow = true; this.scene.add(walk);
      const curb = new THREE.Mesh(new THREE.BoxGeometry(.35, .42, ROAD_LENGTH), new THREE.MeshStandardMaterial({ color: 0xf4d94f }));
      curb.position.set(side * 6.18, .16, -94); this.scene.add(curb);
    }
    const laneGlowMat = new THREE.MeshBasicMaterial({ color: 0x9d35ff, transparent: true, opacity: .7, blending: THREE.AdditiveBlending });
    const lanePaintMat = new THREE.MeshBasicMaterial({ color: 0xff8a19 });
    for (let z = -205; z < 22; z += 9) for (const x of [-1.58, 1.58]) {
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(.3, 4.35), laneGlowMat);
      glow.rotation.x = -Math.PI / 2; glow.position.set(x, .011, z); this.scene.add(glow); this.roadMarkers.push(glow);
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(.12, 4), lanePaintMat);
      dash.rotation.x = -Math.PI / 2; dash.position.set(x, .016, z); this.scene.add(dash); this.roadMarkers.push(dash);
    }
    this.addCity();
    this.addTaxiFallback();
  }

  addCity() {
    const colors = [0x58b6c7, 0xff8e71, 0xf3d067, 0x7188ae, 0xe7f0ec];
    for (let i = 0; i < 34; i++) {
      const side = i % 2 ? 1 : -1, z = -205 + Math.floor(i / 2) * 13;
      const h = 5 + (i * 7 % 12), w = 5 + (i * 3 % 4);
      const group = new THREE.Group();
      const building = new THREE.Mesh(new THREE.BoxGeometry(w, h, 7.5), new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: .72 }));
      building.position.y = h / 2; building.castShadow = true; group.add(building);
      const windows = new THREE.MeshBasicMaterial({ color: i % 3 ? 0x15364b : 0xffe59b });
      for (let y = 2; y < h - 1; y += 2.4) for (let x = -w / 2 + 1; x < w / 2; x += 1.7) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(.72, .82), windows);
        win.position.set(x, y, side < 0 ? 3.76 : -3.76); win.rotation.y = side < 0 ? 0 : Math.PI; group.add(win);
      }
      group.position.set(side * (9.5 + (i % 3)), 0.2, z); this.scene.add(group); this.scenery.push(group);
    }
    for (let i = 0; i < 16; i++) {
      const group = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(.07, .1, 3.2, 8), new THREE.MeshStandardMaterial({ color: 0x263646, metalness: .6 }));
      pole.position.y = 1.6; group.add(pole);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(.22, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffdf79 }));
      lamp.position.y = 3.2; group.add(lamp);
      group.position.set((i % 2 ? 1 : -1) * 6.8, .1, -190 + Math.floor(i / 2) * 27);
      this.scene.add(group); this.scenery.push(group);
    }
  }

  addTaxiFallback() {
    this.taxi = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: this.taxiColor, roughness: .32, metalness: .16 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.15, .65, 4.15), bodyMat); body.position.y = .72; body.castShadow = true; this.taxi.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.75, .72, 2.1), new THREE.MeshStandardMaterial({ color: 0x183746, roughness: .22, metalness: .3 })); cabin.position.set(0, 1.35, .15); this.taxi.add(cabin);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(.9, .28, .48), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffc400, emissiveIntensity: .5 })); sign.position.set(0, 1.86, .05); this.taxi.add(sign);
    for (const x of [-1.05, 1.05]) for (const z of [-1.25, 1.25]) { const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.39,.39,.24,16),new THREE.MeshStandardMaterial({color:0x101419,roughness:.8})); wheel.rotation.z=Math.PI/2; wheel.position.set(x,.48,z); this.taxi.add(wheel); }
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 4.7), new THREE.MeshBasicMaterial({ color: 0x42efff, transparent: true, opacity: .22, blending: THREE.AdditiveBlending }));
    glow.rotation.x=-Math.PI/2; glow.position.y=.08; this.taxi.add(glow);
    this.taxi.position.set(0, 0, 3); this.scene.add(this.taxi);
  }

  async loadAssets() {
    const files = { taxi:'assets/models/hero-custom-taxi.glb', car:'assets/models/city-traffic-car.glb', barrier:'assets/models/construction-barrier.glb', cone:'assets/models/traffic-cone.glb' };
    await Promise.all(Object.entries(files).map(async ([key, url]) => {
      try { this.assets[key] = (await this.loader.loadAsync(url)).scene; } catch (e) { console.warn(`Fallback for ${key}`, e); }
    }));
    if (this.assets.taxi) {
      const model = this.fitClone(this.assets.taxi, 4.3);
      model.rotation.y = Math.PI; model.position.y = .05;
      this.tintTaxi(model); this.taxi.add(model);
      this.taxi.children.slice(0, 7).forEach(child => child.visible = false);
      this.taxi.children[this.taxi.children.length - 2].visible = true;
    }
  }

  fitClone(source, targetSize) {
    const clone = source.clone(true);
    clone.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.castShadow = true; o.receiveShadow = true; } });
    const box = new THREE.Box3().setFromObject(clone), size = new THREE.Vector3(); box.getSize(size);
    const scale = targetSize / Math.max(size.x, size.z, size.y);
    clone.scale.setScalar(scale);
    const scaledBox = new THREE.Box3().setFromObject(clone);
    clone.position.y -= scaledBox.min.y;
    return clone;
  }

  tintTaxi(root = this.taxi) {
    root.traverse(o => { if (o.isMesh && o.material && o.material.color) {
      const c = o.material.color; if (c.r > c.b * 1.3 && c.g > c.b * 1.25) c.copy(this.taxiColor);
    }});
  }
  setTaxiColor(hex) { this.taxiColor.set(hex); this.tintTaxi(); }

  bindInput() {
    let startX = 0, startY = 0, active = false;
    this.renderer.domElement.addEventListener('pointerdown', e => { startX=e.clientX; startY=e.clientY; active=true; });
    this.renderer.domElement.addEventListener('pointerup', e => {
      if (!active || !this.running || this.paused) return; active=false;
      const dx=e.clientX-startX, dy=e.clientY-startY;
      if (Math.abs(dx)>35 && Math.abs(dx)>Math.abs(dy)) this.changeLane(dx>0?1:-1);
    });
    addEventListener('keydown', e => { if (e.key==='ArrowLeft'||e.key==='a') this.changeLane(-1); if(e.key==='ArrowRight'||e.key==='d') this.changeLane(1); });
  }
  changeLane(dir) {
    if (!this.running || this.paused) return;
    const next=clamp(this.lane+dir,0,2); if(next!==this.lane){this.lane=next;this.targetX=LANES[next];this.callbacks.onMove?.(dir);}
  }

  start() {
    this.clearEntities(); this.running=true; this.paused=false; this.lane=1; this.targetX=0; this.speed=22; this.distance=0; this.coins=0; this.score=0; this.spawnTimer=.8; this.safeLane=1; this.taxi.position.set(0,0,3); this.taxi.rotation.set(0,0,0); this.callbacks.onUpdate?.(0,0,this.speed);
  }
  togglePause() { if(!this.running)return false; this.paused=!this.paused; return this.paused; }
  clearEntities() { for(const e of this.entities)this.scene.remove(e.root); this.entities=[]; }

  spawnWave() {
    const difficulty=clamp(this.distance/750,0,1);
    const safe=Math.floor(Math.random()*3); this.safeLane=safe;
    const pattern=Math.random();
    if(pattern<.5){
      const blocked=Math.floor(Math.random()*3); this.spawnObstacle(blocked,-105,Math.random()<.55?'car':'barrier');
      for(let i=0;i<5;i++)this.spawnCoin((blocked+1+i%2)%3,-112-i*6);
    } else if(pattern<.82||difficulty<.35){
      for(let i=0;i<7;i++)this.spawnCoin(safe,-100-i*5.7);
      const other=[0,1,2].filter(l=>l!==safe); this.spawnObstacle(other[0],-122,'barrier'); if(difficulty>.45)this.spawnObstacle(other[1],-139,'car');
    } else {
      const blocked=[0,1,2].filter(l=>l!==safe); this.spawnObstacle(blocked[0],-110,'car'); this.spawnObstacle(blocked[1],-110,'barrier');
      for(let i=0;i<5;i++)this.spawnCoin(safe,-105-i*6);
    }
  }

  spawnCoin(lane,z) {
    const root=new THREE.Group();
    const coin=new THREE.Mesh(new THREE.CylinderGeometry(.58,.58,.16,20),new THREE.MeshStandardMaterial({color:0xffc51b,metalness:.8,roughness:.2,emissive:0x8b4a00,emissiveIntensity:.35}));
    coin.rotation.z=Math.PI/2; root.add(coin);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(.67,.06,8,20),new THREE.MeshBasicMaterial({color:0xffef84})); ring.rotation.y=Math.PI/2; root.add(ring);
    root.position.set(LANES[lane],1.15,z); this.scene.add(root); this.entities.push({root,type:'coin',radius:.9,baseY:1.15,phase:Math.random()*6});
  }
  spawnObstacle(lane,z,type) {
    let root;
    if(this.assets[type]) { root=this.fitClone(this.assets[type],type==='car'?4.1:2.5); root.rotation.y=type==='car'?Math.PI:Math.PI/2; }
    else { root=new THREE.Mesh(new THREE.BoxGeometry(type==='car'?2.1:2.5,1.4,type==='car'?4:1),new THREE.MeshStandardMaterial({color:type==='car'?0xed4f45:0xff8b20})); root.position.y=.7; }
    root.position.x=LANES[lane]; root.position.z=z; this.scene.add(root); this.entities.push({root,type:'obstacle',radius:type==='car'?1.45:1.35});
    if(type==='barrier'&&this.assets.cone) for(const side of [-1,1]) { const cone=this.fitClone(this.assets.cone,.8); cone.position.set(LANES[lane]+side*1.05,.02,z+1); this.scene.add(cone); this.entities.push({root:cone,type:'decor',radius:0}); }
  }

  burst(color=0xffdc38) {
    for(let i=0;i<14;i++) { const mesh=new THREE.Mesh(new THREE.BoxGeometry(.12,.12,.12),new THREE.MeshBasicMaterial({color})); mesh.position.copy(this.taxi.position).add(new THREE.Vector3(0,1,-1)); const p={mesh,life:.55,vel:new THREE.Vector3((Math.random()-.5)*7,Math.random()*5,(Math.random()-.5)*5)}; this.scene.add(mesh);this.particles.push(p); }
  }
  crash() { this.running=false; this.burst(0xff573d); this.taxi.rotation.z=-.16; this.callbacks.onCrash?.(Math.floor(this.score),this.coins); }

  update(dt) {
    for(const p of this.particles){p.life-=dt;p.vel.y-=8*dt;p.mesh.position.addScaledVector(p.vel,dt);p.mesh.scale.setScalar(Math.max(0,p.life*2));}
    this.particles=this.particles.filter(p=>{if(p.life<=0){this.scene.remove(p.mesh);return false;}return true;});
    if(!this.running||this.paused)return;
    this.distance+=this.speed*dt; this.speed=Math.min(40,22+this.distance/150); this.score=this.distance*2+this.coins*100;
    this.taxi.position.x=THREE.MathUtils.damp(this.taxi.position.x,this.targetX,11,dt);
    this.taxi.rotation.z=THREE.MathUtils.damp(this.taxi.rotation.z,(this.targetX-this.taxi.position.x)*-.055,9,dt);
    this.taxi.position.y=Math.sin(this.distance*.25)*.025;
    for(const marker of this.roadMarkers){marker.position.z+=this.speed*dt;if(marker.position.z>25)marker.position.z-=225;}
    for(const obj of this.scenery){obj.position.z+=this.speed*dt;if(obj.position.z>30)obj.position.z-=228;}
    this.spawnTimer-=dt; if(this.spawnTimer<=0){this.spawnWave();this.spawnTimer=Math.max(1.28,2.3-this.speed*.025);}
    for(const e of this.entities){
      e.root.position.z+=this.speed*dt;
      if(e.type==='coin'){e.root.rotation.y+=dt*5.5;e.root.position.y=e.baseY+Math.sin(this.distance*.14+e.phase)*.18;}
      if((e.type==='coin'||e.type==='obstacle')&&Math.abs(e.root.position.z-this.taxi.position.z)<(e.type==='coin'?1.3:2.15)&&Math.abs(e.root.position.x-this.taxi.position.x)<e.radius){
        if(e.type==='coin'){e.dead=true;this.coins++;this.score+=100;this.burst();this.callbacks.onCoin?.();}else{e.dead=true;this.crash();}
      }
      if(e.root.position.z>25)e.dead=true;
    }
    this.entities=this.entities.filter(e=>{if(e.dead){this.scene.remove(e.root);return false;}return true;});
    this.camera.position.x=THREE.MathUtils.damp(this.camera.position.x,this.taxi.position.x*.22,4,dt);
    this.callbacks.onUpdate?.(Math.floor(this.score),this.coins,this.speed);
  }
  animate(time) { requestAnimationFrame(next => this.animate(next)); this.timer.update(time); const dt=Math.min(this.timer.getDelta(),.05); this.update(dt); this.renderer.render(this.scene,this.camera); }
  resize() { this.renderer.setSize(innerWidth,innerHeight);this.renderer.setPixelRatio(Math.min(devicePixelRatio,2));this.camera.aspect=innerWidth/innerHeight;this.camera.updateProjectionMatrix(); }
}
