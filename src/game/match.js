/**
 * Match rules: score limits, the clock, per-fighter statistics, kill streaks
 * and the end-of-round result. Kept separate from the render loop so the
 * headless verifier can run a whole match without a GPU.
 */

export const STREAKS = {
  3: 'ON A ROLL',
  5: 'RAMPAGE',
  7: 'UNSTOPPABLE',
  10: 'GODLIKE',
};

const DEFAULT_STATS = () => ({
  kills: 0,
  deaths: 0,
  damage: 0,
  headshots: 0,
  streak: 0,
  bestStreak: 0,
  shots: 0,
  hits: 0,
});

export class Match {
  constructor({ mode = 'solo', killLimit = 15, timeLimit = 480 } = {}) {
    this.mode = mode;
    this.killLimit = killLimit;
    this.timeLimit = timeLimit;
    this.elapsed = 0;
    this.over = false;
    this.winner = null;
    this.reason = '';
    this.stats = new Map();
    this.events = [];   // drained by main each frame: { kind, ... }
    this.pending = [];
  }

  reset(opts = {}) {
    this.mode = opts.mode ?? this.mode;
    this.killLimit = opts.killLimit ?? this.killLimit;
    this.timeLimit = opts.timeLimit ?? this.timeLimit;
    this.elapsed = 0;
    this.over = false;
    this.winner = null;
    this.reason = '';
    this.stats.clear();
  }

  get remaining() {
    if (this.timeLimit <= 0) return Infinity;
    return Math.max(0, this.timeLimit - this.elapsed);
  }

  stat(fighter) {
    let s = this.stats.get(fighter.id);
    if (!s) {
      s = DEFAULT_STATS();
      this.stats.set(fighter.id, s);
    }
    return s;
  }

  /** Track a trigger pull (for accuracy). */
  shot(fighter) {
    this.stat(fighter).shots++;
  }

  hit(fighter, headshot = false, amount = 0) {
    const s = this.stat(fighter);
    s.hits++;
    s.damage += Math.max(0, amount);
    if (headshot) s.headshots++;
  }

  /**
   * Register an elimination. Returns the bonus information main needs to
   * drive audio and the HUD (streak milestone, revenge, etc).
   */
  kill(killer, victim) {
    if (this.over) return null;
    const v = this.stat(victim);
    v.deaths++;
    v.streak = 0;

    let streak = 0;
    let milestone = null;
    let revenge = false;

    if (killer && killer !== victim) {
      const k = this.stat(killer);
      k.kills++;
      k.streak++;
      k.bestStreak = Math.max(k.bestStreak, k.streak);
      streak = k.streak;
      if (STREAKS[streak]) milestone = STREAKS[streak];
      revenge = victim.lastHitBy === killer && killer.lastKilledBy === victim;
      killer.lastKilledBy = victim;
    }

    this._checkWin(killer, victim);

    return { killer, victim, streak, milestone, revenge, over: this.over, winner: this.winner };
  }

  _checkWin(killer, victim) {
    if (this.mode === 'solo') {
      // Solo: the run ends when a bot puts you down.
      if (victim && !victim.isBot) {
        this.over = true;
        this.winner = killer && killer.isBot ? killer : null;
        this.reason = 'eliminated';
      }
      return;
    }
    const scorer = killer && killer !== victim ? killer : null;
    if (scorer && scorer.kills >= this.killLimit) {
      this.over = true;
      this.winner = scorer;
      this.reason = 'score';
      return;
    }
    if (this.elapsed >= this.timeLimit) {
      this.over = true;
      this.reason = 'time';
      this.winner = null;
    }
  }

  /** Advance the clock, stop on time limit. */
  update(dt) {
    if (this.over) return;
    this.elapsed += dt;
    if (this.timeLimit > 0 && this.elapsed >= this.timeLimit) {
      this.elapsed = this.timeLimit;
      this.over = true;
      this.reason = 'time';
    }
  }

  /** Final standings, highest kills first, deaths as the tie-breaker. */
  results(fighters) {
    return fighters
      .map((f) => {
        const s = this.stat(f);
        return {
          fighter: f,
          name: f.name,
          kills: s.kills,
          deaths: s.deaths,
          damage: Math.round(s.damage),
          headshots: s.headshots,
          bestStreak: s.bestStreak,
          accuracy: s.shots > 0 ? s.hits / s.shots : 0,
        };
      })
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.damage - a.damage);
  }

  /** Winner after a timeout is the scoreboard leader, if there is one. */
  resolveTimeoutWinner(fighters) {
    if (this.winner || this.reason !== 'time') return this.winner;
    const [first, second] = this.results(fighters);
    if (!first) return null;
    if (second && second.kills === first.kills && second.deaths === first.deaths) return null;
    this.winner = first.fighter;
    return this.winner;
  }

  get clock() {
    if (!Number.isFinite(this.remaining)) return '∞';
    const t = Math.ceil(this.remaining);
    const m = Math.floor(t / 60);
    const s = t % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
