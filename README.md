# Trends Extension for pi

A Google Trends tool that gives your coding assistant the ability to get current and recent trends, compare interest over time, and find what's hot right now with source articles.

## Quick Start

### Install the extension
```bash
pi install git:github.com/John-Dekka/pi-trends
```

That's it. Your assistant can now pull Trends data. No API key, no pytrends, no setup.

## What It Is

Trends is an extension for [pi](https://pi.dev) that adds Google Trends capabilities to your coding assistant. It was created by pi itself. Yes, the clanker wrote this extension. 🥳

When you need to know what people actually care about right now, your assistant can now check search interest, compare keywords, resolve entities to topics, and list daily trending searches with news citations. No more "my knowledge ends in [date]" explanations. Just numbers.

## How It Works

Using Trends is simple:

1. **Copy the extension** to your pi extensions folder
2. **No API key needed** - it talks directly to Google Trends, same as your browser
3. **Use the tools** in your prompts with any keyword or region
4. **Get results** - interest over time, top regions, related queries, trending searches with articles

The extension automatically:

- **Looks like Chrome, not a scraper** - Warms up session cookies and sends real browser headers so Google doesn't flag it
- **Paces itself** - Sleeps between requests like a human clicking through the UI, backs off on 429s instead of hammering
- **Returns LLM-ready numbers** - Downsamples timelines to ~52 points, summarizes avg/peak/trend so you don't burn context on 300 datapoints
- **Handles failures gracefully** - One flaky widget doesn't kill the run. Rate-limit errors tell you to wait instead of retry-looping into a longer ban
- **Limits results sensibly** - Default 10 regions/queries, max 25. Enough to be useful without overwhelming

## Why It's Really Good

### No Dependencies That Die

pytrends is dead. SerpApi costs money. This extension uses plain `fetch` against Google's own `widgetdata` endpoints - the same token dance the Trends website does. Zero npm dependencies beyond pi itself.

### Keywords AND Topics, Compared Properly

Literal strings (`Kamillentee`) are spelling-sensitive. Topic ids (`/g/xxx`) group every spelling and language of an entity. Use `trends_suggest` to resolve, then `trends` with up to 5 items on one shared 0-100 scale.

### Trending Now Included

No keyword needed. `trends_trending` returns daily trending searches and last-24h realtime stories per country, with traffic numbers and linked news articles. Your harness can poll "what's hot" without knowing what to ask about.

### Resilient Fetching

Session warmup, Chrome headers, paced requests, retry with backoff on 429/5xx. If Google still blocks your IP, you get a clear "wait 30-60min" message instead of garbage. Your workflow keeps flowing.

### Created by pi

This extension was written by pi itself. It saw a need, wrote the code, and now it's part of the ecosystem.

## Tools

| Tool | What it does |
|------|--------------|
| `trends` | Interest over time + top regions + related top/rising for 1-5 keywords or topic ids. Params: `keywords`, `geo`, `timeframe`, `category`, `property`, `maxPoints`, `topN`, `format` |
| `trends_suggest` | Resolve a keyword to topic ids (`/m/xxx`, `/g/xxx`). Params: `keyword`, `hl` |
| `trends_trending` | Current trending searches for a region. Params: `geo`, `mode` (`daily`/`realtime`/`both`), `limit`, `hl` |

Timeframes: `all`, `today 12-m`, `today 5-y`, `today 3-m`, `today 7-d`, `now 1-d`, or `2024-01-01 2024-12-31`. Geo: 2-letter code (`US`, `DE`), or empty/`worldwide` for global (daily trends needs a country).

## Requirements

- [pi](https://pi.dev) coding agent
- Node.js that supports ES modules (fetch, no extra deps)
- No API key. Google Trends is free, rate-limited per IP

## License

MIT - Use it, share it, make it better. ♥️
