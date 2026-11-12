import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createWeaponModel, WEAPON_IDS } from './weapons.js';

const RING_GEO = new THREE.RingGeometry(0.5, 0.72, 26);
const BEAM_GEO = new THREE.CylinderGeometry(0.34, 0.5, 2.6, 10, 1, true);

const TYPE_COLORS = {
  weapon: 0x53e0d0,
  ammo: 0xffc352,
  medkit: 0x5bff9d,
  armor: 0x63a8ff,
};

function ringMaterial(hex) {
  return new THREE.MeshBasicMaterial({
    color: hex, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}
function beamMaterial(hex) {
  return new THREE.MeshBasicMaterial({
    color: hex, transparent: true, opacity: 0.1,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

function buildAmmoBox() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new RoundedBoxGeometry(0.46, 0.28, 0.32, 2, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x4a5a32, roughness: 0.6, metalness: 0.3 })
  );
  body.castShadow = true;
  g.add(body);
  const lid = new THREE.Mesh(
    new RoundedBoxGeometry(0.48, 0.07, 0.34, 2, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x2f3a22, roughness: 0.5, metalness: 0.4 })
  );
  lid.position.y = 0.16;
  g.add(lid);
  const stripe = new THREE.Mesh(
    new RoundedBoxGeometry(0.5, 0.05, 0.35, 1, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xc9a24d, roughness: 0.35, metalness: 0.85 })
  );
  stripe.position.y = 0.02;
  g.add(stripe);
  return g;
}

function buildMedkit() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new RoundedBoxGeometry(0.44, 0.34, 0.26, 2, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.55, metalness: 0.05 })
  );
  body.castShadow = true;
  g.add(body);
  const crossMat = new THREE.MeshStandardMaterial({
    color: 0xd6392f, roughness: 0.45, emissive: 0x3d0a08, emissiveIntensity: 0.6,
  });
  const a = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.07, 0.02, 1, 0.01), crossMat);
  a.position.z = 0.14;
  g.add(a);
  const b = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.22, 0.02, 1, 0.01), crossMat);
  b.position.z = 0.14;
  g.add(b);
  const handle = new THREE.Mesh(
    new RoundedBoxGeometry(0.2, 0.05, 0.08, 1, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.4, metalness: 0.6 })
  );
  handle.position.y = 0.19;
  g.add(handle);
  return g;
}

function buildArmor() {
  const g = new THREE.Group();
  const vest = new THREE.Mesh(
    new RoundedBoxGeometry(0.42, 0.5, 0.22, 2, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x2b3444, roughness: 0.65, metalness: 0.25 })
  );
  vest.castShadow = true;
  g.add(vest);
  const plate = new THREE.Mesh(
    new RoundedBoxGeometry(0.34, 0.36, 0.06, 2, 0.03),
    new THREE.MeshStandardMaterial({ color: 0x46536b, roughness: 0.5, metalness: 0.5 })
  );
  plate.position.z = 0.12;
  g.add(plate);
  return g;
}

const WEAPON_TYPES = ['rifle', 'smg', 'shotgun', 'sniper'];

export class Pickups {
  constructor(scene, spots) {
    this.scene = scene;
    this.items = [];
    this.group = new THREE.Group();
    this.group.name = 'pickups';
    scene.add(this.group);
    this.time = 0;
    this.onCollect = null;

    const types = ['medkit', 'medkit', 'ammo', 'ammo', 'ammo', 'armor'];
    const list = [];
    for (const spot of spots) {
      const roll = Math.random();
      let type;
      if (roll < 0.4) type = WEAPON_TYPES[(Math.random() * WEAPON_TYPES.length) | 0];
      else if (roll < 0.62) type = 'medkit';
      else if (roll < 0.86) type = 'ammo';
      else type = 'armor';
      list.push({ type, spot });
    }
    // Guarantee a couple of each essential type near the middle.
    list.forEach((entry) => this.addItem(entry.type, entry.spot));
  }

  /**
   * Add a loot item at a world spot. `drop` items are transient: they are
   * removed (not respawned) after a while or once collected.
   */
  addItem(type, spot, drop = null) {
    const holder = new THREE.Group();
    holder.position.set(spot.x, spot.y + 0.55, spot.z);

    const isWeapon = WEAPON_TYPES.includes(type);
    const colorKey = isWeapon ? 'weapon' : type === 'ammo' ? 'ammo' : type === 'medkit' ? 'medkit' : 'armor';
    const color = TYPE_COLORS[colorKey];

    const model = new THREE.Group();
    if (isWeapon) {
      const gun = createWeaponModel(type);
      gun.scale.setScalar(1.15);
      gun.rotation.y = Math.PI * 0.5;
      model.add(gun);
    } else if (type === 'ammo') {
      model.add(buildAmmoBox());
    } else if (type === 'medkit') {
      model.add(buildMedkit());
    } else {
      model.add(buildArmor());
    }
    holder.add(model);

    const ring = new THREE.Mesh(RING_GEO, ringMaterial(color));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.5;
    holder.add(ring);

    const beam = new THREE.Mesh(BEAM_GEO, beamMaterial(color));
    beam.position.y = 0.7;
    holder.add(beam);

    this.group.add(holder);

    this.items.push({
      type,
      holder,
      model,
      ring,
      position: new THREE.Vector3(spot.x, spot.y + 0.55, spot.z),
      ground: spot.y,
      active: true,
      drop: !!drop,
      ttl: drop ? 45 : 0,
      spawnT: 0,
      respawn: 0,
      spin: Math.random() * Math.PI * 2,
    });
    return this.items[this.items.length - 1];
  }

  /** A fighter died: leave their primary weapon on the ground for grabs. */
  dropFrom(fighter) {
    const slot = fighter.slots[fighter.slot];
    if (!slot || !fighter.alive) return null;
    const def = WEAPON_IDS.includes(slot.id) ? slot.id : 'rifle';
    const x = fighter.position.x;
    const z = fighter.position.z;
    const item = this.addItem(def, { x, y: fighter.position.y + 0.1, z }, 'drop');
    item.active = true;
    item.spin = 0;
    item.holder.scale.setScalar(0.01);
    return item;
  }

  update(dt, fighters) {
    this.time += dt;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!item.active) {
        if (item.drop) {
          // Collected drops disappear instantly; untouched ones expire.
          if (item.respawn <= 0) this.removeItem(item, i);
        } else {
          item.respawn -= dt;
          if (item.respawn <= 0) {
            item.active = true;
            item.holder.visible = true;
            item.holder.scale.setScalar(0.01);
          }
        }
        continue;
      }

      if (item.drop) {
        item.ttl -= dt;
        if (item.ttl <= 0) { this.removeItem(item, i); continue; }
      }

      item.spin += dt * 0.9;
      item.model.rotation.y = item.spin;
      const bob = Math.sin(this.time * 2 + item.position.x) * 0.08;
      item.model.position.y = bob;
      item.ring.scale.setScalar(0.9 + Math.sin(this.time * 3 + item.position.z) * 0.08);
      if (item.holder.scale.x < 1) {
        item.holder.scale.setScalar(Math.min(1, item.holder.scale.x + dt * 4));
      }

      for (const f of fighters) {
        if (!f.alive) continue;
        const dx = f.position.x - item.position.x;
        const dz = f.position.z - item.position.z;
        const dy = f.position.y + 0.8 - item.position.y;
        if (dx * dx + dz * dz < 2.6 && Math.abs(dy) < 2.2) {
          if (this.collect(item, f)) {
            item.active = false;
            item.holder.visible = false;
            if (item.drop) {
              this.removeItem(item, i);
            } else {
              item.respawn = 16 + Math.random() * 8;
            }
            this.onCollect?.(f, item.type);
            break;
          }
        }
      }
    }
  }

  removeItem(item, index) {
    this.group.remove(item.holder);
    this.items.splice(index, 1);
  }

  collect(item, fighter) {
    switch (item.type) {
      case 'medkit':
        if (fighter.health >= 100 && fighter.medkits >= 3) return false;
        if (fighter.medkits < 3) fighter.medkits++;
        else fighter.health = Math.min(100, fighter.health + 45);
        return true;
      case 'ammo':
        fighter.addAmmo(60);
        return true;
      case 'armor':
        if (fighter.armor >= 100) return false;
        fighter.armor = 100;
        return true;
      default:
        return fighter.giveWeapon(item.type);
    }
  }
}
