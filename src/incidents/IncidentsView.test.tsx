import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IncidentsView, breachClock, summary, prefillFrom, duration } from "./IncidentsPage";
import type { Incident, View } from "./api";

const NOW = "2026-11-19T12:00:00Z";
const inc = (over: Partial<Incident> = {}): Incident => ({
  id: "0193e1a0-0000-7000-8000-000000000001", ref: "INC-0001", title: "Borrower app deploys failing", severity: 2, kind: "change",
  service_key: "deploy_borrower_app", impact: "No new borrower app version can ship", started_at: "2026-11-17T22:00:00Z",
  detected_at: "2026-11-19T10:00:00Z", mitigated_at: null, resolved_at: null, closed_at: null, status: "investigating",
  personal_data: false, breach_reported_at: null, breach_not_reported: null, people_told_at: null, breach_due_at: null,
  root_cause: null, owner: "kj@ficium.net", mine: true, closed_by: null, created_by: "kj@ficium.net", version: 1,
  events: [{ at: "2026-11-19T10:05:00Z", by: "kj@ficium.net", kind: "opened", text: "Opened: Borrower app deploys failing" }], follow_ups: [], ...over,
});
const view = (over: Partial<View> = {}): View => ({ actor: "kj@ficium.net", now: NOW, can_manage: true, can_close: true, open: [inc()], closed: [], ...over });
const render = (v: View, open: string | null = null) => renderToStaticMarkup(<IncidentsView view={v} onChange={() => undefined} initiallyOpen={open} />);
const text = (v: View, open: string | null = null) => render(v, open).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const breach = inc({ personal_data: true, severity: 1, breach_due_at: "2026-11-22T10:00:00Z" });

describe("Incidents page", () => {
  it("leads with a breach the Commissioner has not been told about", () => {
    expect(summary(view({ open: [breach] }))).toEqual({ tone: "danger", text: "1 incident involves personal data the Commissioner has not been told about yet." });
    expect(summary(view()).tone).toBe("warn");
    expect(summary(view({ open: [] })).text).toBe("No open incidents.");
  });

  it("counts the 72 hours down, and says when they have passed", () => {
    expect(breachClock(breach, Date.parse(NOW))).toEqual({ text: "Tell the Commissioner within 70 h", pill: "warn" });
    expect(breachClock({ ...breach, breach_due_at: "2026-11-19T09:00:00Z" }, Date.parse(NOW))).toEqual({ text: "Commissioner not told: 3 h late", pill: "danger" });
    expect(breachClock(inc(), Date.parse(NOW))).toBeNull();
  });

  it("shows each open incident with severity, clock and status, times in Mauritius", () => {
    const t = text(view({ open: [breach] }), breach.id);
    expect(t).toMatch(/INC-0001 · Borrower app deploys failing Failed change or deploy · noticed 19 Nov, 14:00 · kj@ficium\.net Severity 1 Tell the Commissioner within 70 h Investigating/);
    expect(t).toContain("Commissioner: due by 22 Nov, 14:00");
    expect(t).toContain("Reported to the Commissioner…");
  });

  it("offers closing only to compliance, only once resolved, and says what is missing", () => {
    const resolved = inc({ status: "resolved", resolved_at: NOW, follow_ups: [{ id: "f", text: "Track token expiries", owner: "KJ", due_on: null, done_at: null, done_by: null }] });
    const t = text(view({ open: [resolved] }), resolved.id);
    expect(t).toContain("Close…");
    expect(t).toContain("To close: record the root cause and finish 1 follow-up.");
    expect(text(view({ can_close: false, open: [resolved] }), resolved.id)).not.toContain("Close…");
    expect(text(view(), inc().id)).not.toContain("Close…");
  });

  it("opens the report form from a Services row", () => {
    expect(prefillFrom("#incidents/new/deploy_borrower_app")).toBe("deploy_borrower_app");
    expect(prefillFrom("#incidents/new/../../x")).toBeNull();
    const html = renderToStaticMarkup(<IncidentsView view={view({ open: [] })} onChange={() => undefined} prefill="deploy_auth" />);
    expect(html).toContain("Report an incident");
    expect(html).toContain("deploy_auth");
  });

  it("shows how long closed incidents lasted", () => {
    expect([duration("2026-11-19T10:00:00Z", "2026-11-19T10:45:00Z"), duration("2026-11-19T10:00:00Z", "2026-11-19T16:00:00Z"), duration(NOW, null)])
      .toEqual(["45 min", "6 h", "—"]);
  });

  it("renders what people wrote as text, never markup", () => {
    expect(render(view({ open: [inc({ impact: "<img src=x onerror=alert(1)>" })] }), inc().id)).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
