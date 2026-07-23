// Tenant configuration — the setup-time knobs an operator flips once: display
// language, currency, timezone, and the business structure the deployment
// serves. Money is always stored in integer minor units (cents); presentation
// (locale + currency symbol + decimal places) is a config concern, never a
// storage concern. This keeps the ledger currency-agnostic and lets reporting
// format the same stored integers for any audience.

import { countryProfile } from './country.ts';

export interface CurrencyDef {
  code: string; // ISO 4217
  minorUnits: number; // decimal places (2 for most, 0 for JPY, 3 for BHD)
  name: string;
}

// A pragmatic, extensible set. Amounts are stored in the currency's minor unit.
export const SUPPORTED_CURRENCIES: readonly CurrencyDef[] = [
  { code: 'USD', minorUnits: 2, name: 'US Dollar' },
  { code: 'BRL', minorUnits: 2, name: 'Brazilian Real' },
  { code: 'EUR', minorUnits: 2, name: 'Euro' },
  { code: 'GBP', minorUnits: 2, name: 'Pound Sterling' },
  { code: 'MXN', minorUnits: 2, name: 'Mexican Peso' },
  { code: 'JPY', minorUnits: 0, name: 'Japanese Yen' },
  { code: 'CLP', minorUnits: 0, name: 'Chilean Peso' },
  { code: 'AED', minorUnits: 2, name: 'UAE Dirham' },
] as const;

export interface LocaleDef {
  code: string; // BCP-47
  name: string; // endonym
}

export const SUPPORTED_LOCALES: readonly LocaleDef[] = [
  { code: 'en', name: 'English' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'es', name: 'Español' },
] as const;

// Business-structure presets tune defaults and reporting emphasis. Not a hard
// enum — a deployment may set a custom label; presets just seed sensible starts.
export const BUSINESS_STRUCTURES = [
  'short_stay',
  'corporate_housing',
  'multifamily',
  'student_housing',
  'boutique_hotel',
  'mixed_portfolio',
] as const;
export type BusinessStructurePreset = (typeof BUSINESS_STRUCTURES)[number];

export interface TenantConfig {
  tenantId: string;
  displayName: string;
  locale: string;
  currency: string;
  timezone: string;
  /** A preset label or a custom string — flexible per deployment. */
  businessStructure: string;
  /** ISO 3166-1 alpha-2 country of this environment. */
  country: string;
  /** Legal jurisdiction the policy envelope reasons about (derived from country). */
  jurisdiction: string;
  // --- brand (optional; drives the portal accent + the public booking site) ---
  /** Hex accent color, e.g. '#6d8bff'. */
  brandColor?: string;
  /** A small logo as a data: URL (base64) or a hosted URL. */
  logoDataUrl?: string;
  /** A short marketing tagline shown on the booking site hero. */
  tagline?: string;
}

export class ConfigError extends Error {}

const DEFAULTS: Omit<TenantConfig, 'tenantId' | 'displayName'> = {
  locale: 'en',
  currency: 'USD',
  timezone: 'UTC',
  businessStructure: 'mixed_portfolio',
  country: 'US',
  jurisdiction: 'US',
};

/** A logo data URL must be a small image (≤256 KB) to keep the tenant row + flush
 *  payload sane. Returns a validated value or throws. */
export function assertBrandLogo(dataUrl: string): string {
  if (!/^data:image\/(png|jpeg|jpg|svg\+xml|webp|gif);base64,/.test(dataUrl) && !/^https:\/\//.test(dataUrl)) {
    throw new ConfigError('logo must be an https URL or a data:image/* base64 URL');
  }
  if (dataUrl.length > 256 * 1024) throw new ConfigError('logo is too large (max ~256 KB)');
  return dataUrl;
}

export function currencyDef(code: string): CurrencyDef {
  const c = SUPPORTED_CURRENCIES.find((x) => x.code === code);
  if (!c) throw new ConfigError(`unsupported currency: ${code}`);
  return c;
}

/** Format an integer minor-unit amount for a config's locale + currency. */
export function formatMoney(amountMinor: number, cfg: Pick<TenantConfig, 'locale' | 'currency'>): string {
  const def = currencyDef(cfg.currency);
  const major = amountMinor / 10 ** def.minorUnits;
  return new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency }).format(major);
}

export class ConfigStore {
  private byTenant = new Map<string, TenantConfig>();

  /** Returns the tenant's config, or a defaulted one keyed by id. */
  get(tenantId: string): TenantConfig {
    const existing = this.byTenant.get(tenantId);
    if (existing) return { ...existing };
    return { tenantId, displayName: tenantId, ...DEFAULTS };
  }

  /** Whether this tenant has been explicitly configured (vs. returning defaults).
   *  A jurisdiction "change" only matters once a tenant is really set up. */
  has(tenantId: string): boolean {
    return this.byTenant.has(tenantId);
  }

  /** Create/replace a tenant's config, validating locale + currency. The
   *  jurisdiction always follows the country (it is never set independently). */
  set(cfg: TenantConfig): TenantConfig {
    const withJurisdiction = { ...cfg, jurisdiction: countryProfile(cfg.country).jurisdiction };
    this.validate(withJurisdiction);
    this.byTenant.set(cfg.tenantId, { ...withJurisdiction });
    return this.get(cfg.tenantId);
  }

  /** Partial update — the common "change one setting" path from the UI. */
  update(tenantId: string, patch: Partial<Omit<TenantConfig, 'tenantId'>>): TenantConfig {
    const next = { ...this.get(tenantId), ...patch, tenantId };
    return this.set(next);
  }

  /** Set up a tenant for a country: currency/locale/timezone default from the
   *  country profile unless the caller overrides them. Master-data structure is
   *  untouched — only config + jurisdiction differ by country. */
  setupForCountry(tenantId: string, displayName: string, country: string, overrides: Partial<Omit<TenantConfig, 'tenantId' | 'displayName' | 'country' | 'jurisdiction'>> = {}): TenantConfig {
    const p = countryProfile(country);
    return this.set({
      tenantId,
      displayName,
      country,
      jurisdiction: p.jurisdiction,
      currency: overrides.currency ?? p.currency,
      locale: overrides.locale ?? p.locale,
      timezone: overrides.timezone ?? p.timezone,
      businessStructure: overrides.businessStructure ?? DEFAULTS.businessStructure,
    });
  }

  private validate(cfg: TenantConfig): void {
    if (!cfg.tenantId) throw new ConfigError('tenantId is required');
    if (!SUPPORTED_LOCALES.some((l) => l.code === cfg.locale)) {
      throw new ConfigError(`unsupported locale: ${cfg.locale}`);
    }
    currencyDef(cfg.currency); // throws if unsupported
    countryProfile(cfg.country); // throws if unsupported
    if (!cfg.displayName || cfg.displayName.length === 0) {
      throw new ConfigError('displayName is required');
    }
    if (!cfg.businessStructure) throw new ConfigError('businessStructure is required');
  }
}
