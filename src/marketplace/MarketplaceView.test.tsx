import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketplaceView, liquidity, hours, mur, pct } from "./MarketplacePage";
import type { Loaded, Marketplace } from "./api";

const M: Marketplace = {
  generated_at: "2026-11-19T17:00:00Z", days: 30,
  funnel: { posted: 4, relisted: 1, with_bid: 2, accepted: 2, bank_declined: 1, bids_per_request_with_bid: 1.5, requested_amount: 5_700_000, accepted_amount: 700_000 },
  hours_to_first_bid: { median: 6, p90: 9.2 }, hours_to_acceptance: { median: 30, p90: 30 },
  status: { open: 2, accepted: 1, deal_declined: 1 },
  by_product: [{ product: "personal_loan", posted: 2, with_bid: 2, accepted: 2, requested_amount: 700_000 }],
  weekly: [{ week: "2026-11-09", posted: 1, with_bid: 1, accepted: 1 }, { week: "2026-11-16", posted: 2, with_bid: 0, accepted: 0 }],
  now: { open: 2, open_no_bid_24h: 1, oldest_no_bid_hours: 72 },
};
const state = (m: Partial<Marketplace> = {}): Loaded => ({ actor: "kj@ficium.net", marketplace: { ...M, ...m } });
const render = (s: Loaded) => renderToStaticMarkup(<MarketplaceView state={s} days={30} busy={false} error="" onDays={() => undefined} />);
const text = (s: Loaded) => render(s).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("Marketplace page", () => {
  it("leads with requests still waiting for a first bid", () => {
    expect(text(state())).toContain("Right now. 1 open request has had no bid for over 24 hours. The oldest has waited 3 days.");
    expect(liquidity({ ...M, now: { open: 3, open_no_bid_24h: 0, oldest_no_bid_hours: null } }))
      .toEqual({ tone: "ok", text: "3 open requests, and every one older than a day has a bid." });
    expect(liquidity({ ...M, now: { open: 0, open_no_bid_24h: 0, oldest_no_bid_hours: null } }).text).toBe("No requests are open right now.");
    expect(liquidity({ ...M, now: { open: 5, open_no_bid_24h: 3, oldest_no_bid_hours: 30 } }).tone).toBe("danger");
  });

  it("shows the funnel, the speed and the money", () => {
    const t = text(state());
    expect(t).toMatch(/Posted 4 1 of them relisted Got at least one bid 2 50% of posted Accepted by the borrower 2 50% of posted/);
    expect(t).toContain("The bank declined 1 of the 2 accepted (50%) after seeing who the borrower was.");
    expect(t).toMatch(/Time to first bid 6 h median; 9 in 10 within 9\.2 h/);
    expect(t).toMatch(/Amount accepted MUR 700k of MUR 5\.7m requested/);
    expect(t).toMatch(/Personal loan 2 2 \(100%\) 2 MUR 700k/);
    expect(t).toMatch(/Accepted, then declined by the bank 1/);
  });

  it("says so plainly when nothing was posted", () => {
    const t = text(state({ funnel: { ...M.funnel, posted: 0 }, now: { open: 0, open_no_bid_24h: 0, oldest_no_bid_hours: null } }));
    expect(t).toContain("No requests were posted in the last 30 days.");
    expect(t).not.toContain("By product");
  });

  it("marks the chosen period and gives every week bar its numbers in words", () => {
    const html = render(state());
    expect(html).toMatch(/aria-pressed="true"[^>]*>30 days/);
    expect(html).toContain('aria-label="Week of 16 Nov: 2 posted, 0 got a bid, 0 accepted"');
    expect(html).toContain("Show as a table");
  });

  it("formats time and money for people", () => {
    expect([hours(0.2), hours(6), hours(30), hours(72), hours(null)]).toEqual(["12 min", "6 h", "30 h", "3 days", "—"]);
    expect([mur(450_000), mur(5_700_000), mur(900)]).toEqual(["MUR 450k", "MUR 5.7m", "MUR 900"]);
    expect(pct(1, 0)).toBe("—");
  });
});
