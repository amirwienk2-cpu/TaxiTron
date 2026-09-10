import * as THREE from 'three';
import { Road, LANE_COUNT } from './Road.js';

const LANE_SWITCH_SPEED = 9; // wie schnell das Auto zur Ziel-Spur lerpt

function buildCarMesh() {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x8cff5c });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x12160f });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x1a2a33 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 3.4), bodyMat);
  body.position.y = 0.5;
  group.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.6), glassMat);
  cabin.position.set(0, 0.95, -0.1);
  group.add(cabin);

  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.32, 10);
  const wheelPositions = [
    [-0.85, 0.32, 1.1], [0.85, 0.32, 1.1],
    [-0.85, 0.32, -1.1], [0.85, 0.32, -1.1],
  ];
  wheelPositions.forEach(([x, y, z]) => {
    const wheel = new THREE.Mesh(wheelGeo, darkMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    group.add(wheel);
  });

  // einfacher "Schatten"-Fleck statt teurer Echtzeit-Shadow-Map
  const shadowTex = buildBlobShadow();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 4.2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  return group;
}

function buildBlobShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Car {
  constructor(scene) {
    this.mesh = buildCarMesh();
    this.mesh.position.set(0, 0, -1.5);
    scene.add(this.mesh);

    this.lane = Math.floor(LANE_COUNT / 2);
    this.targetX = Road.laneX(this.lane);
    this._bob = 0;
  }

  moveLane(dir) {
    const next = THREE.MathUtils.clamp(this.lane + dir, 0, LANE_COUNT - 1);
    if (next === this.lane) return false;
    this.lane = next;
    this.targetX = Road.laneX(this.lane);
    return true;
  }

  update(dt) {
    const dx = this.targetX - this.mesh.position.x;
    this.mesh.position.x += dx * Math.min(1, LANE_SWITCH_SPEED * dt);
    this.mesh.rotation.z = THREE.MathUtils.clamp(-dx * 0.35, -0.35, 0.35);

    this._bob += dt * 9;
    this.mesh.position.y = Math.sin(this._bob) * 0.03;
  }
}
