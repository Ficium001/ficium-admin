import { describe, it, expect, vi } from "vitest";
import { makeHandler, MAX_BYTES, type Deps } from "../offer-image.js";
import { AuthError } from "../_lib/access.js";

function res() {
  const r: any = { code: 0, body: null, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  return r;
}
const staff = vi.fn(async () => "kj@ficium.net") as unknown as Deps["requireStaff"];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
function req(body: Buffer, type: string, method = "POST") {
  return Object.assign((async function* () { yield body; })(), { method, headers: { "content-type": type } });
}

describe("POST /api/offer-image", () => {
  it("stores a real PNG under offers/ and returns its URL", async () => {
    const put = vi.fn(async () => ({ url: "https://abc.public.blob.vercel-storage.com/offers/x.png" }));
    const r = res();
    await makeHandler({ requireStaff: staff, put })(req(PNG, "image/png"), r);
    expect(r.code).toBe(200);
    expect(put).toHaveBeenCalledWith(expect.stringMatching(/^offers\/[0-9a-f-]{36}\.png$/), PNG, "image/png");
  });
  it("rejects types it doesn't allow", async () => {
    const put = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staff, put })(req(Buffer.from("<svg/>"), "image/svg+xml"), r);
    expect(r.code).toBe(415); expect(put).not.toHaveBeenCalled();
  });
  it("rejects a file whose bytes don't match its declared type", async () => {
    const put = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staff, put })(req(Buffer.from("<html>not a png</html>"), "image/png"), r);
    expect(r.code).toBe(415); expect(put).not.toHaveBeenCalled();
  });
  it("rejects files over the size limit", async () => {
    const put = vi.fn(); const r = res();
    await makeHandler({ requireStaff: staff, put })(req(Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]), "image/png"), r);
    expect(r.code).toBe(413); expect(put).not.toHaveBeenCalled();
  });
  it("stores nothing for an unsigned-in caller", async () => {
    const put = vi.fn(); const r = res();
    const deny = vi.fn(async () => { throw new AuthError(401, "no"); }) as unknown as Deps["requireStaff"];
    await makeHandler({ requireStaff: deny, put })(req(PNG, "image/png"), r);
    expect(r.code).toBe(401); expect(put).not.toHaveBeenCalled();
  });
});
