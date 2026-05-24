// Registry of named reports for `lolly_report`. Each entry encodes the
// ShareChat/NetSuite rules from /Applications/nanoclaw/CLAUDE.md "NetSuite Rules"
// directly in its preamble so report behavior is portable even if the
// workspace MEMORY.md drifts. Workspace rules still enforce at runtime;
// these preambles are the belt to the workspace's suspenders.
//
// Scoped to the 6 reports called out in the M3 plan (§6 step 2):
//   vendor_balance, open_bills, bill_detail, vendor_summary,
//   gstin_lookup, po_status.

export type ExpectedShape = 'scalar' | 'rows' | 'narrative' | 'mixed';

export interface ReportDef {
  /**
   * Build the natural-language question sent to Lolly. `params` is the
   * caller-supplied params merged with an `env` key (the resolved env).
   */
  preamble: (params: Record<string, string>) => string;
  expected_shape: ExpectedShape;
  /** Parameter keys the caller MUST supply. Enforced by the handler. */
  required_params: string[];
}

export const REPORT_REGISTRY: Record<string, ReportDef> = {
  vendor_balance: {
    preamble: (p) =>
      `Return the current open balance for vendor "${p.vendor_name}" in ${p.env ?? 'production'}. ` +
      `Apply the ShareChat sandbox-vs-production sign conventions (signs flip between envs — ` +
      `see MEMORY.md). Open balance includes Bill + Journal + VPrep + BillCredit. Disambiguate ` +
      `same-name vendors by Vendor ID + GSTIN and surface ambiguity in "unanswered" if more ` +
      `than one vendor matches.`,
    expected_shape: 'scalar',
    required_params: ['vendor_name'],
  },
  open_bills: {
    preamble: (p) =>
      `List open bills for vendor "${p.vendor_name}" in ${p.env ?? 'production'}. A bill is ` +
      `"open" when VendBill status IN ('A','D') — never filter on 'A' alone. Return rows with ` +
      `columns: bill_id, tranid, trandate, amount, due_date, days_overdue. Apply sandbox-vs-prod ` +
      `sign conventions per MEMORY.md.`,
    expected_shape: 'rows',
    required_params: ['vendor_name'],
  },
  bill_detail: {
    preamble: (p) =>
      `Return full detail for bill ID ${p.bill_id} in ${p.env ?? 'production'}: header ` +
      `(vendor, tranid, trandate, amount, status), line items, applied payments. Include the ` +
      `linked purchase order tranid if any. Include vendor GSTIN via the REST taxRegistration ` +
      `endpoint (SuiteQL cannot return GSTIN). Apply sandbox-vs-prod sign conventions.`,
    expected_shape: 'mixed',
    required_params: ['bill_id'],
  },
  vendor_summary: {
    preamble: (p) =>
      `Summarise vendor "${p.vendor_name}" in ${p.env ?? 'production'}: Vendor ID, GSTIN (via ` +
      `REST taxRegistration), total open balance (Bill + Journal + VPrep + BillCredit), open ` +
      `bill count (status IN ('A','D')), aging buckets (0-30, 31-60, 61-90, 90+). Disambiguate ` +
      `same-name vendors by Vendor ID + GSTIN; if multiple vendors match, list each in the ` +
      `response rather than picking one. Apply sandbox-vs-prod sign conventions.`,
    expected_shape: 'mixed',
    required_params: ['vendor_name'],
  },
  gstin_lookup: {
    preamble: (p) =>
      `Return the GSTIN for vendor "${p.vendor_name}" in ${p.env ?? 'production'}. Use the REST ` +
      `taxRegistration endpoint — SuiteQL cannot return GSTIN. If more than one vendor matches ` +
      `the name, return all GSTINs with their Vendor IDs so the caller can disambiguate.`,
    expected_shape: 'scalar',
    required_params: ['vendor_name'],
  },
  po_status: {
    preamble: (p) =>
      `Return status of purchase order ${p.po_number} in ${p.env ?? 'production'}: approval ` +
      `state, fulfillment status, linked bills (with bill_id + tranid + amount), and remaining ` +
      `committed amount. Apply sandbox-vs-prod sign conventions per MEMORY.md.`,
    expected_shape: 'mixed',
    required_params: ['po_number'],
  },
};
