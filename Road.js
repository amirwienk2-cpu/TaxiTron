import * as THREE from 'three';

export const LANE_WIDTH = 3.2;
export const LANE_COUNT = 3;
const ROAD_WIDTH = LANE_WIDTH * LANE_COUNT + 2.4;
const ROAD_LENGTH = 400;
const TILE_LENGTH = 10; // Länge einer Textur-Kachel in Weltmetern

// Baut die Asphalt-Textur einmalig per <canvas> — kein externer Asset-Download,
// also kein Netzwerk-Lag und kein Flackern beim Laden.
function buildRoadTexture() {
  const w = 256, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#1b1f18';
  ctx.fillRect(0, 0, w, h);

  // leichtes Rauschen für Asphalt-Look
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${20 + Math.random() * 20},${22 + Math.random() * 20},${16 + Math.random() * 18},0.5)`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }

  // Fahrbahnmarkierungen zwischen den 3 Spuren (gestrichelt)
  ctx.strokeStyle = 'rgba(230,230,210,0.85)';
  ctx.lineWidth = 5;
  ctx.setLineDash([26, 22]);
  const laneX1 = w * (1 / 3);
  const laneX2 = w * (2 / 3);
  ctx.beginPath(); ctx.moveTo(laneX1, 0); ctx.lineTo(laneX1, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(laneX2, 0); ctx.lineTo(laneX2, h); ctx.stroke();

  // durchgezogene Außenlinien, leicht rostig/verwittert
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(217,98,43,0.55)';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(10, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w - 10, 0); ctx.lineTo(w - 10, h); ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, ROAD_LENGTH / TILE_LENGTH);
  tex.anisotropy = 4;
  return tex;
}

export class Road {
  constructor(scene) {
    this.texture = buildRoadTexture();

    const geo = new THREE.PlaneGeometry(ROAD_WIDTH, ROAD_LENGTH, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ map: this.texture });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.z = -ROAD_LENGTH / 2 + 20;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    // toter Boden links/rechts der Straße
    const groundGeo = new THREE.PlaneGeometry(400, ROAD_LENGTH, 1, 1);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x0e120c });
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(0, -0.02, this.mesh.position.z);
    scene.add(this.ground);

    this._scrollLen = ROAD_LENGTH / TILE_LENGTH;
  }

  update(distanceDelta) {
    // Straße "bewegt" sich rein per UV-Offset -> keine Geometrie pro Frame nötig.
    // RepeatWrapping kümmert sich ums Umlaufen, der Offset darf beliebig weiterwachsen.
    this.texture.offset.y += distanceDelta / TILE_LENGTH;
  }

  static laneX(laneIndex) {
    return (laneIndex - (LANE_COUNT - 1) / 2) * LANE_WIDTH;
  }
}
