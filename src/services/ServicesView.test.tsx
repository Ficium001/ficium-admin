import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ServicesView, summary } from "./ServicesPage";
import type { Loaded, Result } from "./api";

const noop = () => undefined;
const svc = (key: string, label: string) => ({ key, label, what: `${label} does things.`, runs_on: "Railway", proves: "It answers now.", blind_to: "Whether a sign-in works." });
const res = (key: string, status: Result["status"], detail = "", ms: number | null = 120): Result => ({ key, status, ms, detail, checked_at: "2026-11-17T08:30:15Z" });
const base: Loaded = {
  actor: "kj@ficium.net", checked_at: "2026-11-17T08:30:15Z",
  services: [svc("identity", "Sign-in service"), svc("portal_api", "Portal API"), svc("admin_db", "Admin database")],
  results: [res("identity", "up", "Serving 2 signing keys."), res("portal_api", "down", "Could not be reached.", 8000), res("admin_db", "slow", "Answered a test query. Slower than 2 s.", 2400)],
};
const text = (s: Loaded, busy: string | null = null) =>
  renderToStaticMarkup(<ServicesView state={s} busy={busy} error="" onTest={noop} onTestAll={noop} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("Services page", () => {
  it("shows each service's status, why, answer time and a test button", () => {
    const t = text(base);
    expect(t).toMatch(/Sign-in service Railway · Sign-in service does things\..*Running Serving 2 signing keys\. 120 ms/);
    expect(t).toMatch(/Portal API .* Broken Could not be reached\. 8\.0 s/);
    expect(t).toMatch(/Admin database .* Slow Answered a test query\. Slower than 2 s\. 2\.4 s/);
    expect(t).toContain("Does not prove: Whether a sign-in works.");
    const html = renderToStaticMarkup(<ServicesView state={base} busy={null} error="" onTest={noop} onTestAll={noop} />);
    expect(html.match(/aria-label="Test [^"]+"/g)).toEqual(['aria-label="Test Sign-in service"', 'aria-label="Test Portal API"', 'aria-label="Test Admin database"']);
  });

  it("leads with the worst news", () => {
    expect(text(base)).toContain("1 service is broken.");
    expect(summary([res("a", "up"), res("b", "slow")]).text).toBe("1 service needs attention");
    expect(summary([res("a", "up"), res("b", "up")]).text).toBe("Everything is running");
    expect(summary([res("a", "up"), res("b", "unknown")]).text).toBe("Some services could not be judged");
    expect(summary([res("a", "not_configured")]).pill).toBe("warn");
  });

  it("disables every button while a test runs, and says which one", () => {
    const html = renderToStaticMarkup(<ServicesView state={base} busy="portal_api" error="" onTest={noop} onTestAll={noop} />);
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(text(base, "portal_api")).toContain("Testing…");
  });

  it("shows a service with no result yet as unknown", () => {
    expect(text({ ...base, results: [] })).toMatch(/Sign-in service .* Unknown — —/);
  });

  it("renders text from a result as text, never markup", () => {
    const html = renderToStaticMarkup(<ServicesView state={{ ...base, results: [res("identity", "down", "<img src=x onerror=alert(1)>")] }} busy={null} error="" onTest={noop} onTestAll={noop} />);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
