/**
 * Marketplace (app site): is the marketplace working? Requests posted, how many got a bid and how
 * fast, how many became deals, and which open requests are still waiting for a first bid.
 * The borrower app counts; this page only shows totals (no borrower, request or bank is named).
 */
import { useEffect, useState } from "react";
import { load, type Days, type Loaded, type Marketplace, type Spread, type Week } from "./api";

export const WINDOWS: { days: Days; label: string }[] = [
  { days: 7, label: "7 days" }, { days: 30, label: "30 days" }, { days: 90, label: "90 days" }, { days: 365, label: "12 months" },
];
export const STATUS_LABEL: Record<string, string> = {
  open: "Open, taking bids", awaiting_consent: "Waiting for a co-borrower to agree", accepted: "Accepted",
  deal_declined: "Accepted, then declined by the bank", expired: "Expired without a deal",
  rejected: "Bids turned down by the borrower", closed: "Cancelled by the borrower",
};
const STATUS_ORDER = ["open", "awaiting_consent", "accepted", "deal_declined", "expired", "rejected", "closed"];

const int = (n: number) => n.toLocaleString("en-GB");
export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
export function hours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h * 10) / 10} h`;
  return `${Math.round(h / 24 * 10) / 10} days`;
}
export function mur(n: number): string {
  if (n >= 1_000_000) return `MUR ${(n / 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 1 })}m`;
  if (n >= 1_000) return `MUR ${Math.round(n / 1_000).toLocaleString("en-GB")}k`;
  return `MUR ${int(n)}`;
}
const product = (p: string) => (p ? p.charAt(0).toUpperCase() + p.slice(1).replace(/_/g, " ") : "Unknown");
const WEEK = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const weekOf = (iso: string) => WEEK.format(new Date(`${iso}T00:00:00Z`));

/** The one line that matters most right now: requests nobody has bid on. */
export function liquidity(m: Marketplace): { text: string; tone: "ok" | "warn" | "danger" | "" } {
  const { open, open_no_bid_24h: waiting, oldest_no_bid_hours: oldest } = m.now;
  if (waiting > 0) {
    return { tone: waiting >= 3 || (oldest ?? 0) >= 72 ? "danger" : "warn",
      text: `${int(waiting)} open request${waiting === 1 ? " has" : "s have"} had no bid for over 24 hours. The oldest has waited ${hours(oldest)}.` };
  }
  if (open > 0) return { tone: "ok", text: `${int(open)} open request${open === 1 ? "" : "s"}, and every one older than a day has a bid.` };
  return { tone: "", text: "No requests are open right now." };
}

export default function MarketplacePage() {
  const [days, setDays] = useState<Days>(30);
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let live = true;
    setBusy(true);
    load(days).then((s) => { if (live) { setState(s); setError(""); } })
      .catch((e) => { if (live) setError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [days]);
  if (error && !state) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!state) return <main className="shell wide"><p className="muted">Counting requests and bids…</p></main>;
  return <MarketplaceView state={state} days={days} busy={busy} error={error} onDays={setDays} />;
}

/** The page for a loaded state. No data access of its own, so it can be rendered and checked directly. */
export function MarketplaceView({ state, days, busy, error, onDays }: {
  state: Loaded; days: Days; busy: boolean; error: string; onDays: (d: Days) => void;
}) {
  const m = state.marketplace;
  const f = m.funnel;
  const now = liquidity(m);
  const label = WINDOWS.find((w) => w.days === days)?.label ?? `${days} days`;
  return (
    <main className="shell wide" aria-busy={busy}>
      <header className="top">
        <h1>Marketplace</h1>
        <p className="who">Signed in as {state.actor}</p>
      </header>
      <p className="lead">
        Whether borrowers' requests get bids, how fast, and how many become deals. Counted by the borrower app: totals
        only, no borrower or bank is named.
      </p>

      <section className={`status ${now.tone}`} role={now.tone === "danger" ? "alert" : "status"}>
        <p><strong>Right now.</strong> {now.text}</p>
      </section>

      <div className="segmented" role="group" aria-label="Period">
        {WINDOWS.map((w) => (
          <button key={w.days} type="button" className="ghost" aria-pressed={w.days === days} disabled={busy && w.days !== days}
            onClick={() => onDays(w.days)}>{w.label}</button>
        ))}
      </div>
      {error && <p className="err" role="alert">{error}</p>}

      {f.posted === 0
        ? <p className="muted">No requests were posted in the last {label}.</p>
        : <>
          <h2 className="group">Requests posted in the last {label}</h2>
          <ol className="funnel" aria-label="From request to deal">
            <Step label="Posted" n={f.posted} of={f.posted} note={f.relisted ? `${int(f.relisted)} of them relisted` : ""} />
            <Step label="Got at least one bid" n={f.with_bid} of={f.posted} note={pct(f.with_bid, f.posted) + " of posted"} />
            <Step label="Accepted by the borrower" n={f.accepted} of={f.posted} note={pct(f.accepted, f.posted) + " of posted"} />
          </ol>
          {f.accepted > 0 && (
            <p className="hint">
              The bank declined {int(f.bank_declined)} of the {int(f.accepted)} accepted ({pct(f.bank_declined, f.accepted)}) after
              seeing who the borrower was.
            </p>
          )}

          <dl className="stat-row">
            <Figure term="Time to first bid" value={hours(m.hours_to_first_bid.median)} sub={spread(m.hours_to_first_bid)} />
            <Figure term="Time to acceptance" value={hours(m.hours_to_acceptance.median)} sub={spread(m.hours_to_acceptance)} />
            <Figure term="Bids per request" value={f.bids_per_request_with_bid == null ? "—" : String(f.bids_per_request_with_bid)} sub="among requests that got any" />
            <Figure term="Amount accepted" value={mur(f.accepted_amount)} sub={`of ${mur(f.requested_amount)} requested`} />
          </dl>

          <Weekly weeks={m.weekly} />

          <h2 className="group">By product</h2>
          <table className="table">
            <caption className="sr-only">Requests by product</caption>
            <thead><tr><th scope="col">Product</th><th scope="col" className="num">Posted</th><th scope="col" className="num">Got a bid</th>
              <th scope="col" className="num">Accepted</th><th scope="col" className="num">Requested</th></tr></thead>
            <tbody>{m.by_product.map((p) => (
              <tr key={p.product}>
                <th scope="row">{product(p.product)}</th>
                <td className="num">{int(p.posted)}</td>
                <td className="num">{int(p.with_bid)} <span className="muted">({pct(p.with_bid, p.posted)})</span></td>
                <td className="num">{int(p.accepted)}</td>
                <td className="num">{mur(p.requested_amount)}</td>
              </tr>
            ))}</tbody>
          </table>

          <h2 className="group">Where they are now</h2>
          <table className="table">
            <caption className="sr-only">Requests by current status</caption>
            <tbody>{STATUS_ORDER.filter((s) => m.status[s]).map((s) => (
              <tr key={s}><th scope="row">{STATUS_LABEL[s]}</th><td className="num">{int(m.status[s]!)}</td></tr>
            ))}</tbody>
          </table>
        </>}
      <p className="hint">
        A bid counts once it reaches the borrower app, even if the bank later withdraws it. Times run from when the request
        was posted. Counted at {m.generated_at ? new Date(m.generated_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"}.
      </p>
    </main>
  );
}

const spread = (s: Spread) => (s.p90 == null ? "median" : `median; 9 in 10 within ${hours(s.p90)}`);

function Step({ label, n, of, note }: { label: string; n: number; of: number; note: string }) {
  const w = of > 0 ? Math.max(n > 0 ? 2 : 0, Math.round((n / of) * 100)) : 0;
  return (
    <li>
      <span className="funnel-label">{label}</span>
      <span className="funnel-bar" aria-hidden="true"><span style={{ width: `${w}%` }} /></span>
      <span className="funnel-n">{int(n)}</span>
      <span className="muted funnel-note">{note}</span>
    </li>
  );
}

function Figure({ term, value, sub }: { term: string; value: string; sub: string }) {
  return <div><dt>{term}</dt><dd><strong>{value}</strong><span className="muted">{sub}</span></dd></div>;
}

/** Requests posted per week: one series, so no legend; each bar says its numbers on hover and to screen readers. */
function Weekly({ weeks }: { weeks: Week[] }) {
  if (weeks.length < 2) return null;
  const max = Math.max(1, ...weeks.map((w) => w.posted));
  const say = (w: Week) => `Week of ${weekOf(w.week)}: ${int(w.posted)} posted, ${int(w.with_bid)} got a bid, ${int(w.accepted)} accepted`;
  return (
    <section aria-labelledby="mkt-weekly">
      <h2 className="group" id="mkt-weekly">Requests posted each week</h2>
      <div className="weekly" role="list">
        {weeks.map((w) => (
          <div key={w.week} className="weekly-col" role="listitem" title={say(w)} aria-label={say(w)} tabIndex={0}>
            <span className="weekly-bar" style={{ height: `${Math.round((w.posted / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="weekly-axis" aria-hidden="true"><span>{weekOf(weeks[0]!.week)}</span><span>max {int(max)} a week</span><span>{weekOf(weeks[weeks.length - 1]!.week)}</span></div>
      <details>
        <summary>Show as a table</summary>
        <table className="table">
          <caption className="sr-only">Requests per week</caption>
          <thead><tr><th scope="col">Week of</th><th scope="col" className="num">Posted</th><th scope="col" className="num">Got a bid</th><th scope="col" className="num">Accepted</th></tr></thead>
          <tbody>{weeks.map((w) => (
            <tr key={w.week}><th scope="row">{weekOf(w.week)}</th><td className="num">{int(w.posted)}</td><td className="num">{int(w.with_bid)}</td><td className="num">{int(w.accepted)}</td></tr>
          ))}</tbody>
        </table>
      </details>
    </section>
  );
}
