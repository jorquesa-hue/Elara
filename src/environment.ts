// Country environment — the per-country SETUP that stands up over the ONE
// identical master-data structure. This is the architectural contract the whole
// system is built to honour: every country gets its own environment (its own
// currency, locale, timezone, jurisdiction, tax identity, and jurisdiction-scoped
// policy), while the master-data STRUCTURE — the party/space/legal-entity/
// charge-type/unit/guest/agreement shapes — is byte-for-byte the same everywhere.
// So provisioning Brazil vs the US is the SAME migrations + SAME kernel with a
// different EnvironmentBlueprint; there is never a per-country schema fork.

import { countryProfile } from './country.ts';
import { effectiveRulesFor, type PolicyEffect } from './policy-envelope.ts';
import { COLLECTION_STAGES } from './collections.ts';

// The master-data STRUCTURE, enumerated once. Every country environment gets
// exactly these aggregates/tables — this list is the shared contract, and its
// being a single constant (not parameterised by country) is the guarantee that
// the structure never forks. New master-data shapes are added here, for all
// countries at once, or not at all.
export const MASTER_DATA_STRUCTURE = [
  'legal_entity', // operator / condominium / landlord / spe
  'party', // person or organization (resident, guarantor, payee, vendor…)
  'space', // property → building → unit → room → bed (+ common/amenity)
  'charge_type', // a charge code → gl_account + receiving entity
  'unit', // the leasable/reporting unit
  'guest', // the staying party (legacy alias of a resident party)
  'agreement', // the event-sourced tenancy aggregate
] as const;

export interface EnvironmentPolicyRule {
  action: string;
  effect: PolicyEffect;
  jurisdictions?: readonly string[]; // present only on jurisdiction-scoped rules
  conditionNote?: string;
}

export interface EnvironmentBlueprint {
  country: string;
  jurisdiction: string;
  taxIdLabel: string;
  config: { currency: string; locale: string; timezone: string; businessStructure: string };
  /** The effective policy for this jurisdiction (global rules + jurisdiction-scoped). */
  policy: EnvironmentPolicyRule[];
  collectionStages: string[];
  /** The IDENTICAL master-data structure — the same for every country. */
  masterDataStructure: readonly string[];
}

/**
 * Build the complete setup for a country environment. Config defaults come from
 * the country profile (overridable); the effective policy is the one source of
 * truth sliced to this jurisdiction; the master-data structure is the shared
 * constant. Pure and deterministic — the same country always yields the same
 * blueprint, so provisioning is reproducible.
 */
export function buildEnvironment(
  country: string,
  overrides: Partial<{ currency: string; locale: string; timezone: string; businessStructure: string }> = {},
): EnvironmentBlueprint {
  const p = countryProfile(country);
  return {
    country: p.code,
    jurisdiction: p.jurisdiction,
    taxIdLabel: p.taxIdLabel,
    config: {
      currency: overrides.currency ?? p.currency,
      locale: overrides.locale ?? p.locale,
      timezone: overrides.timezone ?? p.timezone,
      businessStructure: overrides.businessStructure ?? 'mixed_portfolio',
    },
    policy: effectiveRulesFor(p.jurisdiction).map((r) => ({
      action: r.action,
      effect: r.effect,
      ...(r.jurisdictions ? { jurisdictions: r.jurisdictions } : {}),
      ...(r.conditionNote ? { conditionNote: r.conditionNote } : {}),
    })),
    collectionStages: COLLECTION_STAGES.map((s) => s.id),
    masterDataStructure: MASTER_DATA_STRUCTURE,
  };
}
