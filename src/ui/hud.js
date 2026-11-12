import * as THREE from 'three';
import { WORLD } from '../world/heightfield.js';
import { sampleHeight } from '../world/heightgrid.js';

const MAP_R = 480;
const _v = new THREE.Vector3();

/** Top-down island image used by both minimaps. */
export function buildIslandImage(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);

  for (let j = 0; j < size; j++) {
    const z = -MAP_R + (j / (size - 1)) * MAP_R * 2;
    for (let i = 0; i < size; i++) {
      const x = -MAP_R + (i / (size - 1)) * MAP_R * 2;
      const h = sampleHeight(x, z);
      let r, g, b;
      if (h < 0) {
        const t = Math.min(1, -h / 26);
        r = 22 - t * 8; g = 54 - t * 22; b = 78 - t * 24;
      } else if (h < 3.5) {
        r = 196; g = 176; b = 128;
      } else if (h < 62) {
        const t = Math.min(1, (h - 3.5) / 58);
        r = 58 + t * 16; g = 96 + t * 14; b = 46 + t * 10;
      } else if (h < 96) {
        const t = Math.min(1, (h - 62) / 34);
        r = 96 + t * 24; g = 92 + t * 18; b = 78 + t * 14;
      } else {
        const t = Math.min(1, (h - 96) / 25);
        r = 214 + t * 26; g = 222 + t * 22; b = 230 + t * 20;
      }
      const k = (j * size + i) * 4;
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const PANE_TEMPLATE = `
  <div class="damage-flash"></div>
  <div class="crosshair"><i></i><i></i><i></i><i></i><b></b></div>
  <div class="hitmarker">✕</div>
  <div class="topline">
    <span class="pname"></span>
    <span class="score">0</span>
  </div>
  <div class="minimap">
    <canvas width="176" height="176"></canvas>
    <div class="mmlabel">N</div>
  </div>
  <div class="opp-marker"><span class="txt">ENEMY</span></div>
  <div class="vitals">
    <div class="row"><span class="hpnum">100</span><span class="hplabel">HP</span></div>
    <div class="bar"><i class="hp"></i></div>
    <div class="bar armor-bar"><i class="armor"></i></div>
  </div>
  <div class="weaponbox">
    <span class="wname">AR-15</span>
    <span class="ammo"><b>30</b><em>/120</em></span>
    <span class="meds">MED ×2</span>
  </div>
  <div class="feed"></div>
  <div class="toast"></div>
  <div class="deathscreen">
    <div class="dtitle">ELIMINATED</div>
    <div class="dsub"></div>
  </div>
  <div class="spectate">SPECTATING</div>
`;

export class Hud {
  constructor(root) {
    this.root = root;
    this.panes = [];
    this.islandImage = null;
    this.feedItems = [];
  }

  createPanes(count) {
    this.root.innerHTML = '';
    this.panes = [];
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = `pane p${i + 1}${count === 2 ? (i === 0 ? ' left' : ' right') : ' full'}`;
      el.innerHTML = PANE_TEMPLATE;
      this.root.appendChild(el);

      const pane = {
        el,
        damage: el.querySelector('.damage-flash'),
        hitmarker: el.querySelector('.hitmarker'),
        name: el.querySelector('.pname'),
        score: el.querySelector('.score'),
        hpNum: el.querySelector('.hpnum'),
        hpBar: el.querySelector('.hp'),
        armorBar: el.querySelector('.armor'),
        wname: el.querySelector('.wname'),
        ammoB: el.querySelector('.ammo b'),
        ammoE: el.querySelector('.ammo em'),
        meds: el.querySelector('.meds'),
        minimap: el.querySelector('canvas'),
        mmCtx: el.querySelector('canvas').getContext('2d'),
        oppMarker: el.querySelector('.opp-marker'),
        oppTxt: el.querySelector('.opp-marker .txt'),
        feed: el.querySelector('.feed'),
        toast: el.querySelector('.toast'),
        death: el.querySelector('.deathscreen'),
        deathSub: el.querySelector('.dsub'),
        crosshair: el.querySelector('.crosshair'),
        hitTimer: 0,
        damageTimer: 0,
        toastTimer: 0,
        lastAmmo: -1,
      };
      this.panes.push(pane);
    }
    // Divider between the two views
    if (count === 2) {
      const div = document.createElement('div');
      div.className = 'split-divider';
      this.root.appendChild(div);
    }
  }

  setNames(names) {
    this.panes.forEach((p, i) => { p.name.textContent = names[i] || ''; });
  }

  addFeed(text, color = '#ffd9a0') {
    for (const pane of this.panes) {
      const item = document.createElement('div');
      item.className = 'feed-item';
      item.textContent = text;
      item.style.color = color;
      pane.feed.appendChild(item);
      setTimeout(() => item.remove(), 5000);
      while (pane.feed.childElementCount > 5) pane.feed.firstElementChild.remove();
    }
  }

  toast(paneIndex, text) {
    const pane = this.panes[paneIndex];
    if (!pane) return;
    pane.toast.textContent = text;
    pane.toast.classList.add('show');
    pane.toastTimer = 1.4;
  }

  flashHit(paneIndex, headshot = false) {
    const pane = this.panes[paneIndex];
    if (!pane) return;
    pane.hitmarker.classList.add('show');
    pane.hitmarker.classList.toggle('head', headshot);
    pane.hitTimer = 0.22;
  }

  flashDamage(paneIndex) {
    const pane = this.panes[paneIndex];
    if (!pane) return;
    pane.damage.classList.add('show');
    pane.damageTimer = 0.45;
  }

  update(dt, index, fighter, others, pickups, camera) {
    const pane = this.panes[index];
    if (!pane || !fighter) return;

    // timers
    if (pane.hitTimer > 0) {
      pane.hitTimer -= dt;
      if (pane.hitTimer <= 0) pane.hitmarker.classList.remove('show');
    }
    if (pane.damageTimer > 0) {
      pane.damageTimer -= dt;
      if (pane.damageTimer <= 0) pane.damage.classList.remove('show');
    }
    if (pane.toastTimer > 0) {
      pane.toastTimer -= dt;
      if (pane.toastTimer <= 0) pane.toast.classList.remove('show');
    }

    const hp = Math.max(0, Math.round(fighter.health));
    pane.hpNum.textContent = hp;
    pane.hpBar.style.width = `${hp}%`;
    pane.hpBar.className = 'hp' + (hp < 35 ? ' low' : '');
    pane.armorBar.style.width = `${Math.max(0, fighter.armor)}%`;

    const def = fighter.weapon;
    const slot = fighter.slotData;
    pane.wname.textContent = def.name;
    pane.ammoB.textContent = slot.ammo;
    pane.ammoE.textContent = `/${slot.reserve}`;
    pane.ammoB.className = slot.ammo === 0 ? 'empty' : '';
    pane.meds.textContent = `MED ×${fighter.medkits}`;
    pane.score.textContent = fighter.kills;

    pane.death.classList.toggle('show', !fighter.alive);
    if (!fighter.alive) {
      pane.deathSub.textContent = `RESPAWN IN ${Math.max(0, fighter.respawnTimer).toFixed(1)}s`;
      pane.crosshair.style.opacity = '0';
    } else {
      pane.crosshair.style.opacity = '1';
    }

    const reloading = fighter.reloading > 0;
    pane.crosshair.classList.toggle('reloading', reloading);
    pane.crosshair.classList.toggle('ads', fighter.aimT > 0.5);

    this.drawMinimap(pane, fighter, others, pickups);
    this.updateOpponentMarker(pane, fighter, others, camera);
  }

  drawMinimap(pane, self, others, pickups) {
    const ctx = pane.mmCtx;
    const w = pane.minimap.width;
    const h = pane.minimap.height;
    const scale = w / (MAP_R * 2);
    const toX = (x) => (x + MAP_R) * scale;
    const toY = (z) => (z + MAP_R) * scale;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w / 2 - 1, 0, Math.PI * 2);
    ctx.clip();
    if (!this.islandImage) this.islandImage = buildIslandImage(256);
    ctx.drawImage(this.islandImage, 0, 0, w, h);

    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, (w / 2) * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // opponents
    for (const o of others) {
      if (o === self || !o.alive) continue;
      const x = toX(o.position.x);
      const y = toY(o.position.z);
      ctx.beginPath();
      ctx.arc(x, y, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = o.isBot ? '#ff9d3c' : '#ff4d4d';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (pickups) {
      for (const it of pickups.items) {
        if (!it.active) continue;
        const x = toX(it.position.x);
        const y = toY(it.position.z);
        ctx.fillStyle = it.type === 'medkit' ? '#5bff9d'
          : it.type === 'ammo' ? '#ffc352'
          : it.type === 'armor' ? '#63a8ff'
          : '#53e0d0';
        ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
      }
    }

    // self arrow
    const sx = toX(self.position.x);
    const sy = toY(self.position.z);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-self.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fillStyle = '#7ef7e4';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  updateOpponentMarker(pane, self, others, camera) {
    const marker = pane.oppMarker;
    let target = null;
    let bestD = Infinity;
    for (const o of others) {
      if (o === self || !o.alive) continue;
      const d = o.position.distanceTo(self.position);
      if (d < bestD) { bestD = d; target = o; }
    }
    if (!target || !camera) {
      marker.classList.remove('show');
      return;
    }

    _v.copy(target.position);
    _v.y += 1.9;
    const world = _v.clone();
    _v.project(camera);

    const behind = _v.z > 1;
    const rectW = this.panes.length > 1 ? window.innerWidth / 2 : window.innerWidth;
    const rectH = window.innerHeight;
    let x = (_v.x * 0.5 + 0.5) * rectW;
    let y = (-_v.y * 0.5 + 0.5) * rectH;

    let offscreen = behind;
    if (!behind && (x < 10 || x > rectW - 10 || y < 10 || y > rectH - 10)) offscreen = true;

    if (behind) {
      x = rectW - x;
      y = rectH - y;
    }

    const margin = 34;
    x = Math.min(rectW - margin, Math.max(margin, x));
    y = Math.min(rectH - margin, Math.max(margin, y));

    marker.style.transform = `translate(${x}px, ${y}px)`;
    marker.classList.add('show');
    marker.classList.toggle('offscreen', offscreen);
    pane.oppTxt.textContent = `${target.name} · ${Math.round(bestD)}m`;
  }

  setSpectating(index, on) {
    const pane = this.panes[index];
    if (!pane) return;
    pane.el.classList.toggle('spectating', on);
  }

  destroy() {
    this.root.innerHTML = '';
    this.panes = [];
  }
}
