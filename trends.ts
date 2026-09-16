/**
 * Trends Extension for pi
 *
 * Google Trends without pytrends (dead) and without API keys.
 * Gives your harness current and recent trends: interest over time,
 * top regions, related queries/topics, topic autocomplete, and
 * daily / realtime trending searches.
 *
 * Usage:
 * 1. Copy to ~/.pi/agent/extensions/trends.ts or .pi/extensions/trends.ts
 * 2. No API key, no config. Just use the tools.
 * 3. If Google 429s you, wait 30-60min. Don't loop - you'll extend the ban.
 */

import type { ExtensionAPI, TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

// ============
// Types
// ============

interface TimelinePoint {
	date: string;
	value?: number;
	values?: Record<string, number>;
}

interface TrendsSummary {
	avg?: number;
	peak?: number;
	peak_date?: string;
	last_value?: number;
	n_points?: number;
	trend?: string;
	averages_shared_scale?: Record<string, number>;
	note?: string;
}

interface LlmPayload {
	keywords: string[];
	labels: string[];
	geo: string;
	timeframe: string;
	category: number;
	property: string;
	summary: TrendsSummary;
	interest_over_time_sampled: TimelinePoint[];
	top_regions: { region: string; code: string; value: number }[];
	related_top: { q: string; value: number | string }[];
	related_rising: { q: string; growth: string }[];
}

interface TrendsDetails extends LlmPayload {
	format: string;
	truncation?: TruncationResult;
}

interface SuggestDetails {
	keyword: string;
	topics: { mid: string; title: string; type: string }[];
	truncation?: TruncationResult;
}

interface TrendingItem {
	query: string;
	traffic?: string;
	relatedQueries?: string[];
	articles?: { title: string; url: string; source: string }[];
	image?: string;
}

interface TrendingDetails {
	geo: string;
	mode: string;
	date?: string;
	items: TrendingItem[];
	truncation?: TruncationResult;
}

// ============
// Session + HTTP
// ============

interface TrendSession {
	cookies: Map<string, string>;
	hl: string;
}

const BASE_HEADERS = (hl: string): Record<string, string> => ({
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	Accept: "application/json, text/plain, */*",
	"Accept-Language": `${hl},${hl.split("-")[0]};q=0.9,en;q=0.8`,
	Referer: "https://trends.google.com/trends/explore",
	Origin: "https://trends.google.com",
	"Sec-Ch-Ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
	"Sec-Ch-Ua-Mobile": "?0",
	"Sec-Ch-Ua-Platform": '"Windows"',
	"Sec-Fetch-Dest": "empty",
	"Sec-Fetch-Mode": "cors",
	"Sec-Fetch-Site": "same-origin",
});

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(() => resolve(), ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(new Error("aborted"));
		}, { once: true });
	});
}

function stripGoogleJson(text: string): any {
	// Google prefixes every JSON response with )]}'\n as anti-XSSI
	const clean = text.startsWith(")]}'") ? text.slice(text.indexOf("\n") + 1) : text;
	return JSON.parse(clean);
}

function cookieHeader(s: TrendSession): string {
	return [...s.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(s: TrendSession, res: Response): void {
	// fetch exposes set-cookie via getSetCookie() (undici) or raw header
	const getSetCookie = (res.headers as any).getSetCookie?.bind(res.headers) as (() => string[]) | undefined;
	const raw: string[] = getSetCookie
		? getSetCookie()
		: res.headers.get("set-cookie")?.split(/,(?=[^;,]+=[^;,]*;)/) ?? [];
	for (const c of raw) {
		const pair = c.split(";")[0];
		const eq = pair.indexOf("=");
		if (eq > 0) s.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
}

async function trendGet(
	s: TrendSession,
	url: string,
	params: Record<string, string>,
	signal?: AbortSignal,
	retries = 3,
): Promise<Response> {
	const backoffs = [3000, 8000, 20000];
	let lastStatus = 0;
	let lastBody = "";
	for (let i = 0; i <= retries; i++) {
		const qs = new URLSearchParams(params).toString();
		const res = await fetch(`${url}?${qs}`, {
			headers: { ...BASE_HEADERS(s.hl), ...(s.cookies.size ? { Cookie: cookieHeader(s) } : {}) },
			signal,
		});
		storeCookies(s, res);
		if (res.status === 200) return res;
		lastStatus = res.status;
		try { lastBody = (await res.text()).slice(0, 200); } catch { lastBody = ""; }
		if (res.status === 429) {
			if (i === retries) break;
			await sleep(backoffs[Math.min(i, backoffs.length - 1)], signal);
			continue;
		}
		if ([500, 502, 503].includes(res.status)) {
			if (i === retries) break;
			await sleep(1000 * 2 ** i + 1000, signal);
			continue;
		}
		throw new Error(`Google Trends ${res.status}: ${lastBody || res.statusText}`);
	}
	if (lastStatus === 429) {
		throw new Error(
			"Google 429 rate-limit. IP temporarily blocked (30-60min typical). Don't retry in a loop - you'll extend the ban.",
		);
	}
	throw new Error(`Google Trends ${lastStatus}: ${lastBody || "request failed"}`);
}

async function warmup(s: TrendSession, keyword = "Taylor Swift", geo = "US", signal?: AbortSignal): Promise<void> {
	// Google refuses IPs without session cookie. Must visit home + explore first.
	const urls = [
		"https://trends.google.com/",
		"https://trends.google.com/trends",
		`https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}&geo=${encodeURIComponent(geo)}`,
	];
	for (const u of urls) {
		try {
			const res = await fetch(u, {
				headers: { ...BASE_HEADERS(s.hl), ...(s.cookies.size ? { Cookie: cookieHeader(s) } : {}) },
				signal,
			});
			storeCookies(s, res);
			await sleep(1000, signal);
		} catch {
			// warmup failures are non-fatal
		}
	}
}

function normGeo(geo: string | undefined): string {
	// Google wants "" for worldwide, not "Worldwide". Be liberal in what we accept.
	if (!geo) return "";
	const g = geo.trim();
	if (["", "worldwide", "world", "global", "ww", "all"].includes(g.toLowerCase())) return "";
	return g.length === 2 ? g.toUpperCase() : g;
}

const GPROP_MAP: Record<string, string> = {
	web: "",
	youtube: "youtube",
	news: "news",
	images: "images",
	shopping: "froogle",
	froogle: "froogle",
};

function normProp(gprop: string | undefined): string {
	return GPROP_MAP[(gprop || "web").trim().toLowerCase()] ?? "";
}

// ============
// Core fetchers
// ============

async function suggestTopics(
	keyword: string,
	hl = "en-US",
	tz = -120,
	signal?: AbortSignal,
): Promise<{ mid: string; title: string; type: string }[]> {
	const s: TrendSession = { cookies: new Map(), hl };
	await warmup(s, keyword, "US", signal);
	const res = await trendGet(
		s,
		`https://trends.google.com/trends/api/autocomplete/${encodeURIComponent(keyword)}`,
		{ hl, tz: String(tz) },
		signal,
	);
	return stripGoogleJson(await res.text()).default?.topics ?? [];
}

interface RawTrends {
	keywords: string[];
	geo: string;
	timeframe: string;
	category: number;
	property: string;
	widgets: Record<string, any>;
}

async function fetchTrends(
	keywords: string[],
	geo: string,
	timeframe: string,
	hl: string,
	tz: number,
	category: number,
	gprop: string,
	signal?: AbortSignal,
): Promise<RawTrends> {
	const geoN = normGeo(geo);
	const prop = normProp(gprop);
	const s: TrendSession = { cookies: new Map(), hl };
	const warmupKw = keywords.find((k) => !k.startsWith("/m/") && !k.startsWith("/g/")) ?? keywords[0];
	await warmup(s, warmupKw, geoN || "US", signal);

	const req = {
		comparisonItem: keywords.map((k) => ({ keyword: k, geo: geoN, time: timeframe })),
		category,
		property: prop,
	};
	const exploreRes = await trendGet(
		s,
		"https://trends.google.com/trends/api/explore",
		{ hl, tz: String(tz), req: JSON.stringify(req) },
		signal,
	);
	const widgets: any[] = stripGoogleJson(await exploreRes.text()).widgets ?? [];

	const ENDPOINTS: Record<string, string> = {
		TIMESERIES: "multiline",
		GEO_MAP: "comparedgeo",
		RELATED_TOPICS: "relatedsearches",
		RELATED_QUERIES: "relatedsearches",
	};

	const out: RawTrends = {
		keywords,
		geo: geoN,
		timeframe,
		category,
		property: prop || "web",
		widgets: {},
	};

	await sleep(2000, signal); // explore -> widgetdata with 0 delay = flag
	for (const w of widgets) {
		const endpoint = ENDPOINTS[w.id];
		if (!endpoint) continue;
		try {
			const r = await trendGet(
				s,
				`https://trends.google.com/trends/api/widgetdata/${endpoint}`,
				{ hl, tz: String(tz), req: JSON.stringify(w.request), token: w.token },
				signal,
			);
			out.widgets[w.id] = stripGoogleJson(await r.text());
		} catch (e: any) {
			if (w.id === "TIMESERIES") throw e; // fatal, rest aren't
		}
		await sleep(2000, signal); // pacing or you eat a 429
	}
	if (!out.widgets.TIMESERIES) {
		if (keywords.some((k) => k.startsWith("/m/") || k.startsWith("/g/"))) {
			throw new Error("No TIMESERIES - topic has ~zero volume. Try a literal keyword instead of a topic id.");
		}
		throw new Error("TIMESERIES missing - all widgets blocked. You're rate-limited, stop and wait.");
	}
	return out;
}

function toLlmPayload(raw: RawTrends, maxPoints = 52, topN = 10): LlmPayload {
	const kw = raw.keywords;
	const single = kw.length === 1;
	const tl: any[] = raw.widgets.TIMESERIES?.default?.timelineData ?? [];

	let series: TimelinePoint[] = [];
	let summary: TrendsSummary = {};

	if (single) {
		const vals: number[] = tl.map((p) => p.value?.[0]).filter((v) => typeof v === "number");
		const step = Math.max(1, Math.floor(vals.length / maxPoints));
		series = [];
		for (let i = 0; i < tl.length; i += step) {
			if (typeof tl[i].value?.[0] !== "number") continue;
			series.push({ date: tl[i].formattedTime, value: tl[i].value[0] });
		}
		if (vals.length) {
			const peakI = vals.indexOf(Math.max(...vals));
			const tail = vals.length >= 12 ? vals.slice(-12) : vals;
			const tailAvg = tail.reduce((a, b) => a + b, 0) / tail.length;
			summary = {
				avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10,
				peak: Math.max(...vals),
				peak_date: tl[peakI]?.formattedTime,
				last_value: vals[vals.length - 1],
				n_points: vals.length,
				trend: vals[vals.length - 1] > tailAvg ? "up" : "down/flat",
			};
		}
	} else {
		const step = Math.max(1, Math.floor(tl.length / maxPoints));
		for (let i = 0; i < tl.length; i += step) {
			const p = tl[i];
			const values: Record<string, number> = {};
			kw.forEach((k, idx) => { values[k] = p.value?.[idx] ?? 0; });
			series.push({ date: p.formattedTime, values });
		}
		const avgs: Record<string, number> = {};
		kw.forEach((k, idx) => {
			const v = tl.map((p) => p.value?.[idx]).filter((x) => typeof x === "number");
			avgs[k] = v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0;
		});
		summary = {
			averages_shared_scale: avgs,
			n_points: tl.length,
			note: "comparison values share one 0-100 scale; single-keyword values do not",
		};
	}

	const regions = [...(raw.widgets.GEO_MAP?.default?.geoMapData ?? [])]
		.sort((a, b) => (a.value?.[0] ?? 0) - (b.value?.[0] ?? 0))
		.reverse()
		.slice(0, topN);

	let ranked: any[] = raw.widgets.RELATED_QUERIES?.default?.rankedList ?? [];
	if (!ranked.length || !ranked.some((r) => r.rankedKeyword?.length)) {
		// fallback to RELATED_TOPICS (common for low-volume terms)
		ranked = raw.widgets.RELATED_TOPICS?.default?.rankedList ?? [];
	}
	const topQ: any[] = ranked[0]?.rankedKeyword?.slice(0, topN) ?? [];
	const risingQ: any[] = ranked[1]?.rankedKeyword?.slice(0, topN) ?? [];

	const label = (k: string) => (k.startsWith("/m/") || k.startsWith("/g/") ? `${k} (topic)` : k);

	return {
		keywords: kw,
		labels: kw.map(label),
		geo: raw.geo || "WW (worldwide)",
		timeframe: raw.timeframe,
		category: raw.category,
		property: raw.property,
		summary,
		interest_over_time_sampled: series,
		top_regions: regions.map((r) => ({ region: r.geoName, code: r.geoCode, value: r.value?.[0] ?? 0 })),
		related_top: topQ.map((x) => ({ q: x.query, value: x.value })),
		related_rising: risingQ.map((x) => ({ q: x.query, growth: x.formattedValue })),
	};
}

function toMarkdown(p: LlmPayload): string {
	const kw = p.labels.join(", ");
	const L: string[] = [
		`# Trends: ${kw} (${p.geo} / ${p.timeframe} / cat=${p.category} / ${p.property})`,
		"",
		`Summary: ${JSON.stringify(p.summary)}`,
		"",
		"## Interest over time (sampled, 0-100 relative, 100=peak of window)",
	];
	for (const pt of p.interest_over_time_sampled) {
		L.push(`- ${pt.date}: ${JSON.stringify(pt.value ?? pt.values)}`);
	}
	L.push("", "## Top regions");
	L.push(...(p.top_regions.map((r) => `- ${r.region}: ${r.value}`) || []));
	if (!p.top_regions.length) L.push("- n/a");
	L.push("", "## Related top");
	L.push(...(p.related_top.map((x) => `- ${x.q} (${x.value})`) || []));
	if (!p.related_top.length) L.push("- n/a");
	L.push("", "## Related rising (Breakout = >5000% spike)");
	L.push(...(p.related_rising.map((x) => `- ${x.q} (${x.growth})`) || []));
	if (!p.related_rising.length) L.push("- n/a");
	return L.join("\n");
}

// ============
// Trending now (daily + realtime) - for "current and recent trends"
// ============

async function fetchDailyTrends(
	geo: string,
	hl = "en-US",
	tz = -120,
	signal?: AbortSignal,
): Promise<{ date: string; items: TrendingItem[] }> {
	const s: TrendSession = { cookies: new Map(), hl };
	await warmup(s, "Taylor Swift", geo || "US", signal);
	const res = await trendGet(
		s,
		"https://trends.google.com/trends/api/dailytrends",
		{ hl, tz: String(tz), geo: normGeo(geo) || "US" },
		signal,
	);
	const data = stripGoogleJson(await res.text());
	const days: any[] = data.default?.trendingSearchesDays ?? [];
	const out: TrendingItem[] = [];
	let date = "";
	for (const d of days) {
		date = d.date || date;
		for (const t of d.trendingSearches ?? []) {
			out.push({
				query: t.title?.query ?? "",
				traffic: t.formattedTraffic,
				relatedQueries: (t.relatedQueries ?? []).map((q: any) => q.query).filter(Boolean),
				articles: (t.articles ?? []).map((a: any) => ({ title: a.title, url: a.url, source: a.source })),
				image: t.image?.imageUrl,
			});
		}
	}
	return { date, items: out };
}

async function fetchRealtimeTrends(
	geo: string,
	hl = "en-US",
	tz = -120,
	category = "all",
	signal?: AbortSignal,
): Promise<TrendingItem[]> {
	const s: TrendSession = { cookies: new Map(), hl };
	await warmup(s, "Taylor Swift", geo || "US", signal);
	const res = await trendGet(
		s,
		"https://trends.google.com/trends/api/realtimetrends",
		{
			hl, tz: String(tz), cat: category, fi: "0", fs: "0",
			geo: normGeo(geo) || "US", ri: "300", rs: "20", sort: "0",
		},
		signal,
	);
	const stories: any[] = stripGoogleJson(await res.text()).storySummaries?.trendingStories ?? [];
	return stories.map((st) => ({
		query: st.title ?? "",
		relatedQueries: (st.entityNames ?? []).filter(Boolean),
		articles: (st.articles ?? []).map((a: any) => ({ title: a.articleTitle, url: a.url, source: a.source })),
		image: st.image?.imgUrl,
	}));
}

function formatTrending(items: TrendingItem[], limit: number): string {
	if (!items.length) return "No trending searches found.";
	const shown = items.slice(0, limit);
	let out = `Trending now (${shown.length} of ${items.length}):\n\n`;
	shown.forEach((t, i) => {
		out += `${i + 1}. ${t.query}${t.traffic ? ` (${t.traffic} searches)` : ""}\n`;
		if (t.relatedQueries?.length) out += `   related: ${t.relatedQueries.slice(0, 5).join(", ")}\n`;
		for (const a of (t.articles ?? []).slice(0, 2)) out += `   - ${a.title} [${a.source}] ${a.url}\n`;
	});
	return out;
}

// ============
// Main Extension
// ============

export default function trendsExtension(pi: ExtensionAPI) {
	// ---- trends: interest over time + regions + related ----
	pi.registerTool({
		name: "trends",
		label: "Google Trends",
		description:
			"Look up Google Trends interest for 1-5 keywords or topic ids. Returns LLM-ready summary: interest over time (sampled 0-100), top regions, related top/rising queries. Keywords are literal strings; /m/xxx or /g/xxx ids are semantic topics (resolve via trends_suggest first). Use for current and recent trend analysis, comparisons, seasonality.",

		parameters: Type.Object({
			keywords: Type.Array(Type.String(), {
				description: "1-5 keywords to look up. Literal strings ('Kamillentee') or topic ids ('/g/123xyz'). Multiple = comparison on shared 0-100 scale.",
			}),
			geo: Type.Optional(Type.String({
				description: "Region: 2-letter code ('US','DE'), '' or 'worldwide' for global. Default 'US'.",
			})),
			timeframe: Type.Optional(Type.String({
				description: "Window: 'all', 'today 12-m' (default), 'today 5-y', 'today 3-m', 'today 7-d', 'now 1-d', or '2024-01-01 2024-12-31'.",
			})),
			category: Type.Optional(Type.Number({
				description: "Category id, 0=all (default). e.g. 71=Food&Drink, 45=Health. From the Trends UI dropdown value.",
			})),
			property: Type.Optional(Type.String({
				description: "Google property: web (default), youtube, news, images, shopping.",
			})),
			hl: Type.Optional(Type.String({ description: "UI language, e.g. 'en-US' (default), 'de-DE'." })),
			maxPoints: Type.Optional(Type.Number({ description: "Downsample timeline to this many points (default 52, max 200)." })),
			topN: Type.Optional(Type.Number({ description: "Top regions / related queries to return (default 10, max 25)." })),
			format: Type.Optional(Type.String({ description: "Output text style: json (default), md, both." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const keywords = params.keywords as string[];
			if (!keywords?.length) throw new Error("Need at least 1 keyword.");
			if (keywords.length > 5) throw new Error("Max 5 keywords total (Google limit).");
			const geo = (params.geo as string | undefined) ?? "US";
			const timeframe = (params.timeframe as string | undefined) ?? "today 12-m";
			const category = Math.floor((params.category as number | undefined) ?? 0);
			const property = (params.property as string | undefined) ?? "web";
			const hl = (params.hl as string | undefined) ?? "en-US";
			const maxPoints = Math.min(Math.max(Math.floor((params.maxPoints as number | undefined) ?? 52), 5), 200);
			const topN = Math.min(Math.max(Math.floor((params.topN as number | undefined) ?? 10), 1), 25);
			const format = ((params.format as string | undefined) ?? "json").toLowerCase();

			const raw = await fetchTrends(keywords, geo, timeframe, hl, -120, category, property, signal);
			const payload = toLlmPayload(raw, maxPoints, topN);

			let text: string;
			if (format === "md") text = toMarkdown(payload);
			else if (format === "both") text = `${JSON.stringify(payload, null, 2)}\n\n<!-- MARKDOWN -->\n\n${toMarkdown(payload)}`;
			else text = JSON.stringify(payload, null, 2);

			const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const details: TrendsDetails = { ...payload, format };
			let resultText = truncation.content;
			if (truncation.truncated) {
				details.truncation = truncation;
				resultText += `\n\n[Truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full payload in details.]`;
			}
			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			const kw = Array.isArray(args.keywords) ? args.keywords.join(", ") : String(args.keywords ?? "");
			let text = theme.fg("toolTitle", theme.bold("trends "));
			text += theme.fg("accent", `"${kw}"`);
			if (args.geo) text += theme.fg("dim", ` ${args.geo}`);
			if (args.timeframe) text += theme.fg("dim", ` ${args.timeframe}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching trends..."), 0, 0);
			const details = result.details as TrendsDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No trend data"), 0, 0);
			let text = theme.fg("success", details.labels.join(" vs "));
			text += theme.fg("dim", ` (${details.geo} / ${details.timeframe})`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const s = details.summary;
				text += `\n${theme.fg("muted", JSON.stringify(s))}`;
				for (const r of details.top_regions.slice(0, 3)) {
					text += `\n${theme.fg("accent", r.region)}: ${theme.fg("dim", String(r.value))}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// ---- trends_suggest: keyword -> topic ids ----
	pi.registerTool({
		name: "trends_suggest",
		label: "Trends Suggest",
		description:
			"Resolve a keyword to Google Trends semantic topic ids (/m/xxx, /g/xxx). Topics group all spellings/languages of an entity. Use before trends when you need entity-level volume instead of a literal string match.",

		parameters: Type.Object({
			keyword: Type.String({ description: "Keyword to resolve, e.g. 'Kamillentee', 'Taylor Swift'." }),
			hl: Type.Optional(Type.String({ description: "UI language, e.g. 'en-US' (default), 'de-DE'." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const keyword = params.keyword as string;
			const hl = (params.hl as string | undefined) ?? "en-US";
			if (!keyword?.trim()) throw new Error("Need a keyword.");
			const topics = await suggestTopics(keyword.trim(), hl, -120, signal);
			const text = topics.length
				? `Topics for "${keyword}":\n` + topics.map((t) => `- ${t.mid}  ${t.title}  [${t.type}]`).join("\n")
					+ (topics[0] ? `\n\nUse: trends with keywords=["${topics[0].mid}"]` : "")
				: `No topics found for '${keyword}' - use trends with a literal keyword instead.`;
			const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const details: SuggestDetails = { keyword, topics };
			let resultText = truncation.content;
			if (truncation.truncated) details.truncation = truncation;
			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("trends_suggest ")) + theme.fg("accent", `"${args.keyword}"`),
				0, 0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Resolving topics..."), 0, 0);
			const details = result.details as SuggestDetails | undefined;
			if (!details || !details.topics.length) return new Text(theme.fg("dim", "No topics found"), 0, 0);
			return new Text(theme.fg("success", `${details.topics.length} topics for "${details.keyword}"`), 0, 0);
		},
	});

	// ---- trends_trending: what's hot right now ----
	pi.registerTool({
		name: "trends_trending",
		label: "Trending Now",
		description:
			"Get current trending searches for a region: what people are searching RIGHT NOW (daily trends) plus last-24h realtime stories. Use when the harness needs current/recent trends without a specific keyword. No keyword needed.",

		parameters: Type.Object({
			geo: Type.Optional(Type.String({
				description: "Region: 2-letter code. Default 'US'. Daily trends needs a country (no worldwide).",
			})),
			mode: Type.Optional(Type.String({
				description: "daily (default, top searches per day), realtime (last 24h stories), both.",
			})),
			limit: Type.Optional(Type.Number({ description: "Max items to return in text (default 20, max 50)." })),
			hl: Type.Optional(Type.String({ description: "UI language, e.g. 'en-US' (default), 'de-DE'." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const geo = (params.geo as string | undefined) ?? "US";
			const mode = ((params.mode as string | undefined) ?? "daily").toLowerCase();
			const limit = Math.min(Math.max(Math.floor((params.limit as number | undefined) ?? 20), 1), 50);
			const hl = (params.hl as string | undefined) ?? "en-US";
			if (!["daily", "realtime", "both"].includes(mode)) throw new Error("mode must be daily, realtime, or both.");

			let items: TrendingItem[] = [];
			let date = "";
			if (mode === "daily" || mode === "both") {
				const d = await fetchDailyTrends(geo, hl, -120, signal);
				date = d.date;
				items.push(...d.items);
			}
			if (mode === "realtime" || mode === "both") {
				const rt = await fetchRealtimeTrends(geo, hl, -120, "all", signal);
				// tag realtime queries so the harness can tell sources apart
				for (const t of rt) if (!items.some((x) => x.query === t.query)) items.push(t);
			}
			if (mode === "both" && items.length > 50) items = items.slice(0, 50);

			const text = (date ? `Trending in ${normGeo(geo) || "US"} (${date}, ${mode}):\n\n` : `Trending in ${normGeo(geo) || "US"} (${mode}):\n\n`)
				+ formatTrending(items, limit);

			const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const details: TrendingDetails = { geo: normGeo(geo) || "US", mode, date, items: items.slice(0, 50) };
			let resultText = truncation.content;
			if (truncation.truncated) {
				details.truncation = truncation;
				resultText += `\n\n[Truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. Full list in details.]`;
			}
			return { content: [{ type: "text", text: resultText }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("trends_trending "));
			text += theme.fg("accent", `${args.geo ?? "US"}`);
			if (args.mode) text += theme.fg("dim", ` ${args.mode}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching trending..."), 0, 0);
			const details = result.details as TrendingDetails | undefined;
			if (!details || !details.items.length) return new Text(theme.fg("dim", "No trending searches"), 0, 0);
			let text = theme.fg("success", `${details.items.length} trending in ${details.geo}`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				for (const t of details.items.slice(0, 3)) {
					text += `\n${theme.fg("accent", t.query)}${t.traffic ? theme.fg("dim", ` (${t.traffic})`) : ""}`;
				}
				if (details.items.length > 3) text += `\n${theme.fg("muted", `... and ${details.items.length - 3} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
