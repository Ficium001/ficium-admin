/**
 * The 10 KYC checks. Keys must match public.kyc_settings columns and the
 * allowlist inside admin.set_kyc_check — the DB is the final authority, this
 * list exists so the app can reject unknown keys early and describe each one.
 * `critical`: switching it off means verification no longer proves the
 * applicant is a real, unique person who holds the ID.
 */
export const CHECKS = [
  { key: "face_match",       name: "Face match",          critical: true,
    confirms: "The selfie is the same person as the photo on the ID." },
  { key: "liveness_check",   name: "Liveness",            critical: true,
    confirms: "A live person is in front of the camera, not a photo, screen or mask." },
  { key: "duplicate_face",   name: "Duplicate face",      critical: true,
    confirms: "The same face isn't already behind another account." },
  { key: "document_reuse",   name: "Document reuse",      critical: true,
    confirms: "The same ID document isn't already used on another account." },
  { key: "ai_analysis",      name: "AI fraud review",     critical: false,
    confirms: "ID images show no signs of editing, forgery or screen capture." },
  { key: "ocr_name_match",   name: "Name match",          critical: false,
    confirms: "The name read from the ID matches the name the applicant entered." },
  { key: "mrz_validation",   name: "Passport code check", critical: false,
    confirms: "The machine-readable lines on a passport pass their check digits." },
  { key: "proof_of_address", name: "Proof of address",    critical: false,
    confirms: "The applicant supplied a document showing where they live." },
  { key: "permit_check",     name: "Permit check",        critical: false,
    confirms: "Non-citizens hold a valid work or residence permit." },
  { key: "velocity_check",   name: "Attempt rate",        critical: false,
    confirms: "No burst of verification attempts from the same person or device." },
] as const;

export type CheckKey = (typeof CHECKS)[number]["key"];
export const CHECK_KEYS: readonly string[] = CHECKS.map((c) => c.key);
export const isCheckKey = (k: unknown): k is CheckKey => typeof k === "string" && CHECK_KEYS.includes(k);
export const MIN_REASON = 10;
