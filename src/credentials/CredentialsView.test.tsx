import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CredentialsView, dueText, summary, draftOf } from "./CredentialsPage";
import type { Entry, View } from "./api";

const noop = async () => undefined;
const entry = (over: Partial<Entry>): Entry => ({
  key: "borrower_build_github_token", label: "GitHub token for borrower app builds", kind: "token",
  purpose: "Lets every Vercel build download ficium-integration.", env_names: "GITHUB_TOKEN",
  stored_in: "Doppler, synced to Vercel (borrower app)", used_by: "Borrower app builds", owner: "",
  expires_on: null, rotated_on: null, rotate_every_days: null, due_on: null, days_left: null, state: "no_date", note: "",
  retired_at: null, version: 0, updated_at: "2026-11-19T10:00:00Z", updated_by: null, ...over,
});
const view = (items: Entry[], over: Partial<View> = {}): View => ({ actor: "kj@ficium.net", can_manage: true, today: "2026-11-19", items, retired: [], ...over });
const text = (v: View) => renderToStaticMarkup(<CredentialsView view={v} editing={null} onEdit={() => undefined} onSave={noop} onRetire={noop} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("Keys and tokens page", () => {
  it("shows what each key is, where it is kept, and when to replace it", () => {
    const t = text(view([entry({ expires_on: "2026-11-17", due_on: "2026-11-17", days_left: -2, state: "expired" })]));
    expect(t).toMatch(/GitHub token for borrower app builds Access token · Lets every Vercel build/);
    expect(t).toContain("GITHUB_TOKEN");
    expect(t).toMatch(/Doppler, synced to Vercel \(borrower app\) Used by Borrower app builds/);
    expect(t).toMatch(/17 Nov 2026 Expired 2 days ago expires 17 Nov 2026/);
    expect(t).toContain("1 key or token has expired.");
  });

  it("says plainly when there is no date to warn from", () => {
    const t = text(view([entry({ rotate_every_days: 365 })]));
    expect(t).toContain("No date recorded");
    expect(t).toContain("rotate every 365 days, last rotation not recorded");
    expect(t).toMatch(/1 has no date recorded, so no warning can be given for it\./);
  });

  it("orders urgency in words", () => {
    expect(dueText(entry({ state: "due_soon", days_left: 0 })).text).toBe("Due today");
    expect(dueText(entry({ state: "due_soon", days_left: 1 })).text).toBe("Due tomorrow");
    expect(dueText(entry({ state: "due_soon", days_left: 9 }))).toEqual({ text: "Due in 9 days", pill: "warn" });
    expect(dueText(entry({ state: "ok", days_left: 80 }))).toEqual({ text: "80 days left", pill: "ok" });
    expect(summary([entry({ state: "ok" }), entry({ state: "due_soon" })]).tone).toBe("warn");
    expect(summary([entry({ state: "ok" })]).text).toBe("Every date is more than 14 days away");
  });

  it("offers editing only to admins who may manage the register", () => {
    const can = renderToStaticMarkup(<CredentialsView view={view([entry({})])} editing={null} onEdit={() => undefined} onSave={noop} onRetire={noop} />);
    expect(can).toContain('aria-label="Edit GitHub token for borrower app builds"');
    expect(can).toContain("Add a key or token");
    const cannot = text(view([entry({})], { can_manage: false }));
    expect(cannot).not.toContain("Add a key or token");
    expect(cannot).toContain("You can see this register but not change it.");
  });

  it("edits with the version it was shown, and a fresh reason", () => {
    const d = draftOf(entry({ version: 3, rotate_every_days: 90, expires_on: "2027-01-01" }));
    expect(d).toMatchObject({ version: 3, rotate_every_days: "90", expires_on: "2027-01-01", rotated_on: "", reason: "" });
    const html = renderToStaticMarkup(<CredentialsView view={view([entry({ version: 3 })])} editing={d} onEdit={() => undefined} onSave={noop} onRetire={noop} />);
    expect(html).toContain("Never paste the key itself.");
    expect(html).not.toContain('id="cred-key"');   // the short name of an existing entry cannot change
  });

  it("renders text from the register as text, never markup", () => {
    const html = renderToStaticMarkup(<CredentialsView view={view([entry({ purpose: "<img src=x onerror=alert(1)>" })])} editing={null} onEdit={() => undefined} onSave={noop} onRetire={noop} />);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
