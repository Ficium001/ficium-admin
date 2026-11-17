import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrafficView } from "./ApiTrafficPage";
import type { Channel, Loaded, ResumeRequest, Stats } from "./api";

const noop = async () => undefined;
const html = (s: Loaded) => renderToStaticMarkup(<TrafficView state={s} onRefresh={() => undefined} onPause={noop} onAskResume={noop} onDecide={noop} />);
const text = (s: Loaded) => html(s).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const stats = (o: Partial<Stats> = {}): Stats => ({
  key: "kyc.aws_out", total: 200, ok: 190, client_errors: 4, server_errors: 6, network_errors: 0, blocked: 0, p50_ms: 140, p95_ms: 2200,
  last_ok_at: "2026-11-17T03:00:00Z", last_error_at: "2026-11-17T02:50:00Z", last_error: "HTTP 503 from provider",
  applied_state: "enabled", applied_version: 0, hourly_total: Array(24).fill(8), hourly_errors: Array(24).fill(0), ...o,
});
const ch = (o: Partial<Channel> = {}): Channel => ({
  key: "kyc.aws_out", direction: "outbound", label: "Face and liveness checks", peer: "Amazon Rekognition", description: "Face match and liveness.",
  pausable: true, lock_reason: null, state: "enabled", state_reason: null, version: 0, updated_at: "2026-11-17T00:00:00Z", updated_by: null,
  stats: stats(), applied: { state: "enabled", version: 0 }, ...o,
});
const base: Loaded = {
  actor: "kj@ficium.net", can_control: true, can_approve: true, generated_at: "2026-11-17T04:00:00Z", window_hours: 24, telemetry_error: null,
  channels: [
    ch({ key: "integration.events_in", direction: "inbound", label: "Events from the bank portal", peer: "Ficium portal", stats: stats({ key: "integration.events_in", total: 50, ok: 50, client_errors: 0, server_errors: 0 }) }),
    ch({ key: "admin.channel", direction: "inbound", label: "Admin site", peer: "Ficium app admin", pausable: false, lock_reason: "It cannot be paused.", stats: null, applied: null }),
    ch(),
  ],
  requests: [],
};
const pending = (o: Partial<ResumeRequest> = {}): ResumeRequest => ({
  id: "018f3a6e-7c1b-7c2a-9d3e-1a2b3c4d5e6f", channel_key: "kyc.aws_out", before: {}, reason: "key rotated and checked in the sandbox", status: "pending",
  maker: "pj@ficium.net", checker: null, decision_note: null, created_at: "2026-11-17T01:00:00Z", expires_at: "2026-11-20T01:00:00Z", decided_at: null, version: 1, mine: false, ...o,
});

describe("API traffic page", () => {
  it("groups channels into coming in and going out, with totals", () => {
    const t = text(base);
    expect(t.indexOf("Coming in")).toBeLessThan(t.indexOf("Going out"));
    expect(t).toContain("Events from the bank portal");
    expect(t).toContain("Face and liveness checks");
    expect(t).toContain("250"); expect(t).toContain("calls in 24 h");   // 50 + 200
    expect(t).toContain("2.4%");                                         // 6 of 250 failed
  });

  it("shows failures apart from refusals, the last failure, and speed", () => {
    const t = text(base);
    expect(t).toContain("Refused (4xx)");
    expect(t).toContain("HTTP 503 from provider");
    expect(t).toContain("2.2 s");
    expect(html(base)).toContain('role="img"');   // the hourly chart is labelled, not decoration
  });

  it("the admin channel is never offered a pause, and says why", () => {
    const only = { ...base, channels: [base.channels[1]] };
    const t = text(only);
    expect(t).toContain("cannot be paused");
    expect(t).not.toContain("Pause…");
  });

  it("offers Pause on a running channel and Ask to resume on a paused one", () => {
    expect(text(base)).toContain("Pause…");
    const paused = { ...base, channels: [ch({ state: "paused", version: 1, state_reason: "provider key may be exposed", updated_by: "kj@ficium.net", applied: { state: "paused", version: 1 } })] };
    const t = text(paused);
    expect(t).toContain("Ask to resume…");
    expect(t).toContain("provider key may be exposed");
    expect(t).toContain("1 channel paused");
  });

  it("says when the product has not heard about a pause yet", () => {
    const t = text({ ...base, channels: [ch({ state: "paused", version: 1, applied: { state: "enabled", version: 0 } })] });
    expect(t).toContain("Paused, not yet in force");
  });

  it("read-only admins see everything and cannot act", () => {
    const t = text({ ...base, can_control: false });
    expect(t).toContain("You can see this page but not change channels");
    expect(html({ ...base, can_control: false })).toMatch(/disabled=""[^>]*>Pause…/);
  });

  it("a waiting resume request: the maker can withdraw, a different admin can approve, nobody approves their own", () => {
    const paused = (r: ResumeRequest, canApprove = true) => text({ ...base, can_approve: canApprove, channels: [ch({ state: "paused", version: 1 })], requests: [r] });
    const other = paused(pending());
    expect(other).toContain("pj@ficium.net asked to resume");
    expect(other).toContain("Approve: resume traffic");
    expect(other).not.toContain("Withdraw request");
    const mine = paused(pending({ mine: true }));
    expect(mine).toContain("You asked");
    expect(mine).toContain("Withdraw request");
    expect(mine).not.toContain("Approve: resume traffic");
    expect(paused(pending(), false)).not.toContain("Approve: resume traffic");
  });

  it("missing numbers are said, not shown as zero", () => {
    const t = text({ ...base, generated_at: null, telemetry_error: "The product could not be reached, so the live numbers are missing", channels: [ch({ stats: null, applied: null })] });
    expect(t).toContain("Live numbers are missing");
    expect(t).toContain("No numbers for this channel");
    expect(t).toContain("no live numbers");
  });

  it("past resume requests are listed with who decided", () => {
    const t = text({ ...base, requests: [pending({ status: "rejected", checker: "pj@ficium.net", decision_note: "review not finished", decided_at: "2026-11-17T02:00:00Z" })] });
    expect(t).toContain("rejected by pj@ficium.net");
    expect(t).toContain("review not finished");
  });
});
