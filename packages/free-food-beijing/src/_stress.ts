// Stress-test harness for the pure logic in index.ts (parseDate, isFutureOrToday, dedup,
// fallback selection). Runs without hitting Browserbase / OpenRouter so we can shake out
// edge cases fast.
//
// Run with: pnpm --filter free-food-beijing exec tsx src/_stress.ts

const FAKE_TODAY = "2026-05-08";
const TODAY_DATE = new Date(`${FAKE_TODAY}T00:00:00.000Z`);
const YEAR = 2026;

// ── Copies of the production helpers (kept identical) ──────────────

function utcDate(year: number, month1to12: number, day: number): Date | null {
  const dt = new Date(Date.UTC(year, month1to12 - 1, day));
  if (isNaN(dt.getTime())) return null;
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month1to12 - 1 ||
    dt.getUTCDate() !== day
  ) return null;
  return dt;
}

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const s = dateStr.trim();
  if (!s) return null;

  const iso = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = utcDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10));
    if (dt) return dt;
  }

  const cnFull = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (cnFull) {
    const [, y, m, d] = cnFull;
    const dt = utcDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10));
    if (dt) return dt;
  }

  const cnShort = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (cnShort) {
    const [, mRaw, dRaw] = cnShort;
    const month = parseInt(mRaw!, 10);
    const day = parseInt(dRaw!, 10);
    const thisYear = utcDate(YEAR, month, day);
    if (thisYear) {
      return thisYear >= TODAY_DATE ? thisYear : utcDate(YEAR + 1, month, day);
    }
  }

  const native = new Date(s);
  if (!isNaN(native.getTime())) {
    return utcDate(native.getFullYear(), native.getMonth() + 1, native.getDate());
  }

  return null;
}

function isFutureOrToday(dateStr: string): boolean {
  const parsed = parseDate(dateStr);
  if (!parsed) return true;
  return parsed >= TODAY_DATE;
}

interface ScoredEvent {
  name: string;
  nameEnglish: string;
  date: string;
  timeAndLocation: string;
  likelihood: number;
  reasoning: string;
  foodAndDrinks: string;
  url: string;
  source: string;
}

function dedup(events: ScoredEvent[]): ScoredEvent[] {
  const seen = new Map<string, ScoredEvent>();
  for (const e of events) {
    const key = e.nameEnglish.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    const existing = seen.get(key);
    if (!existing || e.likelihood > existing.likelihood) {
      seen.set(key, e);
    }
  }
  return [...seen.values()];
}

// ── Tiny test runner ──────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      got:      ${JSON.stringify(actual)}`);
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      got:      ${JSON.stringify(actual)}`);
  }
}

function checkDate(label: string, input: string, expectedISO: string | null) {
  const got = parseDate(input);
  const gotISO = got ? got.toISOString().slice(0, 10) : null;
  check(label, gotISO, expectedISO);
}

// ── parseDate tests ──────────────────────────────────────────────

console.log("\n── parseDate ─────────────────────────────────────────────");
checkDate("ISO YYYY-MM-DD",                 "2026-05-15",                  "2026-05-15");
checkDate("ISO YYYY/MM/DD",                 "2026/05/15",                  "2026-05-15");
checkDate("ISO with time prefix",           "2026-05-15 19:00",            "2026-05-15");
checkDate("ISO single digit M/D",           "2026-5-9",                    "2026-05-09");
checkDate("ISO inside sentence",            "Event on 2026-05-15 at venue","2026-05-15");

checkDate("Chinese full YYYY年M月D日",       "2026年5月15日",                "2026-05-15");
checkDate("Chinese full with spaces",       "2026 年 5 月 15 日",            "2026-05-15");
checkDate("Chinese full no day char",       "2026年5月15",                  "2026-05-15");
checkDate("Chinese full single-digit",      "2026年5月9日",                 "2026-05-09");

// "M月D日" — assume current year, but if past, roll to next year. Today is 2026-05-08.
checkDate("Chinese short — today (5月8日)",     "5月8日",                       "2026-05-08");
checkDate("Chinese short — tomorrow",           "5月9日",                       "2026-05-09");
checkDate("Chinese short — yesterday rolls",   "5月7日",                       "2027-05-07");
checkDate("Chinese short — past month rolls",  "4月30日",                      "2027-04-30");
checkDate("Chinese short — future month",      "12月31日",                     "2026-12-31");

checkDate("English long",                   "May 15, 2026",                "2026-05-15");
checkDate("English D-M-Y",                  "15 May 2026",                 "2026-05-15");

checkDate("empty",                          "",                            null);
checkDate("only whitespace",                "   ",                         null);
checkDate("garbage",                        "TBD",                         null);
checkDate("partial garbage",                "next thursday",               null);

// ── isFutureOrToday tests ────────────────────────────────────────

console.log("\n── isFutureOrToday ───────────────────────────────────────");
check("today is included",       isFutureOrToday("2026-05-08"), true);
check("tomorrow is included",    isFutureOrToday("2026-05-09"), true);
check("yesterday is excluded",   isFutureOrToday("2026-05-07"), false);
check("last year excluded",      isFutureOrToday("2025-05-15"), false);
check("next year included",      isFutureOrToday("2027-01-01"), true);
check("Chinese yesterday excluded",  isFutureOrToday("2026年5月7日"),   false);
check("Chinese tomorrow included",   isFutureOrToday("2026年5月9日"),   true);
check("Chinese short past rolls→incl", isFutureOrToday("5月7日"),        true);
check("empty string → kept",     isFutureOrToday(""),           true);
check("garbage → kept",          isFutureOrToday("TBD"),        true);

// ── dedup tests ──────────────────────────────────────────────────

console.log("\n── dedup ─────────────────────────────────────────────────");

function ev(name: string, likelihood: number): ScoredEvent {
  return {
    name, nameEnglish: name, date: "2026-05-15", timeAndLocation: "",
    likelihood, reasoning: "", foodAndDrinks: "", url: `https://x/${name}`, source: "test",
  };
}

const a = ev("AI Hackathon", 60);
const b = ev("AI Hackathon", 80);    // duplicate, higher score
const c = ev("ai hackathon!", 50);   // different case + punctuation
const d = ev("Beijing Founder Mixer", 70);

const result = dedup([a, b, c, d]);
check("dedup keeps highest-scoring duplicate",
  result.find(e => e.name.toLowerCase().includes("hackathon"))?.likelihood, 80);
check("dedup collapses case/punct variants", result.length, 2);
check("dedup keeps unrelated event", result.find(e => e.name.includes("Mixer"))?.likelihood, 70);

// ── Fallback selection ───────────────────────────────────────────
// (mirror the logic in index.ts main block)

console.log("\n── fallback selection ────────────────────────────────────");

const MIN = 25;
const TOP_N = 5;

function selectFinal(all: ScoredEvent[]) {
  const sorted = [...all].sort((x, y) => y.likelihood - x.likelihood);
  const high = sorted.filter(e => e.likelihood >= MIN);
  if (high.length > 0) return { final: high, fallback: false };
  return { final: sorted.slice(0, TOP_N), fallback: true };
}

const empty = selectFinal([]);
check("zero events → empty + fallback flag", empty.final.length, 0);
check("zero events → fallback=true", empty.fallback, true);

const allLow = [ev("a", 10), ev("b", 15), ev("c", 5), ev("d", 20), ev("e", 12), ev("f", 8)];
const lowRes = selectFinal(allLow);
check("all-low → top 5 shown", lowRes.final.length, 5);
check("all-low → fallback=true", lowRes.fallback, true);
check("all-low → sorted desc", lowRes.final.map(e => e.likelihood), [20, 15, 12, 10, 8]);

const mixed = [ev("a", 10), ev("b", 60), ev("c", 80), ev("d", 5)];
const mixedRes = selectFinal(mixed);
check("mixed → only ≥25 shown", mixedRes.final.length, 2);
check("mixed → fallback=false", mixedRes.fallback, false);

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
