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
    expect(csv[2]).toContain('"Date"');
    expect(csv[3]).toContain('"4500.00"');
    expect(csv[4]).toContain('"Total"');
  });
  it("neutralises formulas and escapes quotes", () => {
    expect(csv[3]).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("statementCsv with clawbacks", () => {
  const withCredit: Statement = { ...S,
    adjustments: [{ adjustment_id: "a1", commission_id: "c0", pipeline_id: "p0", kind: "clawback", amount: "-250.00",
      currency: "MUR", effective_on: "2026-11-20", reason: "client stopped the plan", product_code: "savings_plan",
      product_name: "Savings plan", calc: { share: 1 } }],
    totals: { ...S.totals, adjustments: "-250.00", net: "4250.00" } };
  const csv = statementCsv(withCredit).split("\r\n");
  it("lists the credit and ends with clawbacks and net", () => {
    expect(csv[4]).toContain('"Clawback: client stopped the plan"');
    expect(csv[4]).toContain('"-250.00"');
    expect(csv[5]).toContain('"Total"');
    expect(csv[6]).toContain('"Clawbacks"');
    expect(csv[7]).toContain('"Net"');
    expect(csv[7]).toContain('"4250.00"');
  });
  it("keeps a negative amount a number, but still neutralises a formula", () => {
    expect(csv[4]).not.toContain(`'-250.00`);
    const evil = statementCsv({ ...withCredit, adjustments: [{ ...withCredit.adjustments![0]!, reason: "-1+cmd" }] });
    expect(evil).toContain(`"Clawback: -1+cmd"`);
    const lead = statementCsv({ ...S, lines: [{ ...S.lines[0]!, invoice_ref: "-2+3" }] });
    expect(lead).toContain(`"'-2+3"`);
  });
});
