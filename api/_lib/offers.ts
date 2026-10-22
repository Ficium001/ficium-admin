/**
 * Offer fields, limits and validation — shared by the API and the admin form.
 * The database (admin.offer CHECKs + admin.offer_* functions) stays the final
 * authority; this layer gives fast, readable errors before a round-trip.
 */
export const CATEGORIES = ["borrow", "save", "invest"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Must be values of public.product_type on the App DB. */
export const PRODUCT_TYPES: { value: string; label: string; category: Category }[] = [
  { value: "mortgage", label: "Home loan", category: "borrow" },
  { value: "personal_loan", label: "Personal loan", category: "borrow" },
  { value: "leasing", label: "Vehicle loan / leasing", category: "borrow" },
  { value: "business_loan", label: "Business loan", category: "borrow" },
  { value: "overdraft", label: "Overdraft", category: "borrow" },
  { value: "credit_card", label: "Credit card", category: "borrow" },
  { value: "fixed_deposit", label: "Fixed deposit", category: "save" },
  { value: "savings_plan", label: "Savings plan", category: "save" },
  { value: "government_bonds", label: "Government bonds", category: "invest" },
  { value: "unit_trust", label: "Unit trust", category: "invest" },
  { value: "equities", label: "Listed shares", category: "invest" },
  { value: "offshore_investment", label: "Offshore investment", category: "invest" },
];

export const LIMITS = {
  institution_name: [2, 80], caption: [10, 400], headline: [2, 60], terms: [2, 120],
  image_tag: [0, 40], image_alt: [0, 200],
} as const;
export const MIN_REASON = 10;
export const VERIFY_DAYS = 30;

export type OfferInput = {
  institution_name: string; category: Category; product_type: string; caption: string;
  headline: string; terms: string; image_tag: string | null; image_url: string | null; image_alt: string | null;
  is_launch: boolean; launch_window_ends: string | null; expires_at: string;
  source_url: string | null; consent_ref: string | null; verified_at: string | null;
};

const IMAGE_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const opt = (v: unknown) => { const s = str(v); return s === "" ? null : s; };
const iso = (v: unknown) => { const s = opt(v); if (s === null) return null; const t = Date.parse(s); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); };

/** Returns the normalised offer or the first problem, in plain words. */
export function parseOffer(body: unknown): { ok: true; data: OfferInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const len = (k: keyof typeof LIMITS, label: string) => {
    const v = str(b[k]); const [min, max] = LIMITS[k];
    if (v.length < min || v.length > max) return `${label} must be ${min}–${max} characters`;
    return null;
  };
  const problems = [
    len("institution_name", "Provider name"), len("caption", "Caption"), len("headline", "Headline"),
    len("terms", "Terms"), len("image_tag", "Image tag"), len("image_alt", "Image description"),
  ].filter(Boolean);
  if (problems.length) return { ok: false, error: problems[0]! };

  const category = str(b.category) as Category;
  if (!CATEGORIES.includes(category)) return { ok: false, error: "Choose borrow, save or invest" };
  const product = PRODUCT_TYPES.find((p) => p.value === str(b.product_type));
  if (!product) return { ok: false, error: "Unknown product type" };
  if (product.category !== category) return { ok: false, error: `${product.label} belongs under ${product.category}` };

  const image_url = opt(b.image_url);
  if (image_url && !IMAGE_HOST.test(image_url)) return { ok: false, error: "Upload the image here; external image links aren't allowed" };
  const source_url = opt(b.source_url);
  if (source_url && !/^https:\/\//i.test(source_url)) return { ok: false, error: "Source link must start with https://" };

  const expires_at = iso(b.expires_at), verified_at = iso(b.verified_at), launch_window_ends = iso(b.launch_window_ends);
  if (!expires_at) return { ok: false, error: "Expiry date is required" };
  if (verified_at === undefined || launch_window_ends === undefined) return { ok: false, error: "A date is not valid" };
  const is_launch = b.is_launch === true;
  if (is_launch && !launch_window_ends) return { ok: false, error: "A launch needs a launch window end date" };
  if (launch_window_ends && launch_window_ends > expires_at) return { ok: false, error: "Launch window can't end after the offer expires" };

  return { ok: true, data: {
    institution_name: str(b.institution_name), category, product_type: product.value,
    caption: str(b.caption), headline: str(b.headline), terms: str(b.terms),
    image_tag: opt(b.image_tag), image_url, image_alt: opt(b.image_alt),
    is_launch, launch_window_ends: is_launch ? launch_window_ends : null, expires_at,
    source_url, consent_ref: opt(b.consent_ref), verified_at,
  } };
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
