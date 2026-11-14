import { describe, it, expect } from "vitest";
import { statementCsv, type Statement } from "./api";

const S: Statement = {
  institution: { id: "i", name: "MCB", reg_number: "C07000001", country: "MU" }, month: "2026-11",
  lines: [{ commission_id: "c1", pipeline_id: "p1", request_id: "r1", booked_on: "2026-11-03", product_code: "personal_loan",
    product_name: "Personal loan", deal_amount: "500000", commission_rate: "0.0090", commission_amt: "4500.00", currency: "MUR",
    status: "pending", invoice_ref: '=HYPERLINK("x")', invoiced_at: null, paid_at: null }],
  totals: { deals: 1, commission: "4500.00", by_status: { pending: "4500.00" }, currencies: ["MUR"] },
};

describe("statementCsv", () => {
  const csv = statementCsv(S).split("\r\n");
  it("has a title, a header, one row per deal and a total", () => {
    expect(csv[0]).toContain("MCB (C07000001), 2026-11");
    expect(csv[2]).toContain('"Booked on"');
    expect(csv[3]).toContain('"4500.00"');
    expect(csv[4]).toContain('"Total"');
  });
  it("neutralises formulas and escapes quotes", () => {
    expect(csv[3]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
