import * as THREE from 'three';
import { Road, LANE_COUNT } from './Road.js';

const POOL_SIZE = 24;
const SPAWN_Z = -70;
const DESPAWN_Z = 6;
const COLLECT_WINDOW = 1.1; // z-Toleranz um die Auto-Position zum Einsammeln

// Im Schnitt ein Zombie alle METERS_PER_SPAWN gefahrene Meter (± Streuung).
// Das hält die client-seitig plausible Sammelrate deutlich unter dem
// server-seitigen Cap von 0.3 Zombies/Meter (siehe server.js MAX_ZOMBIES_PER_METER).
const METERS_PER_SPAWN_BASE = 7.5;

function buildZombieMesh() {
  const group = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0x5c7a3a });
  const rags = new THREE.MeshLambertMaterial({ color: 0x3a2f28 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.8, 0.32), rags);
  torso.position.y = 0.9;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 8), skin);
  head.position.y = 1.48;
  group.add(head);

  const armGeo = new THREE.BoxGeometry(0.18, 0.6, 0.18);
  const armL = new THREE.Mesh(armGeo, skin);
  armL.position.set(-0.42, 1.0, 0);
  armL.rotation.z = 0.5;
  group.add(armL);
  const armR = new THREE.Mesh(armGeo, skin);
  armR.position.set(0.42, 1.0, 0);
  armR.rotation.z = -0.5;
  group.add(armR);

  const legGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
  const legL = new THREE.Mesh(legGeo, rags);
  legL.position.set(-0.15, 0.28, 0);
  group.add(legL);
  const legR = new THREE.Mesh(legGeo, rags);
  legR.position.set(0.15, 0.28, 0);
  group.add(legR);

  group.userData.arms = [armL, armR];
  return group;
}

export class ZombiePool {
  constructor(scene, onCollected) {
    this.scene = scene;
    this.onCollected = onCollected;
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = buildZombieMesh();
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, active: false, lane: 0, sway: Math.random() * Math.PI * 2 });
    }
    this._distanceSinceSpawn = 0;
    this._nextSpawnAt = METERS_PER_SPAWN_BASE;
    this._lastLane = -1;
  }

  reset() {
    this.pool.forEach((z) => { z.active = false; z.mesh.visible = false; });
    this._distanceSinceSpawn = 0;
    this._nextSpawnAt = METERS_PER_SPAWN_BASE;
    this._lastLane = -1;
  }

  _spawnOne() {
    const free = this.pool.find((z) => !z.active);
    if (!free) return;
    let lane = Math.floor(Math.random() * LANE_COUNT);
    if (lane === this._lastLane && Math.random() < 0.7) {
      lane = (lane + 1 + Math.floor(Math.random() * (LANE_COUNT - 1))) % LANE_COUNT;
    }
    this._lastLane = lane;

    free.active = true;
    free.lane = lane;
    free.mesh.visible = true;
    free.mesh.position.set(Road.laneX(lane), 0, SPAWN_Z);
  }

  update(dt, distanceDelta, carLane, carZ) {
    this._distanceSinceSpawn += distanceDelta;
    if (this._distanceSinceSpawn >= this._nextSpawnAt) {
      this._distanceSinceSpawn = 0;
      this._nextSpawnAt = METERS_PER_SPAWN_BASE * (0.6 + Math.random() * 0.8);
      this._spawnOne();
    }

    for (const z of this.pool) {
      if (!z.active) continue;
      z.mesh.position.z += distanceDelta;
      z.sway += dt * 6;
      z.mesh.rotation.z = Math.sin(z.sway) * 0.12;
      const arms = z.mesh.userData.arms;
      if (arms) arms.forEach((a, i) => { a.rotation.x = Math.sin(z.sway + i) * 0.3; });

      if (z.active && Math.abs(z.mesh.position.z - carZ) < COLLECT_WINDOW && z.lane === carLane) {
        z.active = false;
        z.mesh.visible = false;
        this.onCollected();
        continue;
      }

      if (z.mesh.position.z > DESPAWN_Z) {
        z.active = false;
        z.mesh.visible = false;
      }
    }
  }
}
