import * as THREE from 'three';

/**
 * A red silhouette drawn around the opponent you are looking at.
 *
 * The character meshes are duplicated into a hidden group with a
 * back-face-only red material, inflated slightly and drawn over the scene.
 * Only the rim survives, so the body reads as outlined in red without tinting
 * the soldier underneath. The duplicate is re-parented onto the live rig every
 * frame, so it tracks walking, aiming and the death animation for free.
 */
export class TargetOutline {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'target-outline';
    this.group.visible = false;
    this.material = new THREE.MeshBasicMaterial({
      color: 0xff3b2f,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      fog: false,
    });
    this.target = null;
    this.layer = 0;
    this.inflate = 1.04;
  }

  /**
   * Point the outline at `fighter` (or null to hide it). Rebuilds only when
   * the target actually changes.
   */
  setTarget(fighter, layer = 0) {
    if (fighter === this.target && layer === this.layer) return;
    this.target = fighter;
    this.layer = layer;
    this.clear();
    if (!fighter) return;

    for (const src of this._bodyMeshes(fighter)) {
      const mesh = new THREE.Mesh(src.geometry, this.material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 998;
      // The duplicate lives next to its source in the rig, with a slightly
      // larger local scale so it pokes out past the real surface.
      mesh.layers.set(layer);
      this.group.add(mesh);
      this._bind(mesh, src);
    }
    this.group.visible = this.group.children.length > 0;
  }

  /** Keep the silhouette on top of the rig as it animates. */
  sync() {
    if (!this.target || !this.group.visible) return;
    for (const mesh of this.group.children) {
      const src = mesh.userData.source;
      if (!src) continue;
      src.updateWorldMatrix(true, false);
      mesh.matrix.copy(src.matrixWorld);
      mesh.matrix.scale(new THREE.Vector3(this.inflate, this.inflate, this.inflate));
      mesh.matrixWorldNeedsUpdate = true;
    }
  }

  _bodyMeshes(fighter) {
    const out = [];
    fighter.bodyAnchor.updateMatrixWorld(true);
    fighter.bodyAnchor.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      // Leave the weapon out: the outline marks the body you can hit.
      for (let p = o; p && p !== fighter.bodyAnchor; p = p.parent) {
        if (p === fighter.bodyGun) return;
      }
      out.push(o);
    });
    return out;
  }

  _bind(mesh, src) {
    mesh.userData.source = src;
    src.updateWorldMatrix(true, false);
    mesh.matrix.copy(src.matrixWorld);
    mesh.matrix.scale(new THREE.Vector3(this.inflate, this.inflate, this.inflate));
  }

  clear() {
    this.group.clear();
    this.group.visible = false;
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }
}
