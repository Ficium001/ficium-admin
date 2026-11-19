import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataProtectionView, deadline, summary } from "./DataProtectionPage";
import type { Request, Retention, View } from "./api";

const req = (over: Partial<Request> = {}): Request => ({
  id: "0193e1a0-0000-7000-8000-000000000001", ref: "DP-0001", kind: "access", requester: "A. Borrower", contact: "a@example.com",
  client_id: null, channel: "email", summary: "Asked for a copy of all data held about them", received_on: "2026-11-03", due_on: "2026-12-03",
  days_left: 14, status: "received", identity_verified_on: null, identity_method: null, owner: "op@ficium.net", mine: false,
  outcome: null, closed_on: null, closed_by: null, version: 1, created_by: "op@ficium.net",
  events: [{ at: "2026-11-03T08:00:00Z", by: "op@ficium.net", kind: "logged", text: "Logged. Due 03 Dec 2026." }], ...over,
});
const ret = (over: Partial<Retention> = {}): Retention => ({ key: "app_error_reports", data: "Error reports from the phone apps", where_kept: "Borrower app database",
  kept_for: "35 days", basis: "Fixing faults", how_deleted: "Deleted daily after 35 days", decided: true, enforced: true, version: 0, updated_at: "", updated_by: null, ...over });
const view = (over: Partial<View> = {}): View => ({ actor: "kj@ficium.net", today: "2026-11-19", can_manage: true, can_close: true,
  open: [req()], closed: [], retention: [ret(), ret({ key: "vault_documents", data: "Vault documents", decided: false, enforced: false, kept_for: "Not decided" })], ...over });
const render = (v: View, open: string | null = null) => renderToStaticMarkup(<DataProtectionView view={v} onChange={() => undefined} initiallyOpen={open} />);
const text = (v: View, open: string | null = null) => render(v, open).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("Data protection page", () => {
  it("leads with deadlines, and names undecided retention as a gap", () => {
    expect(summary(view({ open: [req({ days_left: -2 })] }))).toEqual({ tone: "danger", text: "1 request is past the one-month deadline. 1 kind of data still has no decided retention period." });
    expect(summary(view({ open: [req({ days_left: 3 })], retention: [ret()] }))).toEqual({ tone: "warn", text: "1 request is due within 7 days." });
    expect(summary(view({ open: [], retention: [ret()] })).text).toBe("No open requests.");
    expect([deadline(req({ days_left: -1 })).text, deadline(req({ days_left: 0 })).text, deadline(req({ days_left: 1 })).text]).toEqual(["Overdue by 1 day", "Due today", "Due in 1 day"]);
  });

  it("shows each open request with its deadline, identity check and status", () => {
    const t = text(view());
    expect(t).toMatch(/DP-0001 · Copy of their data A\. Borrower · Email · received 3 Nov 2026 Due in 14 days Identity not checked Received/);
  });

  it("asks for an identity check before work can start", () => {
    const opened = text(view(), req().id);
    expect(opened).toContain("Record identity check");
    expect(opened).not.toContain("Start work");
    expect(opened).not.toContain("Complete…");
    const checked = text(view({ open: [req({ identity_verified_on: "2026-11-04", identity_method: "Video call" })] }), req().id);
    expect(checked).toContain("Start work");
    expect(checked).toContain("Complete…");
  });

  it("only offers completing or refusing to admins who may close", () => {
    const t = text(view({ can_close: false, open: [req({ identity_verified_on: "2026-11-04", identity_method: "Video call" })] }), req().id);
    expect(t).not.toContain("Complete…");
    expect(t).not.toContain("Refuse…");
    expect(t).toContain("Only compliance can complete or refuse a request.");
  });

  it("shows the retention schedule with its state in words", () => {
    const t = text(view());
    expect(t).toMatch(/Error reports from the phone apps Borrower app database Enforced 35 days/);
    expect(t).toMatch(/Vault documents .* Not decided Not decided/);
  });

  it("says whether a closed request was answered on time", () => {
    const t = text(view({ open: [], closed: [req({ status: "completed", outcome: "Sent the export by email", closed_on: "2026-11-18", closed_by: "kj@ficium.net", days_left: null })] }));
    expect(t).toMatch(/Completed Sent the export by email 18 Nov 2026 kj@ficium\.net On time/);
  });

  it("renders what people wrote as text, never markup", () => {
    expect(render(view({ open: [req({ summary: "<img src=x onerror=alert(1)>" })] }), req().id)).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
