/**
 * Services (both sites): every service this site depends on, whether it is answering right now,
 * and a Test button for each.
 *
 * The API traffic page shows what flowed in the last 24 hours. This page answers the other half:
 * is it up now, including a service nobody has called today. Each test is fixed on the server and
 * read-only, so it can be run at any time; the page sends a service's name, never an address.
 */
import { useEffect, useState } from "react";
import { load, test, type Loaded, type Result, type Service, type Status } from "./api";

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const millis = (n: number | null) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

export const STATUS: Record<Status, { text: string; pill: "" | "ok" | "warn" | "danger" }> = {
  up: { text: "Running", pill: "ok" },
  slow: { text: "Slow", pill: "warn" },
  attention: { text: "Needs attention", pill: "warn" },
  down: { text: "Broken", pill: "danger" },
  not_configured: { text: "Not set up", pill: "warn" },
  unknown: { text: "Unknown", pill: "" },
};

/** One line for the top of the page: worst first. */
export function summary(results: Result[]): { text: string; pill: "" | "ok" | "warn" | "danger" } {
  const down = results.filter((r) => r.status === "down").length;
  const warn = results.filter((r) => r.status === "slow" || r.status === "attention" || r.status === "not_configured").length;
  if (down) return { text: `${down} service${down === 1 ? " is" : "s are"} broken`, pill: "danger" };
  if (warn) return { text: `${warn} service${warn === 1 ? " needs" : "s need"} attention`, pill: "warn" };
  if (results.length && results.every((r) => r.status === "up")) return { text: "Everything is running", pill: "ok" };
  return { text: "Some services could not be judged", pill: "" };
}

export default function ServicesPage() {
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setBusy("all");
    try { setState(await load()); setError(""); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  useEffect(() => { void refresh(); }, []);

  if (error && !state) return <main className="shell wide"><p className="fatal" role="alert">{error}</p></main>;
  if (!state) return <main className="shell wide"><p className="muted">Testing services…</p></main>;

  const onTest = async (key: string) => {
    setBusy(key);
    try {
      const fresh = await test(key);
      const one = fresh.results[0];
      if (one) setState({ ...state, results: state.results.map((r) => (r.key === key ? one : r)) });
      setError("");
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return <ServicesView state={state} busy={busy} error={error} onTest={onTest} onTestAll={refresh} />;
}

/** Deploy rows (latest production build per project) are shown apart from the live tests. */
export const isDeploy = (key: string) => key.startsWith("deploy_");
/** Only ever a link the server allowed (Vercel or Railway, https); checked again here. */
const safeLink = (u: string | undefined) => (u && /^https:\/\/(vercel\.com|railway\.com|railway\.app)\//.test(u) ? u : undefined);

/** The page for a loaded state. No data access of its own, so it can be rendered and checked directly. */
export function ServicesView({ state, busy, error, onTest, onTestAll }: {
  state: Loaded; busy: string | null; error: string;
  onTest: (key: string) => void; onTestAll: () => void;
}) {
  const results = new Map(state.results.map((r) => [r.key, r]));
  const top = summary(state.results);
  return (
    <main className="shell wide">
      <header className="top">
        <h1>Services</h1>
        <p className="who">Signed in as {state.actor}</p>
      </header>
      <p className="lead">
        Every service this site depends on, and whether it is answering right now. Each test only reads, so you can run
        it at any time. For how much traffic each connection carried and how much of it failed, see API traffic.
      </p>

      <section className={`status ${top.pill === "danger" ? "danger" : top.pill === "warn" ? "warn" : top.pill === "ok" ? "ok" : ""}`} role="status">
        <p><strong>{top.text}.</strong> Tested at {fmtTime(state.checked_at)}.</p>
        <div className="actions left">
          <button type="button" className="ghost" disabled={busy !== null} onClick={onTestAll}>
            {busy === "all" ? "Testing…" : "Test all again"}
          </button>
        </div>
      </section>
      {error && <p className="err" role="alert">{error}</p>}

      <Table caption="Services and their current status" first="Service"
        services={state.services.filter((s) => !isDeploy(s.key))} results={results} busy={busy} onTest={onTest} />
      {state.services.some((s) => isDeploy(s.key)) && <>
        <h2 className="group">Latest deploys</h2>
        <p className="hint">
          Whether the newest commit on main of each project reached production, as Vercel and Railway report it to GitHub.
          A failed deploy leaves the previous version running, so nothing merged since is live.
        </p>
        <Table caption="Latest production deploy per project" first="Project"
          services={state.services.filter((s) => isDeploy(s.key))} results={results} busy={busy} onTest={onTest} />
      </>}
      <p className="hint">
        A test sends a service's name to this site's server, which runs a fixed, read-only check: no address is ever taken
        from the page. The same service is not tested twice within 3 seconds.
      </p>
    </main>
  );
}

function Table({ caption, first, services, results, busy, onTest }: {
  caption: string; first: string; services: Service[]; results: Map<string, Result>; busy: string | null; onTest: (k: string) => void;
}) {
  return (
    <table className="table">
      <caption className="sr-only">{caption}</caption>
      <thead><tr>
        <th scope="col">{first}</th><th scope="col">Status</th><th scope="col" className="num">Answered in</th>
        <th scope="col">Last tested</th><th scope="col"><span className="sr-only">Test</span></th>
      </tr></thead>
      <tbody>{services.map((s) => <Row key={s.key} s={s} r={results.get(s.key)} busy={busy} onTest={onTest} />)}</tbody>
    </table>
  );
}

/** A deploy is not "running": it went live or it failed. */
const DEPLOY_TEXT: Partial<Record<Status, string>> = { up: "Deployed", down: "Failed" };

function Row({ s, r, busy, onTest }: { s: Service; r: Result | undefined; busy: string | null; onTest: (k: string) => void }) {
  const status = r?.status ?? "unknown";
  const st = { ...STATUS[status], ...(isDeploy(s.key) && DEPLOY_TEXT[status] ? { text: DEPLOY_TEXT[status]! } : {}) };
  return (
    <tr>
      <th scope="row">
        {s.label}
        <br /><span className="muted">{s.runs_on} · {s.what}</span>
        <details>
          <summary>What this test checks</summary>
          <p><strong>Proves:</strong> {s.proves}</p>
          <p><strong>Does not prove:</strong> {s.blind_to}</p>
        </details>
      </th>
      <td>
        <span className={`pill ${st.pill}`}>{st.text}</span>
        {r?.detail && <><br /><span className="muted">{r.detail}</span></>}
        {safeLink(r?.link) && <><br /><a href={safeLink(r?.link)} target="_blank" rel="noopener noreferrer">Open the build log</a></>}
      </td>
      <td className="num">{millis(r?.ms ?? null)}</td>
      <td>{r ? fmtTime(r.checked_at) : "—"}</td>
      <td>
        <button type="button" className="ghost" disabled={busy !== null} aria-label={`Test ${s.label}`} onClick={() => onTest(s.key)}>
          {busy === s.key ? "Testing…" : "Test"}
        </button>
      </td>
    </tr>
  );
}
