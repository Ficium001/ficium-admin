import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CasesView, deadline, summary } from "./CasesPage";
import type { Case, View } from "./api";

const NOW = "2026-11-19T12:00:00Z";
const c = (over: Partial<Case> = {}): Case => ({
  id: "0193e1a0-0000-7000-8000-000000000001", ref: "CASE-0001", kind: "complaint", category: "bids", subject: "No bids after five days",
  detail: "Posted a home loan request and nothing came in", requester: "A. Borrower", contact: "a@example.com", client_id: null, channel: "email",
  received_at: "2026-11-18T06:00:00Z", ack_due_at: "2026-11-20T06:00:00Z", resolve_due_on: "2026-12-03", days_left: 14, ack_overdue: false,
  acknowledged_at: null, status: "open", outcome: null, upheld: null, redress: null, referred_to: null, referred_at: null, resolved_at: null,
  resolved_by: null, on_time: null, owner: "op@ficium.net", mine: false, reopened: 0, version: 1,
  events: [{ at: "2026-11-18T06:05:00Z", by: "op@ficium.net", kind: "opened", text: "Opened." }], ...over,
});
const REG = { received: 0, resolved: 0, on_time: 0, upheld: 0, partly: 0, not_upheld: 0, referred: 0, by_category: {} };
const view = (over: Partial<View> = {}): View => ({ actor: "kj@ficium.net", now: NOW, today: "2026-11-19", can_manage: true, can_resolve_complaint: true,
  open: [c()], closed: [], targets: [{ kind: "complaint", ack_hours: 48, resolve_days: 15, version: 0, updated_by: null, updated_at: NOW }], complaints_12m: REG, ...over });
const render = (v: View, open: string | null = null) => renderToStaticMarkup(<CasesView view={v} onChange={() => undefined} initiallyOpen={open} />);
const text = (v: View, open: string | null = null) => render(v, open).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("Complaints and cases page", () => {
  it("leads with missed deadlines and says how many open cases are complaints", () => {
    expect(summary(view({ open: [c({ ack_overdue: true })] }))).toEqual({ tone: "danger", text: "1 case has missed a deadline. 1 of the open cases is a complaint." });
    expect(summary(view({ open: [c({ days_left: 2, kind: "question" })] }))).toEqual({ tone: "warn", text: "1 case is due within 3 days." });
    expect(summary(view({ open: [] })).text).toBe("No open cases.");
    expect([deadline(c({ ack_overdue: true })).text, deadline(c({ days_left: -2 })).text, deadline(c({ days_left: null, on_time: false })).text])
      .toEqual(["Not acknowledged in time", "Answer overdue by 2 days", "Answered late"]);
  });

  it("shows each case with its kind and deadline, times in Mauritius", () => {
    expect(text(view())).toMatch(/CASE-0001 · No bids after five days Bids · A\. Borrower · Email · received 18 Nov, 10:00 Complaint Answer due in 14 days/);
  });

  it("only compliance can answer a complaint; anyone managing can answer a question", () => {
    const op = view({ can_resolve_complaint: false });
    expect(text(op, c().id)).not.toContain("Record the answer…");
    expect(text(op, c().id)).toContain("Only compliance can decide a complaint.");
    const q = view({ can_resolve_complaint: false, open: [c({ kind: "question" })] });
    expect(text(q, c().id)).toContain("Record the answer…");
  });

  it("shows the complaints register: on time, upheld, taken further, by subject", () => {
    const t = text(view({ complaints_12m: { received: 4, resolved: 3, on_time: 2, upheld: 1, partly: 1, not_upheld: 1, referred: 1, by_category: { bids: 3, fees: 1 } } }));
    expect(t).toMatch(/Received 4 1 still open Answered on time 67% 2 of 3 answered Upheld 67% 1 fully, 1 partly, 1 not Taken further 1/);
    expect(t).toMatch(/Bids 3 Fees 1/);
  });

  it("shows targets as Ficium's own", () => {
    const t = text(view());
    expect(t).toMatch(/Complaint 48 hours 15 days/);
    expect(t).toContain("Ficium's own targets");
  });

  it("renders what people wrote as text, never markup", () => {
    expect(render(view({ open: [c({ detail: "<img src=x onerror=alert(1)>" })] }), c().id)).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
