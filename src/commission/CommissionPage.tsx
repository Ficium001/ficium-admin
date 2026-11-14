import { useEffect, useState } from "react";
import { claims } from "../auth/client";
import { load, ask, approve, reject, withdraw, pct, scope, statement, statementCsv, type View, type Rule, type ChangeRequest, type Statement } from "./api";
import ChangeTable from "../shared/ChangeTable";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { dateStyle: "medium" });
/** Today in Mauritius (UTC+4), the calendar the portal checks dates against. */
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);
const describe = (r: ChangeRequest) =>
  r.op === "commission.set"
    ? `${r.target_label}: ${pct(String(r.args.rate))} from ${day(String(r.args.effective_from))}`
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
        What Ficium charges a bank on each booked deal. The most specific rule wins: bank and product, then bank,
        then product, then the platform default. Changes apply from their start date, never backwards, and need a second admin.
        Banks without the deals module have no bookings, so they are never charged.
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
                <h2>{scope(r)}<span className="tag">{pct(r.rate)}</span></h2>
                <p>{r.in_force ? "In force" : "Starts"} {day(r.effective_from)} · on the booked amount{isDefault(r) ? " · platform default" : ""}</p>
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
            <li key={r.rule_id}><p><strong>{scope(r)}</strong>: {pct(r.rate)} from {day(r.effective_from)} until {day(r.ended_on!)}</p>
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

function SetForm({ view, onCancel, onDone }: { view: View; onCancel: () => void; onDone: () => void }) {
  const [bank, setBank] = useState("");
  const [product, setProduct] = useState("");
  const [rate, setRate] = useState("");
  const [from, setFrom] = useState(today());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const bankName = view.institutions.find((b) => b.institution_id === bank)?.name ?? "";
  const productName = view.products.find((p) => p.product_code === product)?.name ?? "";
  const current = view.rules.find((r) => !r.ended_on && (r.institution_id ?? "") === bank && (r.product_code ?? "") === product);
  const valid = /^\d{1,2}(\.\d{1,2})?$/.test(rate) && Number(rate) <= 5 && reason.trim().length >= 10 && from >= today();
  return (
    <form className="confirm" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr("");
      try {
        await ask({ op: "commission.set", institution_id: bank, institution_name: bankName, product_code: product,
          product_name: productName, rate_percent: rate, effective_from: from, reason: reason.trim() });
        onDone();
      } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      <label htmlFor="c-bank">Bank</label>
      <select id="c-bank" value={bank} onChange={(e) => setBank(e.target.value)}>
        <option value="">All banks</option>
        {view.institutions.map((b) => <option key={b.institution_id} value={b.institution_id}>{b.name}</option>)}
      </select>
      <label htmlFor="c-product">Product</label>
      <select id="c-product" value={product} onChange={(e) => setProduct(e.target.value)}>
        <option value="">All products</option>
        {view.products.map((p) => <option key={p.product_code} value={p.product_code}>{p.name}</option>)}
      </select>
      <label htmlFor="c-rate">Rate (% of the booked amount, max 5)</label>
      <input id="c-rate" inputMode="decimal" placeholder="0.45" value={rate} onChange={(e) => setRate(e.target.value.trim())} />
      <label htmlFor="c-from">From</label>
      <input id="c-from" type="date" value={from} min={today()} onChange={(e) => setFrom(e.target.value)} />
      {current && <p className="consequence">This replaces {pct(current.rate)} for {scope(current)} from that date. Deals booked before it keep the old rate.</p>}
      <label htmlFor="c-reason">Why?</label>
      <textarea id="c-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="hint">A second admin must approve this before it takes effect.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="actions">
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !valid}>{busy ? "Sending…" : "Send for approval"}</button>
      </div>
    </form>
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
      <p className="muted">Commission on the deals a bank booked in a month, exactly as each booking recorded it.</p>
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
      {st && (st.lines.length === 0 ? <p className="muted">No deals booked by {st.institution.name} in {st.month}.</p> : (
        <>
          <table className="table">
            <thead><tr><th>Booked</th><th>Product</th><th className="num">Deal</th><th className="num">Rate</th><th className="num">Commission</th><th>Status</th><th>Invoice</th></tr></thead>
            <tbody>{st.lines.map((l) => (
              <tr key={l.commission_id}>
                <td>{day(l.booked_on)}</td><td>{l.product_name ?? l.product_code ?? "?"}</td>
                <td className="num">{money(l.deal_amount, l.currency)}</td><td className="num">{pct(l.commission_rate)}</td>
                <td className="num">{money(l.commission_amt, l.currency)}</td><td>{l.status}</td><td>{l.invoice_ref ?? "—"}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><th colSpan={4}>Total, {st.totals.deals} deal{st.totals.deals === 1 ? "" : "s"}</th><th className="num">{money(st.totals.commission, cur)}</th><th colSpan={2} /></tr></tfoot>
          </table>
          <p className="hint">{Object.entries(st.totals.by_status).map(([k, v]) => `${k} ${money(v, cur)}`).join(" · ")}</p>
        </>
      ))}
    </section>
  );
}
