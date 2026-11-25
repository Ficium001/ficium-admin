import { useEffect, useState } from "react";
import { claims } from "../auth/client";
import { load, ask, approve, reject, withdraw, scope, statement, statementCsv, preview, working, type View, type Rule, type ChangeRequest, type Statement } from "./api";
import ChangeTable from "../shared/ChangeTable";
import {
  BASES, BASIS_LABEL, BASIS_HINT, RATED, describeModel, shortModel, modelFromForm, pct,
  type Basis, type FeeForm, type ModelLike,
} from "../../api/_lib/fee-model";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { dateStyle: "medium" });
/** Today in Mauritius (UTC+4), the calendar the portal checks dates against. */
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const describe = (r: ChangeRequest) =>
  r.op === "commission.set"
    ? `${r.target_label}: ${shortModel(r.args as ModelLike)} from ${day(String(r.args.effective_from))}`
    : `End ${r.target_label} from ${day(String(r.args.ended_on))}`;
const isDefault = (r: Rule) => !r.institution_id && !r.product_code;

export default function CommissionPage() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState<null | { kind: "set" } | { kind: "end"; rule: Rule }>(null);
  const me = claims()?.email?.toLowerCase() ?? "";
  const refresh = () => load().then((v) => { setView(v); setError(""); setForm(null); }).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  if (error && !view) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!view) return <main className="shell"><p className="muted">Loading the commission schedule…</p></main>;

  const pending = view.requests.filter((r) => r.status === "pending");
  const decided = view.requests.filter((r) => r.status !== "pending").slice(0, 30);
  const open = view.rules.filter((r) => !r.ended_on);
  const past = view.rules.filter((r) => r.ended_on);
  const waiting = (key: string) => pending.some((p) => p.target_key === key);

  return (
    <main className="shell">
      <header className="top"><h1>Commission</h1><p className="who">Signed in as {me}</p></header>
      <p className="lead muted">
        What Ficium charges a bank on each booked deal, and how it is worked out: a percentage of the amount, of the
        first year's money in, or per year of term, banded rates, or a fixed fee, with an optional minimum, maximum and
        clawback. The most specific rule wins: bank and product, then bank, then product, then the platform default.
        Changes apply from their start date, never backwards, and need a second admin. Banks without the deals module
        have no bookings, so they are never charged.
      </p>

      {pending.length > 0 && (
        <section className="history">
          <h2>Waiting for a second approver</h2>
          <ul className="board">{pending.map((r) => <Pending key={r.id} r={r} mine={r.maker_email.toLowerCase() === me} onDone={refresh} />)}</ul>
        </section>
      )}

      <section className="history">
        <h2>Current schedule</h2>
        <ul className="board">
          {open.map((r) => (
            <li key={r.rule_id} className={`breaker ${r.in_force ? "on" : "off"}`}>
              <div className="text">
                <h2>{scope(r)}<span className="tag">{shortModel(r)}</span></h2>
                <p>{describeModel(r)}</p>
                <p>{r.in_force ? "In force" : "Starts"} {day(r.effective_from)}{isDefault(r) ? " · platform default" : ""}</p>
                <p className="reason">“{r.reason}”</p>
              </div>
              {!isDefault(r) && (waiting(r.rule_id)
                ? <p className="hint">An end date is waiting for approval.</p>
                : <div className="actions left"><button className="ghost" onClick={() => setForm({ kind: "end", rule: r })}>Ask to end</button></div>)}
              {form?.kind === "end" && form.rule.rule_id === r.rule_id && <EndForm rule={r} onCancel={() => setForm(null)} onDone={refresh} />}
            </li>
          ))}
        </ul>
        {form?.kind === "set"
          ? <SetForm view={view} onCancel={() => setForm(null)} onDone={refresh} />
          : <div className="actions left"><button className="primary" onClick={() => setForm({ kind: "set" })}>Set a rate</button></div>}
      </section>

      {past.length > 0 && (
        <section className="history">
          <h2>Past rules</h2>
          <ol>{past.map((r) => (
            <li key={r.rule_id}><p><strong>{scope(r)}</strong>: {describeModel(r)}, from {day(r.effective_from)} until {day(r.ended_on!)}</p>
              <p className="reason">“{r.reason}”</p></li>))}
          </ol>
        </section>
      )}

      <StatementSection banks={view.institutions} />

      <section className="history">
        <h2>Decisions</h2>
        {decided.length === 0 ? <p className="muted">None yet. Every request and decision is logged with who made it and why.</p> : (
          <ol>{decided.map((r) => (
            <li key={r.id}>
              <p><strong>{describe(r)}</strong>: {r.status}{r.checker_email ? ` by ${r.checker_email}` : ""} (asked by {r.maker_email})</p>
              <p className="reason">“{r.decision_note ?? r.reason}”</p>
              <ChangeTable r={r} decided />
              {r.decided_at && <time dateTime={r.decided_at}>{fmt(r.decided_at)}</time>}
            </li>))}
          </ol>
        )}
      </section>
    </main>
  );
}

function Pending({ r, mine, onDone }: { r: ChangeRequest; mine: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(""); try { await fn(); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); } };
  return (
    <li className="breaker on">
      <div className="text">
        <h2>{describe(r)}</h2>
        <p>Asked by {r.maker_email} · {fmt(r.created_at)}</p>
        <p className="reason">“{r.reason}”</p>
        <ChangeTable r={r} />
      </div>
      <div className="confirm">
        {mine ? <p className="hint">You asked for this, so someone else must approve it.</p> : <>
          <label htmlFor={`n-${r.id}`}>Note (required to reject)</label>
          <textarea id={`n-${r.id}`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </>}
        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions">
          {mine ? <button className="ghost" disabled={busy} onClick={() => run(() => withdraw(r))}>Withdraw</button> : <>
            <button className="ghost" disabled={busy || note.trim().length < 10} onClick={() => run(() => reject(r, note.trim()))}>Reject</button>
            <button className="primary" disabled={busy} onClick={() => run(() => approve(r, note.trim()))}>{busy ? "Working…" : "Approve and apply"}</button>
          </>}
        </div>
      </div>
    </li>
  );
}

type TierRow = { up_to: string; rate_percent: string };
const NEW_TIERS: TierRow[] = [{ up_to: "100000", rate_percent: "" }, { up_to: "", rate_percent: "" }];

function SetForm({ view, onCancel, onDone }: { view: View; onCancel: () => void; onDone: () => void }) {
  const [bank, setBank] = useState("");
  const [product, setProduct] = useState("");
  const [basis, setBasis] = useState<Basis>("booked_amount");
  const [rate, setRate] = useState("");
  const [months, setMonths] = useState("12");
  const [lump, setLump] = useState("100");
  const [maxYears, setMaxYears] = useState("5");
  const [tierMode, setTierMode] = useState("marginal");
  const [tiers, setTiers] = useState<TierRow[]>(NEW_TIERS);
  const [flat, setFlat] = useState("");
  const [minFee, setMinFee] = useState("");
  const [maxFee, setMaxFee] = useState("");
  const [claw, setClaw] = useState("0");
  const [clawMode, setClawMode] = useState("pro_rata");
  const [from, setFrom] = useState(today());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bankName = view.institutions.find((b) => b.institution_id === bank)?.name ?? "";
  const productName = view.products.find((p) => p.product_code === product)?.name ?? "";
  const current = view.rules.find((r) => !r.ended_on && (r.institution_id ?? "") === bank && (r.product_code ?? "") === product);

  const fee: FeeForm = {
    basis, rate_percent: rate, months, lump_percent: lump, max_years: maxYears, tier_mode: tierMode, tiers,
    flat_amount: flat, min_fee: minFee, max_fee: maxFee, clawback_months: claw, clawback_mode: clawMode,
  };
  let problem = "";
  let model: ModelLike | null = null;
  try { model = modelFromForm(fee); } catch (e) { problem = (e as Error).message; }
  const valid = !problem && reason.trim().length >= 10 && from >= today();
  const setTier = (i: number, k: keyof TierRow, v: string) => setTiers(tiers.map((t, j) => (j === i ? { ...t, [k]: v.trim() } : t)));

  return (
    <form className="confirm" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try {
        await ask({ op: "commission.set", institution_id: bank, institution_name: bankName, product_code: product,
          product_name: productName, ...fee, effective_from: from, reason: reason.trim() });
        onDone();
      } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      <div className="two">
        <div className="fld"><label htmlFor="c-bank">Bank</label>
          <select id="c-bank" value={bank} onChange={(e) => setBank(e.target.value)}>
            <option value="">All banks</option>
            {view.institutions.map((b) => <option key={b.institution_id} value={b.institution_id}>{b.name}</option>)}
          </select></div>
        <div className="fld"><label htmlFor="c-product">Product</label>
          <select id="c-product" value={product} onChange={(e) => setProduct(e.target.value)}>
            <option value="">All products</option>
            {view.products.map((p) => <option key={p.product_code} value={p.product_code}>{p.name}</option>)}
          </select></div>
      </div>

      <div className="fld"><label htmlFor="c-basis">How the fee is worked out</label>
        <select id="c-basis" value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
          {BASES.map((b) => <option key={b} value={b}>{BASIS_LABEL[b]}</option>)}
        </select>
        <p className="hint">{BASIS_HINT[basis]}</p>
      </div>

      <div className="two">
        {RATED.includes(basis) && (
          <div className="fld"><label htmlFor="c-rate">{basis === "amount_x_term" ? "Rate per year (%, max 5)" : "Rate (%, max 5)"}</label>
            <input id="c-rate" inputMode="decimal" placeholder="0.45" value={rate} onChange={(e) => setRate(e.target.value.trim())} /></div>
        )}
        {basis === "annualised" && <>
          <div className="fld"><label htmlFor="c-months">Months of contributions counted</label>
            <input id="c-months" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.trim())} /></div>
          <div className="fld"><label htmlFor="c-lump">Share of the first amount counted (%)</label>
            <input id="c-lump" inputMode="numeric" value={lump} onChange={(e) => setLump(e.target.value.trim())} /></div>
        </>}
        {basis === "amount_x_term" && (
          <div className="fld"><label htmlFor="c-years">Most years charged</label>
            <input id="c-years" inputMode="numeric" value={maxYears} onChange={(e) => setMaxYears(e.target.value.trim())} /></div>
        )}
        {basis === "flat" && (
          <div className="fld"><label htmlFor="c-flat">Fixed fee (MUR)</label>
            <input id="c-flat" inputMode="decimal" placeholder="350" value={flat} onChange={(e) => setFlat(e.target.value.trim())} /></div>
        )}
      </div>

      {basis === "tiered" && (
        <fieldset className="fld">
          <legend>Bands</legend>
          <div className="segmented" role="group" aria-label="Band mode">
            <button type="button" className="ghost" aria-pressed={tierMode === "marginal"} onClick={() => setTierMode("marginal")}>Each band at its rate</button>
            <button type="button" className="ghost" aria-pressed={tierMode === "whole"} onClick={() => setTierMode("whole")}>Whole amount at one rate</button>
          </div>
          {tiers.map((t, i) => {
            const last = i === tiers.length - 1;
            return (
              <div className="two" key={i}>
                <div className="fld"><label htmlFor={`t-up-${i}`}>{last ? "Above the last limit" : `Band ${i + 1} up to (MUR)`}</label>
                  <input id={`t-up-${i}`} inputMode="decimal" disabled={last} placeholder={last ? "No limit" : "100000"}
                    value={last ? "" : t.up_to} onChange={(e) => setTier(i, "up_to", e.target.value)} /></div>
                <div className="fld"><label htmlFor={`t-rate-${i}`}>Rate (%)</label>
                  <input id={`t-rate-${i}`} inputMode="decimal" placeholder="0.5" value={t.rate_percent}
                    onChange={(e) => setTier(i, "rate_percent", e.target.value)} /></div>
              </div>
            );
          })}
          <div className="actions left">
            {tiers.length < 10 && <button type="button" className="ghost inline" onClick={() =>
              setTiers([...tiers.slice(0, -1), { up_to: "", rate_percent: "" }, tiers[tiers.length - 1]!])}>Add a band</button>}
            {tiers.length > 1 && <button type="button" className="ghost inline" onClick={() =>
              setTiers([...tiers.slice(0, -2), tiers[tiers.length - 1]!])}>Remove a band</button>}
          </div>
        </fieldset>
      )}

      {basis !== "flat" && (
        <div className="two">
          <div className="fld"><label htmlFor="c-min">Minimum fee (MUR, optional)</label>
            <input id="c-min" inputMode="decimal" placeholder="250" value={minFee} onChange={(e) => setMinFee(e.target.value.trim())} /></div>
          <div className="fld"><label htmlFor="c-max">Maximum fee (MUR, optional)</label>
            <input id="c-max" inputMode="decimal" value={maxFee} onChange={(e) => setMaxFee(e.target.value.trim())} /></div>
        </div>
      )}

      <div className="two">
        <div className="fld"><label htmlFor="c-claw">Clawback window (months, 0 for none)</label>
          <input id="c-claw" inputMode="numeric" value={claw} onChange={(e) => setClaw(e.target.value.trim())} /></div>
        {claw !== "" && claw !== "0" && (
          <div className="fld"><label htmlFor="c-clawmode">If the account closes inside it</label>
            <select id="c-clawmode" value={clawMode} onChange={(e) => setClawMode(e.target.value)}>
              <option value="pro_rata">Refund the unearned share</option>
              <option value="full">Refund the whole fee</option>
            </select></div>
        )}
      </div>

      {model && <p className="consequence"><strong>{describeModel(model)}</strong></p>}
      {problem && <p className="hint">{problem}</p>}
      <PreviewBox fee={fee} basis={basis} ready={!problem} />

      <div className="fld"><label htmlFor="c-from">From</label>
        <input id="c-from" type="date" value={from} min={today()} onChange={(e) => setFrom(e.target.value)} /></div>
      {current && <p className="consequence">This replaces “{describeModel(current)}” for {scope(current)} from that date. Deals booked before it keep the old fee.</p>}
      <div className="fld"><label htmlFor="c-reason">Why?</label>
        <textarea id="c-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <p className="hint">A second admin must approve this before it takes effect.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !valid}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </form>
  );
}

/** Try the model on an example deal. The Portal DB does the sum, with the same function the booking uses. */
function PreviewBox({ fee, basis, ready }: { fee: FeeForm; basis: Basis; ready: boolean }) {
  const [amount, setAmount] = useState("1000");
  const [monthly, setMonthly] = useState("500");
  const [term, setTerm] = useState("12");
  const [calc, setCalc] = useState<Awaited<ReturnType<typeof preview>>["calc"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true); setErr("");
    try {
      const out = await preview(fee, { amount, ...(basis === "annualised" ? { monthly_amount: monthly } : {}),
        ...(basis === "amount_x_term" ? { term_months: term } : {}) });
      setCalc(out.calc);
    } catch (e) { setErr((e as Error).message); setCalc(null); } finally { setBusy(false); }
  };
  return (
    <fieldset className="fld">
      <legend>Try it on an example deal</legend>
      <div className="two">
        <div className="fld"><label htmlFor="p-amount">{basis === "annualised" ? "First amount (MUR)" : "Booked amount (MUR)"}</label>
          <input id="p-amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setCalc(null); }} /></div>
        {basis === "annualised" && <div className="fld"><label htmlFor="p-monthly">Monthly amount (MUR)</label>
          <input id="p-monthly" inputMode="decimal" value={monthly} onChange={(e) => { setMonthly(e.target.value.trim()); setCalc(null); }} /></div>}
        {basis === "amount_x_term" && <div className="fld"><label htmlFor="p-term">Term (months)</label>
          <input id="p-term" inputMode="numeric" value={term} onChange={(e) => { setTerm(e.target.value.trim()); setCalc(null); }} /></div>}
      </div>
      <div className="actions left"><button type="button" className="ghost" disabled={busy || !ready} onClick={run}>{busy ? "Working…" : "Work out the fee"}</button></div>
      {err && <p className="err" role="alert">{err}</p>}
      {calc && <p className="consequence">{working(calc)}</p>}
    </fieldset>
  );
}

function EndForm({ rule, onCancel, onDone }: { rule: Rule; onCancel: () => void; onDone: () => void }) {
  const [until, setUntil] = useState(today());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <form className="confirm grave" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try { await ask({ op: "commission.end", rule_id: rule.rule_id, label: scope(rule), ended_on: until, reason: reason.trim() }); onDone(); }
      catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      <p className="consequence">From that date, {scope(rule)} falls back to the next broader rule.</p>
      <label htmlFor="e-until">Last day is the day before</label>
      <input id="e-until" type="date" value={until} min={today()} onChange={(e) => setUntil(e.target.value)} />
      <label htmlFor="e-reason">Why?</label>
      <textarea id="e-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary destructive" disabled={busy || reason.trim().length < 10}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </form>
  );
}

const thisMonth = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 7);
const money = (v: string | number, cur = "MUR") =>
  `${cur} ${Number(v).toLocaleString("en-MU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatementSection({ banks }: { banks: View["institutions"] }) {
  const [bank, setBank] = useState(banks[0]?.institution_id ?? "");
  const [month, setMonth] = useState(thisMonth());
  const [st, setSt] = useState<Statement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const show = async () => {
    setBusy(true); setErr("");
    try { setSt(await statement(bank, month)); } catch (e) { setErr((e as Error).message); setSt(null); } finally { setBusy(false); }
  };
  const download = () => {
    if (!st) return;
    const url = URL.createObjectURL(new Blob([statementCsv(st)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `ficium-commission-${st.institution.name.replace(/[^A-Za-z0-9]+/g, "-")}-${st.month}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };
  const cur = st?.totals.currencies[0] ?? "MUR";
  return (
    <section className="history">
      <h2>Statement</h2>
      <p className="muted">Commission on the deals a bank booked in a month, exactly as each booking recorded it, and any clawback credits for accounts that closed that month.</p>
      <div className="actions left">
        <label htmlFor="st-bank" className="sr-only">Bank</label>
        <select id="st-bank" value={bank} onChange={(e) => { setBank(e.target.value); setSt(null); }}>
          {banks.length === 0 && <option value="">No banks yet</option>}
          {banks.map((b) => <option key={b.institution_id} value={b.institution_id}>{b.name}</option>)}
        </select>
        <label htmlFor="st-month" className="sr-only">Month</label>
        <input id="st-month" type="month" value={month} max={thisMonth()} onChange={(e) => { setMonth(e.target.value); setSt(null); }} />
        <button className="primary" disabled={busy || !bank || !month} onClick={show}>{busy ? "Loading…" : "Show statement"}</button>
        {st && <button className="ghost" onClick={download}>Download CSV</button>}
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      {st && (st.lines.length === 0 && (st.adjustments ?? []).length === 0 ? <p className="muted">No deals booked by {st.institution.name} in {st.month}.</p> : (
        <>
          <table className="table">
            <thead><tr><th>Date</th><th>Product</th><th className="num">Deal</th><th>Fee</th><th className="num">Commission</th><th>Status</th><th>Invoice</th></tr></thead>
            <tbody>{st.lines.map((l) => (
              <tr key={l.commission_id}>
                <td>{day(l.booked_on)}</td><td>{l.product_name ?? l.product_code ?? "?"}</td>
                <td className="num">{money(l.deal_amount, l.currency)}</td>
                <td title={l.calc ? working(l.calc) : undefined}>{l.calc ? shortModel(l.calc) : pct(l.commission_rate)}
                  {l.calc?.floor_applied ? " (minimum)" : l.calc?.cap_applied ? " (maximum)" : ""}</td>
                <td className="num">{money(l.commission_amt, l.currency)}</td><td>{l.status}</td><td>{l.invoice_ref ?? "—"}</td>
              </tr>
            ))}
            {(st.adjustments ?? []).map((a) => (
              <tr key={a.adjustment_id}>
                <td>{day(a.effective_on)}</td><td>{a.product_name ?? a.product_code ?? "?"}</td><td className="num">—</td>
                <td>Clawback{a.calc?.mode === "pro_rata" && a.calc.share != null ? `, ${Math.round(a.calc.share * 100)}% of the fee` : ""}</td>
                <td className="num">{money(a.amount, a.currency)}</td><td>credit</td><td>—</td>
              </tr>
            ))}</tbody>
            <tfoot>
              <tr><th colSpan={4}>Total, {st.totals.deals} deal{st.totals.deals === 1 ? "" : "s"}</th><th className="num">{money(st.totals.commission, cur)}</th><th colSpan={2} /></tr>
              {(st.adjustments ?? []).length > 0 && <>
                <tr><th colSpan={4}>Clawbacks</th><th className="num">{money(st.totals.adjustments ?? 0, cur)}</th><th colSpan={2} /></tr>
                <tr><th colSpan={4}>Net</th><th className="num">{money(st.totals.net ?? st.totals.commission, cur)}</th><th colSpan={2} /></tr>
              </>}
            </tfoot>
          </table>
          <p className="hint">{Object.entries(st.totals.by_status).map(([k, v]) => `${k} ${money(v, cur)}`).join(" · ")}</p>
        </>
      ))}
    </section>
  );
}
