import { describe, it, expect } from "vitest";
import { modelFromForm, describeModel, shortModel, modelOf, percentToFraction } from "../_lib/fee-model.js";

describe("fee models", () => {
  it("defaults to a rate on the booked amount (the db/058 behaviour)", () => {
    expect(modelFromForm({ rate_percent: "0.5" })).toEqual({ basis: "booked_amount", rate: "0.0050", params: {},
      min_fee: null, max_fee: null, clawback_months: 0, clawback_mode: "none" });
  });
  it("0% is allowed, for a free pilot", () => expect(percentToFraction("0")).toBe("0.0000"));
  it("a lump share of 100% is the default and is not sent", () => {
    expect(modelFromForm({ basis: "annualised", rate_percent: "1", months: "12", lump_percent: "100" }).params).toEqual({ months: 12 });
    expect(modelFromForm({ basis: "annualised", rate_percent: "1", months: "12", lump_percent: "50" }).params).toEqual({ months: 12, lump_weight: 0.5 });
  });
  it("a clawback with no mode is pro rata; no months means none", () => {
    expect(modelFromForm({ rate_percent: "1", clawback_months: "6" }).clawback_mode).toBe("pro_rata");
    expect(modelFromForm({ rate_percent: "1", clawback_months: "0", clawback_mode: "full" }).clawback_mode).toBe("none");
  });
  it("a flat fee ignores a minimum and maximum typed earlier", () => {
    const m = modelFromForm({ basis: "flat", flat_amount: "350", min_fee: "100", max_fee: "900" });
    expect(m.min_fee).toBeNull(); expect(m.max_fee).toBeNull();
  });
  it.each([
    [{ basis: "booked_amount", rate_percent: "" }, "percentage"],
    [{ basis: "annualised", rate_percent: "1", months: "61" }, "Months"],
    [{ basis: "amount_x_term", rate_percent: "0.2", max_years: "31" }, "Most years"],
    [{ basis: "tiered", tiers: [] }, "1 to 10 bands"],
    [{ basis: "tiered", tiers: [{ up_to: "100", rate_percent: "9" }, { rate_percent: "1" }] }, "above 5%"],
    [{ basis: "tiered", tiers: [{ up_to: "100", rate_percent: "1" }, { up_to: "200", rate_percent: "1" }] }, "last band"],
  ])("refuses %o", (f, msg) => expect(() => modelFromForm(f)).toThrow(msg));

  it("describes tiers in words a reviewer can check", () => {
    const m = modelFromForm({ basis: "tiered", tier_mode: "marginal",
      tiers: [{ up_to: "100000", rate_percent: "1" }, { up_to: "500000", rate_percent: "0.5" }, { rate_percent: "0.25" }] });
    expect(describeModel(m)).toBe("Each band at its own rate: 1% up to MUR 100,000, 0.5% MUR 100,000 to MUR 500,000, 0.25% above MUR 500,000");
    expect(shortModel(m)).toBe("Banded");
  });
  it("describes a term deposit and a flat fee", () => {
    expect(describeModel(modelFromForm({ basis: "amount_x_term", rate_percent: "0.2", max_years: "2" })))
      .toBe("0.2% of the amount per year of term, at most 2 years");
    expect(shortModel({ basis: "flat", params: { amount: 350 } })).toBe("MUR 350 flat");
  });
  it("reads portal rows the same way however numbers arrive, so snapshots compare", () => {
    const fromPortal = { basis: "annualised", rate: "0.0100", params: { months: 12 }, min_fee: "250.00", max_fee: null,
      clawback_months: 6, clawback_mode: "pro_rata" };
    expect(JSON.stringify(modelOf(fromPortal))).toBe(JSON.stringify(modelOf({ ...fromPortal })));
    expect(modelOf({ rate: 0.005 })).toMatchObject({ basis: "booked_amount", rate: "0.005", clawback_mode: "none" });
  });
});
