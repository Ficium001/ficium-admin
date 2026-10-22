import { useEffect, useState } from "react";
import { CATEGORIES, PRODUCT_TYPES, LIMITS, MIN_REASON, VERIFY_DAYS, type OfferInput } from "../../api/_lib/offers";
import {
  listOffers, offerHistory, saveOffer, approveOffer, publishOffer, withdrawOffer, reverifyOffer, uploadImage,
  type Offer, type Change,
} from "./api";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const toIso = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : "");
const today = () => new Date().toISOString().slice(0, 10);

function statusOf(o: Offer): { label: string; tone: "ok" | "warn" | "muted" | "danger" } {
  if (o.status === "published") return o.is_live ? { label: "Live", tone: "ok" } : { label: "Published · not live", tone: "danger" };
  if (o.status === "approved") return { label: "Approved · not published", tone: "warn" };
  if (o.status === "withdrawn") return { label: "Withdrawn", tone: "muted" };
  return { label: "Draft", tone: "muted" };
}

const EMPTY: OfferInput = {
  institution_name: "", category: "borrow", product_type: "leasing", caption: "", headline: "", terms: "",
  image_tag: null, image_url: null, image_alt: null, is_launch: false, launch_window_ends: null,
  expires_at: "", source_url: null, consent_ref: null, verified_at: null,
};

export default function OffersPage() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [actor, setActor] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Offer | "new" | null>(null);

  const refresh = () => listOffers().then((r) => { setOffers(r.offers); setActor(r.actor); setError(""); return r.offers; })
    .catch((e) => { setError(e.message); return [] as Offer[]; });
  useEffect(() => { refresh(); }, []);

  if (error && !offers) return <main className="shell"><p className="fatal" role="alert">{error}</p></main>;
  if (!offers) return <main className="shell"><p className="muted">Loading offers…</p></main>;

  if (open) {
    return <Editor key={open === "new" ? "new" : `${open.id}:${open.version}`} offer={open === "new" ? null : open}
      onClose={() => { setOpen(null); refresh(); }}
      onChanged={async (id) => { const list = await refresh(); setOpen(list.find((o) => o.id === id) ?? null); }} />;
  }

  return (
    <main className="shell">
      <header className="top">
        <h1>Offers</h1>
        <p className="who">Signed in as {actor}</p>
      </header>
      <p className="muted lead">Offers appear in the borrower app only after approval and publishing. A live offer drops out on its own when it expires or {VERIFY_DAYS} days after its rates were last verified.</p>
      <div className="actions left"><button className="primary" onClick={() => setOpen("new")}>New offer</button></div>
      {offers.length === 0
        ? <p className="muted empty">No offers yet.</p>
        : <ul className="board">{offers.map((o) => {
            const s = statusOf(o);
            return (
              <li key={o.id} className="offer-row">
                <button className="row-btn" onClick={() => setOpen(o)}>
                  <span className="text">
                    <span className="name">{o.institution_name} · {PRODUCT_TYPES.find((p) => p.value === o.product_type)?.label ?? o.product_type}</span>
                    <span className="sub">{o.headline} — {o.terms}</span>
                    <span className="sub">{o.status === "published" && o.live_until ? `Live until ${fmt(o.live_until)}` : `Updated ${fmt(o.updated_at)} by ${o.updated_by}`}</span>
                  </span>
                  <span className={`pill ${s.tone}`}>{s.label}</span>
                </button>
              </li>
            );
          })}</ul>}
    </main>
  );
}

function Editor({ offer, onClose, onChanged }: { offer: Offer | null; onClose: () => void; onChanged: (id: string) => Promise<void> }) {
  const [f, setF] = useState<OfferInput>(offer ? { ...offer } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const [history, setHistory] = useState<Change[]>([]);
  const set = <K extends keyof OfferInput>(k: K, v: OfferInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const products = PRODUCT_TYPES.filter((p) => p.category === f.category);

  useEffect(() => { if (offer) offerHistory(offer.id).then((r) => setHistory(r.history)).catch(() => setHistory([])); }, [offer]);

  const run = async (fn: () => Promise<{ offer: Offer }>) => {
    setBusy(true); setErr("");
    try { const r = await fn(); await onChanged(r.offer.id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true); setErr("");
    try { const r = await uploadImage(file); set("image_url", r.url); } catch (e) { setErr((e as Error).message); } finally { setUploading(false); }
  };

  const field = (k: keyof typeof LIMITS, label: string, area = false) => (
    <div className="fld">
      <label htmlFor={`f-${k}`}>{label}</label>
      {area
        ? <textarea id={`f-${k}`} rows={3} maxLength={LIMITS[k][1]} value={(f[k] as string | null) ?? ""} onChange={(e) => set(k, e.target.value)} />
        : <input id={`f-${k}`} maxLength={LIMITS[k][1]} value={(f[k] as string | null) ?? ""} onChange={(e) => set(k, e.target.value)} />}
      <span className="hint">{((f[k] as string | null) ?? "").length}/{LIMITS[k][1]}</span>
    </div>
  );

  const status = offer ? statusOf(offer) : null;

  return (
    <main className="shell">
      <header className="top">
        <h1>{offer ? "Edit offer" : "New offer"}</h1>
        <button className="ghost" onClick={onClose}>Back to offers</button>
      </header>
      {offer && <p className="meta">
        <span className={`pill ${status!.tone}`}>{status!.label}</span> Version {offer.version} · created by {offer.created_by}
        {offer.approved_by && <> · approved by {offer.approved_by}{offer.self_approved && <strong className="flag"> (self-approved)</strong>}</>}
      </p>}
      {offer?.status === "published" && <p className="status warn">Saving changes sends this offer back to draft. The current version stays live until you approve and publish again, or withdraw it.</p>}

      <form className="panel form" onSubmit={(e) => { e.preventDefault(); run(() => saveOffer(f, offer?.id, offer?.version)); }}>
        <h2>Offer</h2>
        {field("institution_name", "Provider name")}
        <div className="two">
          <div className="fld">
            <label htmlFor="f-category">Category</label>
            <select id="f-category" value={f.category} onChange={(e) => {
              const c = e.target.value as OfferInput["category"];
              setF((x) => ({ ...x, category: c, product_type: PRODUCT_TYPES.find((p) => p.category === c)!.value }));
            }}>{CATEGORIES.map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}</select>
          </div>
          <div className="fld">
            <label htmlFor="f-product">Product</label>
            <select id="f-product" value={f.product_type} onChange={(e) => set("product_type", e.target.value)}>
              {products.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        </div>
        {field("caption", "Caption (the post text)", true)}
        {field("headline", "Headline (e.g. From 6.25% p.a.)")}
        {field("terms", "Key terms (e.g. MUR 200k–2M · up to 7 years)")}

        <h2>Image</h2>
        <p className="hint">JPEG, PNG or WebP, 2 MB max, 4:3. No rates or text inside the image — rates live in the headline so they can be verified.</p>
        <div className="fld">
          <label htmlFor="f-image">Upload image</label>
          <input id="f-image" type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={(e) => onFile(e.target.files?.[0])} />
          {uploading && <span className="hint">Uploading…</span>}
        </div>
        {f.image_url && <img className="preview" src={f.image_url} alt={f.image_alt ?? "Offer image preview"} />}
        {field("image_alt", "Image description (for screen readers)")}
        {field("image_tag", "Image tag (optional, e.g. New vehicles only)")}

        <h2>Dates and launch</h2>
        <div className="two">
          <div className="fld">
            <label htmlFor="f-exp">Offer ends</label>
            <input id="f-exp" type="date" min={today()} value={day(f.expires_at)} onChange={(e) => set("expires_at", toIso(e.target.value))} />
          </div>
          <div className="fld">
            <label htmlFor="f-ver">Rates verified with provider on</label>
            <input id="f-ver" type="date" max={today()} value={day(f.verified_at)} onChange={(e) => set("verified_at", e.target.value ? new Date(`${e.target.value}T12:00:00`).toISOString() : null)} />
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={f.is_launch} onChange={(e) => set("is_launch", e.target.checked)} /> New product launch (shows a “New” badge; only this provider handles requests during the window)</label>
        {f.is_launch && <div className="fld">
          <label htmlFor="f-lw">Launch window ends</label>
          <input id="f-lw" type="date" min={today()} max={day(f.expires_at) || undefined} value={day(f.launch_window_ends)} onChange={(e) => set("launch_window_ends", toIso(e.target.value) || null)} />
        </div>}

        <h2>Evidence</h2>
        <div className="fld">
          <label htmlFor="f-src">Source link (provider’s page or rate sheet)</label>
          <input id="f-src" type="url" placeholder="https://" value={f.source_url ?? ""} onChange={(e) => set("source_url", e.target.value || null)} />
        </div>
        <div className="fld">
          <label htmlFor="f-consent">Provider consent reference (e.g. email date and sender)</label>
          <input id="f-consent" value={f.consent_ref ?? ""} onChange={(e) => set("consent_ref", e.target.value || null)} />
        </div>

        {err && <p className="err" role="alert">{err}</p>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || uploading || offer?.status === "withdrawn"}>{busy ? "Saving…" : offer ? "Save changes" : "Create draft"}</button>
        </div>
      </form>

      {offer && <Workflow offer={offer} busy={busy} run={run} />}

      {offer && <section className="history">
        <h2>Change history</h2>
        {history.length === 0 ? <p className="muted">No changes recorded.</p>
          : <ol>{history.map((h) => (
              <li key={h.id}>
                <p><strong>{h.action}</strong> by {h.actor}</p>
                {h.reason && <p className="reason">“{h.reason}”</p>}
                <time dateTime={h.changed_at}>{fmt(h.changed_at)}</time>
              </li>))}</ol>}
      </section>}
    </main>
  );
}

function Workflow({ offer, busy, run }: { offer: Offer; busy: boolean; run: (fn: () => Promise<{ offer: Offer }>) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [verified, setVerified] = useState(today());
  const ok = reason.trim().length >= MIN_REASON;
  const reasonBox = (label: string, ph: string) => (
    <div className="fld">
      <label htmlFor="w-reason">{label}</label>
      <textarea id="w-reason" rows={2} maxLength={500} value={reason} placeholder={ph} onChange={(e) => setReason(e.target.value)} />
      <span className="hint">{ok ? "Saved in the change history with your name." : `At least ${MIN_REASON} characters.`}</span>
    </div>
  );

  return (
    <section className="panel form">
      <h2>Review and publish</h2>
      {offer.status === "draft" && <>
        <p className="hint">Approval checks the image, source link, consent reference, expiry, and that rates were verified in the last {VERIFY_DAYS} days.</p>
        {reasonBox("What did you check?", "e.g. Rates and terms match the provider's sheet dated 21 Oct")}
        <div className="actions"><button className="primary" disabled={!ok || busy} onClick={() => run(() => approveOffer(offer.id, reason.trim()))}>Approve</button></div>
      </>}
      {offer.status === "approved" && <>
        <p className="hint">Publishing makes this offer visible to every signed-in borrower.</p>
        <div className="actions"><button className="primary" disabled={busy} onClick={() => run(() => publishOffer(offer.id))}>Publish to borrowers</button></div>
      </>}
      {offer.status === "published" && <>
        <div className="fld">
          <label htmlFor="w-ver">Rates re-verified with provider on</label>
          <input id="w-ver" type="date" max={today()} value={verified} onChange={(e) => setVerified(e.target.value)} />
        </div>
        {reasonBox("Reason", "e.g. Provider confirmed rates unchanged by email")}
        <div className="actions">
          <button className="ghost destructive-ghost" disabled={!ok || busy} onClick={() => run(() => withdrawOffer(offer.id, reason.trim()))}>Withdraw now</button>
          <button className="primary" disabled={!ok || busy} onClick={() => run(() => reverifyOffer(offer.id, new Date(`${verified}T12:00:00`).toISOString(), reason.trim()))}>Record re-verification</button>
        </div>
      </>}
      {offer.status === "withdrawn" && <p className="muted">Withdrawn {fmt(offer.withdrawn_at)} by {offer.withdrawn_by}. Withdrawn offers stay withdrawn; create a new offer to list it again.</p>}
    </section>
  );
}
