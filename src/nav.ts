/**
 * The admin menu, grouped into modules and their pages. Each site lists only its own modules,
 * and its API only serves them. The keys are the URL hashes (#clients, #kyc, …), unchanged from
 * the flat menu, so bookmarks keep working.
 */
export type Item = { key: string; label: string };
export type Group = { label: string; items: Item[] };

export const APP_NAV: Group[] = [
  { label: "Customers", items: [{ key: "clients", label: "Borrowers" }, { key: "reviews", label: "KYC reviews" }, { key: "privacy", label: "Data protection" }] },
  { label: "Product", items: [{ key: "offers", label: "Offers" }, { key: "releases", label: "App releases" }] },
  { label: "Setup", items: [{ key: "kyc", label: "KYC settings" }, { key: "team", label: "Team" }, { key: "credentials", label: "Keys and tokens" }] },
  { label: "Monitoring", items: [{ key: "services", label: "Services" }, { key: "incidents", label: "Incidents" }, { key: "traffic", label: "API traffic" }, { key: "audit", label: "Audit" }] },
];

export const PORTAL_NAV: Group[] = [
  { label: "Banks", items: [{ key: "applications", label: "Applications" }, { key: "institutions", label: "Banks" }, { key: "commission", label: "Commission" }] },
  { label: "Setup", items: [{ key: "roles", label: "Roles" }, { key: "compliance", label: "Compliance" }, { key: "team", label: "Team" }, { key: "credentials", label: "Keys and tokens" }] },
  { label: "Monitoring", items: [{ key: "services", label: "Services" }, { key: "incidents", label: "Incidents" }, { key: "traffic", label: "API traffic" }, { key: "audit", label: "Audit" }] },
];

export const navFor = (site: "app" | "portal"): Group[] => (site === "portal" ? PORTAL_NAV : APP_NAV);
export const itemsOf = (nav: Group[]): Item[] => nav.flatMap((g) => g.items);

/** The page for a URL hash, or the first page when the hash names nothing on this site. */
export function sectionFrom(hash: string, nav: Group[]): string {
  // "#incidents/new/deploy_auth": the page is the part before the first "/", the rest is for the page.
  const k = hash.replace(/^#/, "").split("/")[0] ?? "";
  const items = itemsOf(nav);
  return items.find((i) => i.key === k)?.key ?? items[0]!.key;
}

/** Where a page sits, for the mobile menu button and the page title. */
export function locate(key: string, nav: Group[]): { group: string; label: string } | null {
  for (const g of nav) for (const i of g.items) if (i.key === key) return { group: g.label, label: i.label };
  return null;
}
