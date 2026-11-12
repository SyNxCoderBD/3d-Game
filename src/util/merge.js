import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Merge all direct mesh children of `group` into one mesh per material.
 * Sub-groups (bones, muzzles) are left untouched, so rigged characters and
 * animated weapons keep working while drawing far fewer objects.
 *
 * These models are built from dozens of little boxes and cylinders; without
 * this, a split-screen scene with a handful of soldiers costs ~800 draw calls.
 */
export function mergeDirectMeshes(group) {
  const meshes = group.children.filter((c) => c.isMesh);
  if (meshes.length < 2) return;

  const byMat = new Map();

  for (const mesh of meshes) {
    mesh.updateMatrix();
    let geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrix);

    for (const key of Object.keys(geo.attributes)) {
      if (key !== 'position' && key !== 'normal' && key !== 'uv') geo.deleteAttribute(key);
    }
    if (!geo.attributes.uv) {
      const count = geo.attributes.position.count;
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();

    if (!byMat.has(mesh.material)) byMat.set(mesh.material, []);
    byMat.get(mesh.material).push(geo);
  }

  const results = [];
  for (const [material, list] of byMat) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!merged) return; // incompatible attributes: leave the group alone
    results.push({ material, geometry: merged });
  }

  for (const mesh of meshes) group.remove(mesh);

  for (const r of results) {
    const mesh = new THREE.Mesh(r.geometry, r.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}
