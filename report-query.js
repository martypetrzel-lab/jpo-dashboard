export function normalizeReportFilters(input = {}) {
  const bad = () => { const error = new Error("bad_report_filters"); error.statusCode = 400; throw error; };
  const int = (name, fallback, min, max, clamp = false) => {
    const raw = input[name];
    if (raw == null || raw === "") return fallback;
    if (!/^\d+$/.test(String(raw))) return bad();
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min) return bad();
    if (n > max) return clamp ? max : bad();
    return n;
  };
  const type = String(input.type || "").trim();
  if (type && !["day", "week", "month"].includes(type)) bad();
  const date = name => {
    const value = String(input[name] || "").trim();
    if (!value) return "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return bad();
    const parsed = new Date(value + "T00:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return bad();
    return value;
  };
  const from = date("from"), to = date("to");
  if (from && to && from > to) bad();
  const flag = input.include_empty ?? input.includeEmpty ?? false;
  if (![true, false, "true", "false", "1", "0"].includes(flag)) bad();
  const q = String(input.q || "").trim();
  if (q.length > 120) bad();
  return {
    type, year: int("year", null, 2000, 2100), month: int("month", null, 1, 12),
    from, to, includeEmpty: [true, "true", "1"].includes(flag), q,
    limit: int("limit", 30, 1, 100, true), offset: int("offset", 0, 0, 1_000_000)
  };
}

export function buildReportWhere(filters) {
  const params = [], clauses = [];
  const add = (sql, value) => { params.push(value); clauses.push(sql.replace("?", "$" + params.length)); };
  if (filters.type) add("period_type = ?", filters.type);
  if (filters.year) add("EXTRACT(YEAR FROM period_start)::int = ?", filters.year);
  if (filters.month) add("EXTRACT(MONTH FROM period_start)::int = ?", filters.month);
  if (filters.from) add("period_end >= ?::date", filters.from);
  if (filters.to) add("period_start <= ?::date", filters.to);
  if (!filters.includeEmpty) clauses.push("total_events > 0");
  if (filters.q) {
    params.push("%" + filters.q.replace(/[\\%_]/g, "\\$&") + "%");
    const p = "$" + params.length;
    clauses.push(`(title ILIKE ${p} OR period_key ILIKE ${p} OR to_char(period_start, 'FMDD. FMMM. YYYY') ILIKE ${p})`);
  }
  return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}
