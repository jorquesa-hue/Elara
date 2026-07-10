// Country environments. A deployment can serve many countries, and each country
// is an ENVIRONMENT: it fixes the currency, presentation locale, timezone, the
// legal jurisdiction the policy envelope reasons about, and the label of the tax
// identity a party carries (CNPJ/CPF, EIN, NIF, RFC…). Crucially, a country
// changes CONFIGURATION and POLICY ONLY — never the master-data STRUCTURE. The
// same party/space/legal-entity/charge-type schema serves every country; a
// Brazilian condominium pass-through and a US multifamily lease are the same
// shapes with different config + jurisdiction-scoped policy. This is what lets
// one kernel + one schema deploy per country (or multi-tenant across countries)
// without forking the data model.

export interface CountryProfile {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  jurisdiction: string; // fed to PolicyEnvelope (rules may be jurisdiction-scoped)
  currency: string; // ISO 4217 default (a tenant may override)
  locale: string; // BCP-47 presentation default
  timezone: string; // IANA default
  taxIdLabel: string; // what a party's tax id is called here
}

// A pragmatic starter set spanning the Americas + Europe. Extend freely — adding
// a country is data, not a code change, and never touches the master-data schema.
export const COUNTRY_PROFILES: readonly CountryProfile[] = [
  { code: 'BR', name: 'Brazil', jurisdiction: 'BR', currency: 'BRL', locale: 'pt-BR', timezone: 'America/Sao_Paulo', taxIdLabel: 'CNPJ/CPF' },
  { code: 'US', name: 'United States', jurisdiction: 'US', currency: 'USD', locale: 'en', timezone: 'America/New_York', taxIdLabel: 'EIN/SSN' },
  { code: 'PT', name: 'Portugal', jurisdiction: 'EU', currency: 'EUR', locale: 'pt-BR', timezone: 'Europe/Lisbon', taxIdLabel: 'NIF' },
  { code: 'ES', name: 'Spain', jurisdiction: 'EU', currency: 'EUR', locale: 'es', timezone: 'Europe/Madrid', taxIdLabel: 'NIF' },
  { code: 'MX', name: 'Mexico', jurisdiction: 'MX', currency: 'MXN', locale: 'es', timezone: 'America/Mexico_City', taxIdLabel: 'RFC' },
  { code: 'GB', name: 'United Kingdom', jurisdiction: 'GB', currency: 'GBP', locale: 'en', timezone: 'Europe/London', taxIdLabel: 'CRN/UTR' },
] as const;

export class CountryError extends Error {}

export function countryProfile(code: string): CountryProfile {
  const c = COUNTRY_PROFILES.find((p) => p.code === code);
  if (!c) throw new CountryError(`unsupported country: ${code}`);
  return c;
}

export function isCountry(code: string): boolean {
  return COUNTRY_PROFILES.some((p) => p.code === code);
}
