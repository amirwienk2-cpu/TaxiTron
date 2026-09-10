import * as THREE from 'three';

const COUNT = 26;           // Gesamtzahl Deko-Objekte (in einem einzigen Draw-Call)
const SPACING = 14;         // Abstand zwischen Objekten entlang Z
const SPAWN_Z = -190;       // wo neue Objekte am Horizont auftauchen
const DESPAWN_Z = 14;       // wo sie hinter der Kamera verschwinden

const dummy = new THREE.Object3D();
const color = new THREE.Color();

export class Scenery {
  constructor(scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);

    this.items = [];
    for (let i = 0; i < COUNT; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const item = {
        x: side * (7.5 + Math.random() * 10),
        z: SPAWN_Z + (Math.floor(i / 2) * SPACING) + Math.random() * 4,
        height: 3 + Math.random() * 9,
        width: 2 + Math.random() * 2.5,
      };
      this.items.push(item);
      this._applyInstance(i, item);
    }
    scene.add(this.mesh);
  }

  _applyInstance(i, item) {
    dummy.position.set(item.x, item.height / 2, item.z);
    dummy.scale.set(item.width, item.height, item.width);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(i, dummy.matrix);

    const shade = 0.08 + Math.random() * 0.08;
    color.setRGB(shade, shade * 1.15, shade * 0.85);
    this.mesh.setColorAt(i, color);
  }

  update(distanceDelta) {
    let dirty = false;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      item.z += distanceDelta;
      if (item.z > DESPAWN_Z) {
        item.z -= SPACING * (COUNT / 2);
        item.x = (i % 2 === 0 ? -1 : 1) * (7.5 + Math.random() * 10);
        item.height = 3 + Math.random() * 9;
      }
      this._applyInstance(i, item);
      dirty = true;
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
}
