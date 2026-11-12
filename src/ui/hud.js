import * as THREE from 'three';
import { WORLD } from '../world/heightfield.js';
import { sampleHeight } from '../world/heightgrid.js';

const MAP_R = 480;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
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
  <div class="scope">
    <div class="scope-ring"></div>
    <div class="scope-cross v"></div>
    <div class="scope-cross h"></div>
    <div class="scope-dot"></div>
    <div class="scope-mildots"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="scope-label">AWM .338</div>
  </div>
  <div class="dmg-dirs"></div>
  <div class="crosshair"><i></i><i></i><i></i><i></i><b></b></div>
  <div class="reload-ring"><svg viewBox="0 0 44 44"><circle class="track" cx="22" cy="22" r="18"></circle><circle class="fill" cx="22" cy="22" r="18"></circle></svg></div>
  <div class="hitmarker">✕</div>
  <div class="topline">
    <span class="pname"></span>
    <span class="score">0</span>
    <span class="clock"></span>
    <span class="ping"></span>
  </div>
  <div class="streak"></div>
  <div class="minimap">
    <canvas width="176" height="176"></canvas>
    <div class="mmlabel">N</div>
  </div>
  <div class="opp-marker"><span class="txt">ENEMY</span></div>
  <div class="vitals">
    <div class="row"><span class="hpnum">100</span><span class="hplabel">HP</span></div>
    <div class="bar"><i class="hp"></i></div>
    <div class="bar armor-bar"><i class="armor"></i></div>
    <div class="regen-pip"><i></i><span>REGEN</span></div>
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
        regenPip: el.querySelector('.regen-pip'),
        regenFill: el.querySelector('.regen-pip i'),
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
        reloadRing: el.querySelector('.reload-ring'),
        reloadFill: el.querySelector('.reload-ring .fill'),
        scope: el.querySelector('.scope'),
        scopeLabel: el.querySelector('.scope-label'),
        dmgDirs: el.querySelector('.dmg-dirs'),
        clock: el.querySelector('.clock'),
        ping: el.querySelector('.ping'),
        streakEl: el.querySelector('.streak'),
        streakTimer: 0,
        lastSlot: -1,
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

    // Regen readout: a thin pip that fills while the passive heal is running,
    // and shows a countdown during the post-damage wait.
    if (pane.regenPip) {
      const waiting = fighter.regenDelay > 0 && hp < 100;
      const healing = !waiting && fighter.regenT > 0 && hp < 100;
      pane.regenPip.classList.toggle('waiting', waiting);
      pane.regenPip.classList.toggle('healing', healing);
      const frac = healing ? clamp01(fighter.regenT / 15) : 0;
      if (pane.regenFill) pane.regenFill.style.transform = `scaleX(${frac})`;
    }

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
      pane.deathSub.textContent = `SPECTATING · RESPAWN IN ${Math.max(0, fighter.respawnTimer).toFixed(1)}s`;
      pane.crosshair.style.opacity = '0';
    } else {
      // The crosshair yields to whichever sight picture is up, or the two
      // reticles would double up at the aim point.
      const sighted = (def.kind === 'sniper' || def.kind === 'rifle') && fighter.aimT > 0.82;
      pane.crosshair.style.opacity = sighted ? '0' : '1';
    }

    // Red reticle while an enemy is under the crosshair.
    pane.crosshair.classList.toggle('on-target', !!fighter.onTarget);

    const reloading = fighter.reloading > 0;
    pane.crosshair.classList.toggle('reloading', reloading);
    if (reloading) {
      const t = clamp01(1 - fighter.reloading / def.reloadTime);
      pane.reloadFill.style.strokeDashoffset = String(113 * (1 - t));
      pane.reloadRing.classList.add('show');
    } else {
      pane.reloadRing.classList.remove('show');
    }
    pane.crosshair.classList.toggle('ads', fighter.aimT > 0.5);

    /*
     * Scope overlay. The sniper gets the full lens; the rifle's red-dot gets a
     * small window too, because at 0.2 m the optic's own rear element covers a
     * sixth of the pane and an opaque disc over the aim point is exactly what
     * made the AR-15 "just black" when aiming.
     */
    const scoped = def.kind === 'sniper' && fighter.aimT > 0.82;
    const redDot = def.kind === 'rifle' && fighter.aimT > 0.82;
    pane.scope.classList.toggle('show', scoped || redDot);
    pane.scope.classList.toggle('reddot', redDot);
    if (pane.scopeLabel) pane.scopeLabel.textContent = def.name;

    // Weapon swap flash on the name plate.
    if (pane.lastSlot !== fighter.slot) {
      pane.lastSlot = fighter.slot;
      pane.wname.classList.remove('swap');
      void pane.wname.offsetWidth;
      pane.wname.classList.add('swap');
    }

    // Damage direction arrows fade out.
    if (pane.dmgDirs.childElementCount) {
      for (const arrow of [...pane.dmgDirs.children]) {
        arrow.life -= dt;
        if (arrow.life <= 0) arrow.remove();
        else arrow.style.opacity = Math.min(1, arrow.life / 0.5);
      }
    }

    if (pane.streakTimer > 0) {
      pane.streakTimer -= dt;
      if (pane.streakTimer <= 0) pane.streakEl.classList.remove('show');
    }

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
    // On screen the marker shrinks to a 5 px dot so it never covers the enemy;
    // off screen it stays a small pill with the distance, so you can find them.
    marker.classList.toggle('onscreen', !offscreen);
    pane.oppTxt.textContent = `${target.name} · ${Math.round(bestD)}m`;
    // Hide the marker entirely while the reticle is already red on that enemy:
    // the outline and red crosshair say it better than a badge can.
    if (self.onTarget === target && !offscreen) marker.classList.remove('show');
  }

  /** Network latency readout. Pass null to hide it (offline modes). */
  setPing(ms) {
    for (const pane of this.panes) {
      if (!pane.ping) continue;
      if (ms === null || ms === undefined) {
        pane.ping.textContent = '';
        pane.ping.className = 'ping';
        continue;
      }
      pane.ping.textContent = `${Math.round(ms)} ms`;
      pane.ping.className = 'ping ' + (ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad');
    }
  }

  setClock(text) {
    for (const pane of this.panes) pane.clock.textContent = text;
  }

  setClockWarning(on) {
    for (const pane of this.panes) pane.clock.classList.toggle('urgent', on);
  }

  /**
   * Rotating chevron at the edge of the view pointing at where fire came
   * from. `angle` is the world-space bearing from the victim to the shooter.
   */
  showDamageDirection(index, angle) {
    const pane = this.panes[index];
    if (!pane) return;
    const arrow = document.createElement('div');
    arrow.className = 'dmg-dir';
    arrow.style.transform = `rotate(${angle}rad)`;
    arrow.innerHTML = '<span></span>';
    arrow.life = 1.6;
    pane.dmgDirs.appendChild(arrow);
    while (pane.dmgDirs.childElementCount > 4) pane.dmgDirs.firstElementChild.remove();
  }

  showStreak(index, text) {
    const pane = this.panes[index];
    if (!pane || !pane.streakEl) return;
    pane.streakEl.textContent = text;
    pane.streakEl.classList.remove('show');
    void pane.streakEl.offsetWidth;
    pane.streakEl.classList.add('show');
    pane.streakTimer = 2.4;
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

  /**
   * Fill the victory overlay: headline, reason line and a ranked table.
   * columns: ['K','D','ACC','DMG','HS']   rows: [{name, values: [...], me}]
   */
  renderEndcard(headline, sub, columns, rows) {
    const body = rows.map((r, i) => `
      <tr class="${r.me ? 'me' : ''}">
        <td class="rank">${i + 1}</td>
        <td class="who">${r.name}</td>
        ${r.values.map((v) => `<td>${v}</td>`).join('')}
      </tr>`).join('');
    return `
      <div class="overlayTitle">${headline}</div>
      <div class="overlaySub">${sub}</div>
      <table class="scoreboard">
        <thead>
          <tr><th class="rank">#</th><th class="who">PLAYER</th>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
  }
}
