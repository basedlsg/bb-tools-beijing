import "@bb-tools/shared";
import { getEnv, requireEnv } from "@bb-tools/shared";
import Browserbase from "@browserbasehq/sdk";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod/v3";

// ── Configuration ───────────────────────────────────────────────

// "Today" anchored to the user's LOCAL calendar date, then represented as the
// corresponding UTC midnight. This avoids the gotcha where toISOString() on a
// local-time Date silently subtracts the TZ offset (Beijing is UTC+8, so
// `new Date().toISOString().slice(0,10)` returns yesterday between 00:00–08:00).
const _now = new Date();
const TODAY_DATE = new Date(Date.UTC(_now.getFullYear(), _now.getMonth(), _now.getDate()));
const TODAY = TODAY_DATE.toISOString().slice(0, 10);
const YEAR = _now.getFullYear();

// Threshold for "high-confidence" picks. Events below this still surface in
// the fallback top-N so the user always gets something to work with.
const MIN_LIKELIHOOD = 25;
const ALWAYS_SHOW_TOP_N = 5;
const MAX_DETAIL_PAGES = 6;
const EVENTBRITE_LIMIT = 6;
// Each web-search visit = 1 page-load + 1 LLM extraction. Browserbase free
// sessions cap around 5min, so be conservative here — platform scrapers below
// give us most of the value already.
const WEB_SEARCH_VISIT_LIMIT = 5;

// Choose the LLM route automatically:
//   1. ANTHROPIC_API_KEY set → talk to api.anthropic.com directly (cheapest,
//      most reliable, best at Chinese — recommended).
//   2. else → OpenRouter. Default to free Llama for users without credits;
//      override with OPENROUTER_MODEL=anthropic/claude-sonnet-4-6 for paid.
const HAS_ANTHROPIC = !!getEnv("ANTHROPIC_API_KEY");
const ROUTE: "anthropic" | "openrouter" = HAS_ANTHROPIC ? "anthropic" : "openrouter";
const RAW_MODEL = HAS_ANTHROPIC
  ? (getEnv("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6")
  : (getEnv("OPENROUTER_MODEL") ?? "meta-llama/llama-3.3-70b-instruct:free");

// Stagehand V3 splits modelName at the first "/" to pick an AI-SDK subprovider.
// For OpenRouter, force the OpenAI-compatible route since that's the protocol
// OpenRouter speaks; for direct Anthropic, prefix with "anthropic/" so AI-SDK
// uses the native Anthropic provider with ANTHROPIC_API_KEY.
const MODEL_NAME =
  ROUTE === "anthropic"
    ? (RAW_MODEL.startsWith("anthropic/") ? RAW_MODEL : `anthropic/${RAW_MODEL}`)
    : (RAW_MODEL.startsWith("openai/") ? RAW_MODEL : `openai/${RAW_MODEL}`);

// ── Browserbase SDK (for web search) ────────────────────────────

const bb = new Browserbase({ apiKey: requireEnv("BROWSERBASE_API_KEY") });

// ── Stagehand (OpenRouter, for page extraction) ─────────────────

const stagehand = new Stagehand({
  env: "BROWSERBASE",
  // Force local LLM inference. With env=BROWSERBASE and disableAPI=false (the
  // default) Stagehand routes extract/act through api.stagehand.browserbase.com
  // which uses *its own* credentials and ignores the model.apiKey/baseURL we
  // pass below — our OpenRouter/Anthropic key would never be used.
  disableAPI: true,
  model:
    ROUTE === "anthropic"
      ? {
          modelName: MODEL_NAME,
          apiKey: requireEnv("ANTHROPIC_API_KEY"),
        }
      : {
          modelName: MODEL_NAME,
          apiKey: requireEnv("OPENROUTER_API_KEY"),
          baseURL: "https://openrouter.ai/api/v1",
        },
});

await stagehand.init();
const page = stagehand.context.pages()[0];

// ── Types & Schemas ─────────────────────────────────────────────

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

const results: ScoredEvent[] = [];

const listingSchema = z.object({
  events: z.array(
    z.object({
      name: z.string(),
      nameEnglish: z.string(),
      date: z.string(),
      time: z.string(),
      likelihood: z.number().min(0).max(100),
      reasoning: z.string(),
      foodAndDrinks: z.string(),
    }),
  ),
});

const detailSchema = z.object({
  name: z.string(),
  nameEnglish: z.string(),
  date: z.string(),
  timeAndLocation: z.string(),
  likelihood: z.number().min(0).max(100),
  reasoning: z.string(),
  foodAndDrinks: z.string(),
});

// ── Prompts ─────────────────────────────────────────────────────

const SCORING_RUBRIC = `Score 0-100 the likelihood that a regular attendee receives FREE food/drinks AT NO EXTRA COST beyond the ticket/registration:

  90-100 → Page explicitly says "free food", "免费餐饮", "complimentary drinks", "free pizza/beer/snacks"
  75-89  → Page mentions "refreshments provided", "茶歇", "提供茶点", "catering included", "酒会" (reception)
  60-74  → Tech demo day, product launch, hackathon, investor pitch, or VC mixer (these almost always cater, even when not stated)
  45-59  → Networking mixer, happy hour, after-party, or community reception (drinks/appetizers are standard)
  30-44  → Professional workshop, panel, or community meetup (sometimes light refreshments)
  10-29  → General talk/screening/class — possible but unlikely
  0-9    → Paid food festival, concert/yoga/lecture, online-only event, or "费用自理"/"AA制" (pay-your-own)

KEY RULE: When the event TYPE strongly implies food (tech meetup, hackathon, demo, mixer, launch, reception), score by type — do NOT require the page to spell out "free food". The detail-page pass will refine this.`;

const LISTING_PROMPT = `Extract every event card from this Beijing event listing page.

${SCORING_RUBRIC}

For each event return:
  - name (in the original language)
  - nameEnglish (translate Chinese to English; if already English, copy as-is)
  - date (the event date as it appears — prefer YYYY-MM-DD, otherwise raw text like "5月15日" or "Sat May 16")
  - time (start time / time-of-day if visible)
  - likelihood (integer 0-100)
  - reasoning (one sentence — cite specific evidence OR explain the event-type reasoning)
  - foodAndDrinks (specific items mentioned, or empty string)

IMPORTANT: Do NOT skip events with unclear or missing dates. Extract every event you see — date filtering happens later in code, not here.`;

const DETAIL_PROMPT = `Analyze this single Beijing event page.

${SCORING_RUBRIC}

DISQUALIFIERS (auto-score 0):
  • "费用自理" / "AA制" / "pay for your own" / "BYOB" → attendees pay
  • Paid food festival / market / tasting (vendors charge per item)
  • Online/virtual-only event with no in-person component

Return:
  - name (original language)
  - nameEnglish (translate if Chinese)
  - date (YYYY-MM-DD if you can determine the year, otherwise the raw date string)
  - timeAndLocation (date + time + venue, all together)
  - likelihood (integer 0-100)
  - reasoning (cite specific evidence from the page)
  - foodAndDrinks (specific items or empty string)

IMPORTANT: Extract the date as it appears on the page. Do NOT zero out the score because the date looks ambiguous — code handles date filtering.`;

// ── Date filtering (deterministic, not LLM) ─────────────────────

// All parsing returns a UTC-midnight Date representing a calendar date, so
// comparisons with TODAY_DATE and round-trips through toISOString() are stable.
function utcDate(year: number, month1to12: number, day: number): Date | null {
  const dt = new Date(Date.UTC(year, month1to12 - 1, day));
  if (isNaN(dt.getTime())) return null;
  // Reject parsed nonsense like 2026-13-99 (overflow rolls into another month).
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

  // YYYY-MM-DD or YYYY/MM/DD
  const iso = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = utcDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10));
    if (dt) return dt;
  }

  // "YYYY年M月D日"
  const cnFull = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (cnFull) {
    const [, y, m, d] = cnFull;
    const dt = utcDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10));
    if (dt) return dt;
  }

  // "M月D日" — assume current year, but if that's already past, roll to next year
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

  // English: "May 15, 2026" / "15 May 2026"
  const native = new Date(s);
  if (!isNaN(native.getTime())) {
    // Re-anchor to UTC midnight of the parsed calendar date (in local TZ —
    // this matches what a user typing the date means by "May 15").
    return utcDate(native.getFullYear(), native.getMonth() + 1, native.getDate());
  }

  return null;
}

// Generous: if we cannot parse the date at all, KEEP the event. The LLM has
// already factored "looks past" into its score; we only filter when we can
// confidently say a date is in the past.
function isFutureOrToday(dateStr: string): boolean {
  const parsed = parseDate(dateStr);
  if (!parsed) return true;
  return parsed >= TODAY_DATE;
}

// ── Helpers ──────────────────────────────────────────────────────

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

async function safeGoto(url: string): Promise<boolean> {
  try {
    await page!.goto(url, { timeoutMs: 30_000 });
    // Use "load" not "networkidle" — many event-platform pages have persistent
    // websockets/analytics sockets that never go idle, causing 30s timeouts.
    await page!.waitForLoadState("load");
    await page!.waitForTimeout(2000);
    return true;
  } catch {
    console.log(`  ⚠ Failed to load: ${url}`);
    return false;
  }
}

function log(source: string, msg: string) {
  console.log(`  [${source}] ${msg}`);
}

// Track LLM failures across the run. When the configured model can't produce
// a single successful extraction in N consecutive tries, every later phase is a
// waste of session time — so we trip a global circuit breaker.
const CIRCUIT_BREAKER_THRESHOLD = 5;
let consecutiveExtractionFailures = 0;
let circuitTripped = false;

function noteExtractionResult(success: boolean): void {
  if (success) {
    consecutiveExtractionFailures = 0;
  } else if (++consecutiveExtractionFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    if (!circuitTripped) {
      console.log(
        `\n⛔ ${CIRCUIT_BREAKER_THRESHOLD} extractions failed in a row — model "${RAW_MODEL}" appears broken. Aborting remaining phases.\n`,
      );
      circuitTripped = true;
    }
  }
}

function recordCandidate(e: ScoredEvent, source: string): void {
  if (!isFutureOrToday(e.date)) {
    log(source, `  ✗ Past event (${e.date}): ${e.nameEnglish || e.name}`);
    return;
  }
  if (e.likelihood < MIN_LIKELIHOOD) {
    log(source, `  ↘ Low (${e.likelihood}%): ${e.nameEnglish || e.name} — kept for fallback`);
  } else {
    log(source, `  ✓ (${e.likelihood}%): ${e.nameEnglish || e.name}`);
  }
  results.push(e);
}

// ── Phase 1: Targeted Web Search ────────────────────────────────

async function searchWebForFreeFood(): Promise<void> {
  const SOURCE = "Web Search";

  const queries = [
    `Beijing tech meetup free food drinks ${YEAR}`,
    `Beijing startup event free food refreshments ${YEAR}`,
    `Beijing hackathon free food ${YEAR}`,
    `Beijing networking event complimentary drinks ${YEAR}`,
    `北京 活动 茶歇 免费 ${YEAR}`,
    `北京 科技 沙龙 提供茶点 ${YEAR}`,
    `北京 黑客松 免费餐饮 ${YEAR}`,
    `北京 创业 活动 免费 下午茶 ${YEAR}`,
    `北京 线下 meetup 免费零食 ${YEAR}`,
    `北京 产品发布会 酒会 ${YEAR}`,
  ];

  const seenUrls = new Set<string>();
  const allResults: Array<{ title: string; url: string }> = [];

  for (const query of queries) {
    log(SOURCE, `Searching: "${query}"`);
    try {
      const { results: qResults } = await bb.search.web({ query, numResults: 10 });
      if (qResults) {
        for (const r of qResults) {
          if (!seenUrls.has(r.url)) {
            seenUrls.add(r.url);
            allResults.push(r);
          }
        }
      }
    } catch (e) {
      log(SOURCE, `  ⚠ Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log(SOURCE, `Found ${allResults.length} unique URLs across ${queries.length} searches`);

  const SKIP_DOMAINS = [
    "youtube.com", "twitter.com", "x.com", "reddit.com",
    "wikipedia.org", "zhihu.com", "weibo.com", "baidu.com",
    "google.com", "bing.com",
  ];

  const candidateUrls = allResults.filter((r) => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, "");
      return !SKIP_DOMAINS.some((d) => host.includes(d));
    } catch {
      return false;
    }
  });

  log(SOURCE, `${candidateUrls.length} candidate URLs after filtering`);

  let visited = 0;
  for (const result of candidateUrls.slice(0, WEB_SEARCH_VISIT_LIMIT)) {
    if (circuitTripped) return;
    if (visited >= WEB_SEARCH_VISIT_LIMIT) break;

    log(SOURCE, `  Visiting: ${result.title.slice(0, 60)}…`);
    if (!(await safeGoto(result.url))) continue;
    visited++;

    const r = await trackedExtract(() => stagehand.extract(DETAIL_PROMPT, detailSchema));
    if (r.ok) {
      recordCandidate({ ...r.value, url: result.url, source: SOURCE }, SOURCE);
    } else {
      log(SOURCE, `  ⚠ Extract failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`);
    }
  }
}

// ── Phase 2: Platform scrapers ──────────────────────────────────

async function scrapeLuma(): Promise<void> {
  const SOURCE = "Luma";
  const LUMA_URL = "https://lu.ma/beijing";
  log(SOURCE, `Loading ${LUMA_URL}`);
  if (!(await safeGoto(LUMA_URL))) return;
  await page!.waitForTimeout(1500);

  const r = await trackedExtract(() => stagehand.extract(LISTING_PROMPT, listingSchema));
  if (!r.ok) {
    log(SOURCE, `  Listing extract failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`);
    return;
  }
  const listing = r.value;
  log(SOURCE, `Found ${listing.events.length} events on listing page`);

  let detailCount = 0;
  for (const event of listing.events) {
    if (circuitTripped) return;

    if (event.likelihood >= 45 && detailCount < MAX_DETAIL_PAGES) {
      try {
        await stagehand.act(`click the "${event.name}" event`);
        await page!.waitForTimeout(2500);
        const url = page!.url();
        const dr = await trackedExtract(() => stagehand.extract(DETAIL_PROMPT, detailSchema));
        if (dr.ok) {
          recordCandidate({ ...dr.value, url, source: SOURCE }, SOURCE);
          detailCount++;
          await safeGoto(LUMA_URL);
          continue;
        }
        // detail extract failed — fall through to listing data
        await safeGoto(LUMA_URL);
      } catch {
        // act/click failed — fall through to listing data
      }
    }

    recordCandidate(
      {
        name: event.name,
        nameEnglish: event.nameEnglish || event.name,
        date: event.date,
        timeAndLocation: event.time,
        likelihood: event.likelihood,
        reasoning: event.reasoning,
        foodAndDrinks: event.foodAndDrinks,
        url: LUMA_URL,
        source: SOURCE,
      },
      SOURCE,
    );
  }
}

async function scrapeEventbrite(): Promise<void> {
  const SOURCE = "Eventbrite";

  // Note: deliberately NOT scraping the "food-and-drink" category — those are
  // paid food festivals / tastings, the opposite of what we want.
  const categories = [
    "https://www.eventbrite.com/d/china--beijing/business--events/",
    "https://www.eventbrite.com/d/china--beijing/science-and-tech--events/",
    "https://www.eventbrite.com/d/china--beijing/networking--events/",
  ];

  const ebUrls: string[] = [];
  for (const catUrl of categories) {
    log(SOURCE, `Loading ${catUrl}`);
    if (!(await safeGoto(catUrl))) continue;

    const urls: string[] = await page!.evaluate(() =>
      [...new Set(
        Array.from(document.querySelectorAll("a[href]"))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => h.includes("eventbrite.com/e/")),
      )],
    );
    log(SOURCE, `  Found ${urls.length} event links`);
    ebUrls.push(...urls);
  }

  const uniqueUrls = [...new Set(ebUrls)];
  log(SOURCE, `Total unique event URLs: ${uniqueUrls.length}`);

  if (uniqueUrls.length === 0) {
    log(SOURCE, "  (Eventbrite often has no Beijing listings — skipping detail pass.)");
    return;
  }

  for (const url of uniqueUrls.slice(0, EVENTBRITE_LIMIT)) {
    if (circuitTripped) return;
    if (!(await safeGoto(url))) continue;
    const r = await trackedExtract(() => stagehand.extract(DETAIL_PROMPT, detailSchema));
    if (r.ok) {
      recordCandidate({ ...r.value, url, source: SOURCE }, SOURCE);
    } else {
      log(SOURCE, `  ⚠ Extract failed for ${url.slice(0, 80)} — ${r.error instanceof Error ? r.error.message : String(r.error)}`);
    }
  }
}

async function scrapeListingPage(
  source: string,
  url: string,
  preWaitMs = 2000,
): Promise<void> {
  log(source, `Loading ${url}`);
  if (!(await safeGoto(url))) return;
  await page!.waitForTimeout(preWaitMs);

  const r = await trackedExtract(() => stagehand.extract(LISTING_PROMPT, listingSchema));
  if (!r.ok) {
    log(source, `  Listing extract failed: ${r.error instanceof Error ? r.error.message : String(r.error)}`);
    return;
  }
  const listing = r.value;
  log(source, `Found ${listing.events.length} events`);

  for (const event of listing.events) {
    recordCandidate(
      {
        name: event.name,
        nameEnglish: event.nameEnglish || event.name,
        date: event.date,
        timeAndLocation: event.time,
        likelihood: event.likelihood,
        reasoning: event.reasoning,
        foodAndDrinks: event.foodAndDrinks,
        url,
        source,
      },
      source,
    );
  }
}

async function scrapeMeetup(): Promise<void> {
  await scrapeListingPage(
    "Meetup",
    "https://www.meetup.com/find/?location=cn--Beijing&source=EVENTS&categoryId=546",
  );
}

async function scrapeHuodongxing(): Promise<void> {
  await scrapeListingPage(
    "活动行",
    "https://www.huodongxing.com/eventlist?citycode=bj&orderby=n&tag=%E7%A7%91%E6%8A%80%E4%BA%92%E8%81%94%E7%BD%91",
  );
}

async function scrapeDouban(): Promise<void> {
  await scrapeListingPage(
    "豆瓣",
    "https://www.douban.com/location/beijing/events/future-ede/",
  );
}

// ── Main ────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`  🍕 FREE FOOD BEIJING — ${TODAY}`);
console.log(
  `  Model: ${RAW_MODEL} (via ${ROUTE === "anthropic" ? "Anthropic direct" : "OpenRouter"})`,
);
console.log(`  Scanning English & Chinese web for free food events...`);
console.log(`${"═".repeat(60)}\n`);

// Each scraper is isolated — one failing source must not skip the others.
async function runScraper(label: string, fn: () => Promise<void>): Promise<void> {
  if (circuitTripped) {
    console.log(`  [${label}] skipped — circuit breaker tripped earlier.`);
    return;
  }
  try {
    await fn();
  } catch (e) {
    console.error(`\n⚠ [${label}] failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Wrap every stagehand.extract call so failures count toward the circuit
// breaker and successes reset it.
async function trackedExtract<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    const value = await fn();
    noteExtractionResult(true);
    return { ok: true, value };
  } catch (error) {
    noteExtractionResult(false);
    return { ok: false, error };
  }
}

// Platforms run first because they're cheap & reliable (one listing-page extract
// each). The web-search phase visits N detail pages and is the most likely to
// blow through a Browserbase session budget — putting it last means a session
// timeout still leaves us with usable platform results.
try {
  console.log("── Phase 1: English-language platforms ─────────────────");
  await runScraper("Luma", scrapeLuma);
  await runScraper("Eventbrite", scrapeEventbrite);
  await runScraper("Meetup", scrapeMeetup);

  console.log("\n── Phase 2: Chinese-language platforms ─────────────────");
  await runScraper("Huodongxing", scrapeHuodongxing);
  await runScraper("Douban", scrapeDouban);

  console.log("\n── Phase 3: Targeted web search (EN + CN) ──────────────");
  await runScraper("Web Search", searchWebForFreeFood);
} finally {
  const all = dedup(results).sort((a, b) => b.likelihood - a.likelihood);
  const high = all.filter((e) => e.likelihood >= MIN_LIKELIHOOD);

  // Choose what to display: prefer high-confidence; fall back to top-N candidates
  // so the user always sees the best of what's out there.
  let final: ScoredEvent[];
  let usingFallback = false;
  if (high.length > 0) {
    final = high;
  } else {
    final = all.slice(0, ALWAYS_SHOW_TOP_N);
    usingFallback = true;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🍕 BEIJING FREE FOOD EVENTS — RANKED BY LIKELIHOOD`);
  console.log(`  ${final.length} events across ${new Set(final.map((e) => e.source)).size} sources`);
  if (usingFallback) {
    console.log(`  ⚠ No events met the ${MIN_LIKELIHOOD}% threshold — showing top ${final.length} candidates anyway.`);
  }
  console.log(`${"═".repeat(60)}\n`);

  if (final.length === 0) {
    console.log("  No upcoming events found.");
    if (circuitTripped) {
      console.log(`  Root cause: model "${RAW_MODEL}" failed every extraction.`);
      console.log("  Free OpenRouter tiers come and go — when they return errors,");
      console.log("  the rest of this app can't help. Pick one of these:");
      console.log("   • Best:   set ANTHROPIC_API_KEY in .env (no OpenRouter detour)");
      console.log("   • Cheap:  top up OpenRouter $5 + set OPENROUTER_MODEL=anthropic/claude-haiku-4-5");
      console.log("   • Free:   browse https://openrouter.ai/models?max_price=0 for a working free model");
      console.log("            and set OPENROUTER_MODEL=<that model id>");
    } else {
      console.log("  Possible causes:");
      console.log("   • Browserbase rate limit / session timeout");
      console.log("   • All scraper pages failed to load (check per-source logs above)");
    }
    console.log("");
  } else {
    final.forEach((e, i) => {
      const pct = `${e.likelihood}%`.padStart(4);
      const grade =
        e.likelihood >= 90 ? "🟢" :
        e.likelihood >= 70 ? "🔵" :
        e.likelihood >= 50 ? "🟡" :
        e.likelihood >= 30 ? "🟠" :
        "⚪";

      console.log(`${grade} ${i + 1}. [${pct}] ${e.nameEnglish}`);
      if (e.name !== e.nameEnglish) {
        console.log(`        📛 ${e.name}`);
      }
      console.log(`        🕐 ${e.timeAndLocation || e.date}`);
      if (e.foodAndDrinks) console.log(`        🍽️  ${e.foodAndDrinks}`);
      console.log(`        💭 ${e.reasoning}`);
      console.log(`        📡 Source: ${e.source}`);
      console.log(`        🔗 ${e.url}`);
      console.log();
    });

    console.log("─".repeat(60));
    console.log("  🟢 90%+ Confirmed   🔵 70-89% Very likely   🟡 50-69% Probable");
    console.log("  🟠 30-49% Possible  ⚪ <30% Long shot (fallback)");
    console.log("─".repeat(60));
    console.log();
  }

  try { await stagehand.close(); } catch { /* ignore */ }
}
