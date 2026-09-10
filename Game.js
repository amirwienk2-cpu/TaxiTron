import * as THREE from 'three';
import { Road } from './Road.js';
import { Scenery } from './Scenery.js';
import { Car } from './Car.js';
import { ZombiePool } from './ZombiePool.js';
import { Input } from './Input.js';

const RUN_DURATION_S = 42;
const BASE_SPEED = 9;   // m/s bei Laufbeginn
const MAX_SPEED = 17;   // m/s gegen Laufende
const MAX_DELTA = 1 / 20; // Delta-Zeit kappen, damit ein Tab-Wechsel keinen Sprung verursacht

export class Game {
  constructor(canvas, { onHud, onFinish }) {
    this.canvas = canvas;
    this.onHud = onHud || (() => {});
    this.onFinish = onFinish || (() => {});

    this._initScene();
    this._initEntities();
    this._bindResize();

    this.input = new Input(canvas, (dir) => {
      if (this.state !== 'running') return;
      this.car.moveLane(dir);
    });

    this.state = 'idle'; // idle | running
    this.clock = new THREE.Clock(false);
    this._raf = null;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clock.stop();
      else if (this.state === 'running') this.clock.start();
    });
  }

  _initScene() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0c09);
    scene.fog = new THREE.Fog(0x0a0c09, 28, 85);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 260);
    camera.position.set(0, 4.6, 8.2);
    camera.lookAt(0, 1.1, -8);
    this.camera = camera;

    scene.add(new THREE.HemisphereLight(0x93c47d, 0x0a0c09, 0.9));
    const sun = new THREE.DirectionalLight(0xfff1d6, 0.7);
    sun.position.set(-6, 12, 4);
    scene.add(sun);
  }

  _initEntities() {
    this.road = new Road(this.scene);
    this.scenery = new Scenery(this.scene);
    this.car = new Car(this.scene);
    this.zombiePool = new ZombiePool(this.scene, () => {
      this._sessionZombies += 1;
    });
  }

  _bindResize() {
    window.addEventListener('resize', () => {
      const w = window.innerWidth, h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    });
  }

  start() {
    this.state = 'running';
    this._sessionZombies = 0;
    this._sessionDistance = 0;
    this._elapsed = 0;
    this.car.lane = 1;
    this.car.mesh.rotation.z = 0;
    this.car.targetX = 0;
    this.car.mesh.position.x = 0;
    this.zombiePool.reset();

    this.clock.start();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._loop();
  }

  _loop = () => {
    if (this.state !== 'running') return;
    this._raf = requestAnimationFrame(this._loop);
    if (document.hidden) return;

    const dt = Math.min(this.clock.getDelta(), MAX_DELTA);
    this._elapsed += dt;

    const progress = Math.min(this._elapsed / RUN_DURATION_S, 1);
    const speed = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * progress;
    const distanceDelta = speed * dt;
    this._sessionDistance += distanceDelta;

    this.road.update(distanceDelta);
    this.scenery.update(distanceDelta);
    this.car.update(dt);
    this.zombiePool.update(dt, distanceDelta, this.car.lane, this.car.mesh.position.z);

    this.renderer.render(this.scene, this.camera);

    this.onHud({
      distance: Math.floor(this._sessionDistance),
      zombies: this._sessionZombies,
      timeFraction: Math.max(0, 1 - progress),
    });

    if (this._elapsed >= RUN_DURATION_S) {
      this._finish();
    }
  };

  _finish() {
    this.state = 'idle';
    this.clock.stop();
    cancelAnimationFrame(this._raf);
    this.onFinish({
      distance: Math.floor(this._sessionDistance),
      zombies: this._sessionZombies,
    });
  }
}
