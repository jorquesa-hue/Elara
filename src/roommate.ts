// Student roommate matching (#9). Shared/student housing books people into BEDS
// (the space tree already models room→bed), and who shares a room matters. This
// is a PURE, deterministic compatibility engine: given each prospect's lifestyle
// preferences it scores pairwise fit (0..100) with an explainable per-dimension
// breakdown, honours hard deal-breakers (smoke-free / pet-free), and suggests
// roommate groupings to fill a room of N beds. The "AI matching" seam is exactly
// this score — an ML model can re-rank on top — but the arithmetic never guesses,
// so a placement is auditable and reproducible. Placement itself reuses the
// existing agreement booking + unit-transfer (#23) paths; this module only ranks.

export type Chronotype = 'early' | 'late' | 'flexible';

export interface RoommatePreferences {
  budgetCents?: number; // max monthly share they will pay (informational)
  cleanliness?: number; // 1..5 (5 = very tidy)
  social?: number; // 1..5 (1 = quiet/private, 5 = very social)
  chronotype?: Chronotype;
  smoker?: boolean;
  hasPet?: boolean;
  smokeFreeOnly?: boolean; // hard: will NOT share with a smoker
  petFreeOnly?: boolean; // hard: will NOT share with a pet owner
}

export interface Prospect {
  id: string;
  tenantId: string;
  name: string;
  partyId?: string; // optional link to a party in the prospect role
  preferences: RoommatePreferences;
}

export interface MatchFactor { dimension: string; delta: number; } // delta ≤ 0 penalty, contributes to the score

export interface CompatibilityResult {
  score: number; // 0..100
  compatible: boolean; // false when a hard deal-breaker is violated (score forced to 0)
  factors: MatchFactor[]; // the ordered explanation of every penalty applied
  dealBreakers: string[]; // which hard constraints were violated, if any
}

export interface RoommateMatch {
  prospectId: string;
  name: string;
  score: number;
  compatible: boolean;
}

export class RoommateError extends Error {}

// A hard deal-breaker: one party refuses a trait the other has. Symmetric check.
function dealBreakers(a: RoommatePreferences, b: RoommatePreferences): string[] {
  const out: string[] = [];
  if ((a.smokeFreeOnly && b.smoker) || (b.smokeFreeOnly && a.smoker)) out.push('smoking');
  if ((a.petFreeOnly && b.hasPet) || (b.petFreeOnly && a.hasPet)) out.push('pets');
  return out;
}

/** Pure: score how well two prospects would share a room (0..100), explained. */
export function compatibility(a: RoommatePreferences, b: RoommatePreferences): CompatibilityResult {
  const breakers = dealBreakers(a, b);
  if (breakers.length) {
    return { score: 0, compatible: false, factors: breakers.map((d) => ({ dimension: d, delta: -100 })), dealBreakers: breakers };
  }
  const factors: MatchFactor[] = [];
  let score = 100;
  const penalise = (dimension: string, delta: number) => { if (delta) { score += delta; factors.push({ dimension, delta }); } };

  // Lifestyle closeness: the further apart on a 1..5 scale, the bigger the hit.
  if (a.cleanliness !== undefined && b.cleanliness !== undefined) penalise('cleanliness', -Math.abs(a.cleanliness - b.cleanliness) * 8);
  if (a.social !== undefined && b.social !== undefined) penalise('social', -Math.abs(a.social - b.social) * 6);

  // Chronotype: a hard early-vs-late clash costs the most; 'flexible' never clashes.
  if (a.chronotype && b.chronotype && a.chronotype !== 'flexible' && b.chronotype !== 'flexible' && a.chronotype !== b.chronotype) {
    penalise('chronotype', -15);
  }

  // A shared smoking habit is fine; a mismatch (one smokes, no hard filter) is a mild penalty.
  if (a.smoker !== undefined && b.smoker !== undefined && a.smoker !== b.smoker) penalise('smoking', -10);

  if (score < 0) score = 0;
  return { score, compatible: true, factors, dealBreakers: [] };
}

export class RoommateMatcher {
  private prospects = new Map<string, Prospect>();

  upsertProspect(p: Prospect): Prospect {
    if (!p.id || !p.name) throw new RoommateError('prospect needs an id and a name');
    if (p.preferences.cleanliness !== undefined && (p.preferences.cleanliness < 1 || p.preferences.cleanliness > 5)) throw new RoommateError('cleanliness must be 1..5');
    if (p.preferences.social !== undefined && (p.preferences.social < 1 || p.preferences.social > 5)) throw new RoommateError('social must be 1..5');
    this.prospects.set(p.id, { ...p, preferences: { ...p.preferences } });
    return this.get(p.id);
  }

  get(id: string): Prospect {
    const p = this.prospects.get(id);
    if (!p) throw new RoommateError(`unknown prospect: ${id}`);
    return { ...p, preferences: { ...p.preferences } };
  }

  list(tenantId: string): Prospect[] {
    return [...this.prospects.values()].filter((p) => p.tenantId === tenantId).map((p) => ({ ...p, preferences: { ...p.preferences } }));
  }

  /** Rank every other prospect by compatibility with `target`. Deterministic:
   *  sorted by score desc, then id asc. */
  matchesFor(tenantId: string, targetId: string): RoommateMatch[] {
    const target = this.get(targetId);
    if (target.tenantId !== tenantId) throw new RoommateError(`unknown prospect: ${targetId}`);
    return this.list(tenantId)
      .filter((p) => p.id !== targetId)
      .map((p) => {
        const c = compatibility(target.preferences, p.preferences);
        return { prospectId: p.id, name: p.name, score: c.score, compatible: c.compatible };
      })
      .sort((x, y) => (y.score - x.score) || (x.prospectId < y.prospectId ? -1 : 1));
  }

  /** Greedily cluster the tenant's prospects into compatible groups of `capacity`
   *  (beds in a room). Each group seeds from the lowest remaining id, then pulls
   *  the highest-compatibility remaining prospects; incompatible (deal-breaker)
   *  prospects are never grouped. Deterministic. */
  suggestGrouping(tenantId: string, capacity: number): Array<{ members: string[]; avgScore: number }> {
    if (!Number.isInteger(capacity) || capacity < 2) throw new RoommateError('capacity must be an integer ≥ 2');
    const pool = this.list(tenantId).sort((a, b) => (a.id < b.id ? -1 : 1));
    const groups: Array<{ members: string[]; avgScore: number }> = [];
    const used = new Set<string>();

    for (const seed of pool) {
      if (used.has(seed.id)) continue;
      used.add(seed.id);
      const members = [seed];
      while (members.length < capacity) {
        // Best remaining candidate by average compatibility to the current members.
        let best: { p: Prospect; avg: number } | null = null;
        for (const cand of pool) {
          if (used.has(cand.id)) continue;
          const scores = members.map((m) => compatibility(m.preferences, cand.preferences));
          if (scores.some((s) => !s.compatible)) continue; // a deal-breaker with anyone → skip
          const avg = scores.reduce((s, c) => s + c.score, 0) / scores.length;
          if (!best || avg > best.avg || (avg === best.avg && cand.id < best.p.id)) best = { p: cand, avg };
        }
        if (!best) break;
        used.add(best.p.id);
        members.push(best.p);
      }
      const pairScores: number[] = [];
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairScores.push(compatibility(members[i]!.preferences, members[j]!.preferences).score);
      const avgScore = pairScores.length ? Math.round(pairScores.reduce((s, v) => s + v, 0) / pairScores.length) : 0;
      groups.push({ members: members.map((m) => m.id), avgScore });
    }
    return groups;
  }
}
