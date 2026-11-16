import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReleasesView } from "./ReleasesPage";
import type { Loaded, Request } from "./api";

const PLAY = "https://play.google.com/store/apps/details?id=net.ficium.app";
const noop = async () => undefined;
const text = (s: Loaded, editing: "ios" | "android" | null = null) =>
  renderToStaticMarkup(<ReleasesView state={s} onRequest={noop} onDecide={noop} initialEditing={editing} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const base: Loaded = {
  actor: "kj@ficium.net", can_request: true, can_approve: true,
  policy: [
    { platform: "android", latest_version: "1.10.0", min_version: "1.9.0", store_url: PLAY, version: 2, updated_at: "2026-11-10T08:00:00Z", updated_by: "pj@ficium.net" },
    { platform: "ios", latest_version: "1.0.0", min_version: "1.0.0", store_url: "", version: 0, updated_at: "2026-11-01T08:00:00Z", updated_by: null },
  ],
  requests: [],
  usage: {
    generated_at: "2026-11-16T08:00:00Z",
    policy: [{ platform: "android", version: 2 }, { platform: "ios", version: 0 }],
    versions: [
      { platform: "android", app_version: "1.10.0", active_7d: 1200, active_30d: 1500 },
      { platform: "android", app_version: "1.9.0", active_7d: 300, active_30d: 480 },
      { platform: "android", app_version: "1.8.0", active_7d: 5, active_30d: 20 },
    ],
  },
  usage_error: null,
};
const pending = (over: Partial<Request> = {}): Request => ({
  id: "018f3a6e-7c1b-7c2a-9d3e-1a2b3c4d5e6f", platform: "android",
  latest_version: "1.10.0", min_version: "1.10.0", store_url: PLAY,
  before: { latest_version: "1.10.0", min_version: "1.9.0", store_url: PLAY },
  reason: "1.9.x has the session bug fixed in 1.10.0", status: "pending", maker: "pj@ficium.net", checker: null,
  decision_note: null, created_at: "2026-11-16T07:00:00Z", expires_at: "2026-11-19T07:00:00Z", decided_at: null, version: 1, mine: false, ...over });

describe("App releases page", () => {
  it("shows the policy, who is on which version and who is blocked now", () => {
    const t = text(base);
    expect(t).toContain("Android (Google Play)");
    expect(t).toContain("In force in the apps");
    expect(t).toContain("approved by pj@ficium.net");
    expect(t).toMatch(/1\.8\.0 5 20 Blocked: must update/);
    expect(t).toMatch(/1\.9\.0 300 480 Allowed/);
    expect(t).toMatch(/1\.10\.0 1,200 1,500 Latest/);
    expect(t).toMatch(/All versions 1,505 2,000 20 borrowers blocked now/);
    // iOS: nothing released yet
    expect(t).toContain("Never (starting values)");
    expect(t).toContain("No borrower has used this app in the last 30 days.");
    expect(t).toContain("Not set: the update screen shows no button");
  });

  it("lists the errors the apps reported, most widespread first, as plain text", () => {
    const withErrors: Loaded = { ...base, usage: { ...base.usage!, errors: [
      { platform: "android", app_version: "1.10.0", fingerprint: "0123456789abcdef", kind: "error", message: "TypeError: Cannot read 'amount' of undefined <b>x</b>",
        location: "assets/RequestDetail-Cdq.js:1:2345", route: "/requests/:id", borrowers_7d: 1200, occurrences_7d: 5400, last_seen_at: "2026-11-16T07:30:00Z" },
      { platform: "android", app_version: "1.8.0", fingerprint: "fedcba9876543210", kind: "render", message: "Error: old screen", location: "", route: "", borrowers_7d: 2, occurrences_7d: 2, last_seen_at: "" },
    ] } };
    const html = renderToStaticMarkup(<ReleasesView state={withErrors} onRequest={noop} onDecide={noop} />);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");          // never markup
    const t = text(withErrors);
    expect(t).toMatch(/Uncaught error · on \/requests\/:id · assets\/RequestDetail-Cdq\.js:1:2345 1\.10\.0 1,200 5,400/);
    expect(t).toMatch(/Screen failed to draw 1\.8\.0 \(blocked\) 2 2 —/);
    expect(t).toContain("No errors reported by this app in the last 7 days.");   // the iOS panel
  });

  it("says when an approved change has not reached the apps yet", () => {
    const t = text({ ...base, usage: { ...base.usage!, policy: [{ platform: "android", version: 1 }, { platform: "ios", version: 0 }] } });
    expect(t).toContain("Approved, not yet delivered to the apps");
  });

  it("keeps the policy visible when usage cannot be read", () => {
    const t = text({ ...base, usage: null, usage_error: "The borrower app could not be reached, so usage numbers are missing" });
    expect(t).toContain("Usage numbers are missing.");
    expect(t).toContain("Delivery to the apps unknown");
    expect(t).toContain("Versions in use: unavailable.");
    expect(t).toMatch(/Minimum version allowed 1\.9\.0/);
  });

  it("shows an approver exactly what changes and how many people it blocks", () => {
    const t = text({ ...base, requests: [pending()] });
    expect(t).toContain("pj@ficium.net asked for this change");
    expect(t).toMatch(/Minimum version allowed 1\.9\.0 1\.10\.0/);
    expect(t).toContain("This blocks 500 borrowers of the 2,000 active on Google Play in the last 30 days, until they update to 1.10.0 or newer.");
    expect(t).toContain("Approve change");
    expect(t).toContain("Reject");
    expect(t).not.toContain("Withdraw request");
    expect(t).not.toContain("Read from the portal");
  });

  it("offers the person who asked only a withdrawal: never approval of their own request", () => {
    const t = text({ ...base, requests: [pending({ mine: true })] });
    expect(t).toContain("You asked for this change");
    expect(t).toContain("Withdraw request");
    expect(t).not.toContain("Approve change");
  });

  it("lets a viewer without rights see everything and change nothing", () => {
    const t = text({ ...base, can_request: false, can_approve: false, requests: [pending()] });
    expect(t).not.toContain("Approve change");
    expect(t).toContain("Only an admin with approval rights who didn't ask can decide.");
    expect(t).toContain("You can see this page but not ask for changes.");   // iOS panel has no pending request
  });

  it("opens the change form prefilled, with the four-eyes notice", () => {
    const html = renderToStaticMarkup(<ReleasesView state={base} onRequest={noop} onDecide={noop} initialEditing="android" />);
    expect(html).toContain('value="1.10.0"');
    expect(html).toContain('value="1.9.0"');
    expect(html).toContain("A second admin must approve this before anything changes in the apps.");
    expect(html).toContain("Ask for approval");
  });

  it("lists decided requests with before and after", () => {
    const t = text({ ...base, requests: [pending({ status: "rejected", checker: "kj@ficium.net", decision_note: "wait for 1.10.1", decided_at: "2026-11-16T09:00:00Z" })] });
    expect(t).toContain("rejected by kj@ficium.net");
    expect(t).toContain("wait for 1.10.1");
    expect(t).toMatch(/Before After/);
  });
});
