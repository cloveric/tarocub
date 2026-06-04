---
name: scrapling
description: Web scraping that gets past anti-bot — HTTP fetch / stealth (Cloudflare bypass) / JS-render / spider crawl, via the `scrapling` CLI. Use when web_extract is blocked or returns empty, or to scrape a protected/dynamic site or crawl many pages. Triggers: scrape / crawl a site, "scrape this page", "the site blocks bots / anti-bot", "bypass Cloudflare", a dynamic/JS page web_extract can't read; 爬 / 爬虫 / 抓取 / 爬一下 / 抓一下这个网站 / 这个站爬不动 / 反爬 / 绕过反爬 / 绕过 Cloudflare / 动态页抓不到 / 批量抓取.
---

# Scrapling — anti-bot web scraping (CLI)

[Scrapling](https://github.com/D4Vinci/Scrapling) fetches web pages with anti-bot bypass, stealth (headless) browser automation, JS rendering, and a spider framework. Three strategies: **HTTP** (light, no browser), **dynamic** (runs JS in a browser), **stealth** (Cloudflare / anti-bot). The `scrapling` command is on PATH. Run `scrapling extract <sub> --help` for exact flags.

> Educational/research use. Respect robots.txt and each site's Terms of Service.

## When to use Scrapling (vs the bot's other web tools)

The bot has several ways to read the web — **use the lightest that works, escalate only when it fails**:

1. **Search / "what's the latest" / don't know the URL** → `web_search`.
2. **A normal public page** → `web_extract` (light, no browser). Default for plain pages.
3. **X/Twitter, or any page that needs YOUR login** → the **x-fetch** skill (it uses the logged-in Chrome). Scrapling has **no login session**, so it cannot reach private/logged-in content.
4. **Multi-step interaction** (log in, click through a flow, fill a form, take a screenshot) → the **agent-browser** skill. Scrapling is *fetch-and-extract*, NOT interaction.
5. **Reach for Scrapling when any of these is true:**
   - `web_extract` came back **blocked / a login or captcha wall / a Cloudflare page / suspiciously empty / clearly not the real content** → that is the signal to escalate. Do **not** accept the garbage as the answer.
   - The page is **JS-rendered** and `web_extract` returns an empty shell.
   - You **already know** the site is anti-bot or dynamic (you were told, or it's a known protected site) → go straight to Scrapling; don't waste a doomed `web_extract` first.
   - You need to **crawl many pages / extract structured fields at scale**.

**Match the weight to the task.** Inside Scrapling, prefer the light HTTP `get` for plain pages; only use `stealthy-fetch` (opens a headless browser, +5–15s, hundreds of MB) when actually blocked, and `fetch` (also a browser) when JS rendering is actually needed.

**Don't loop.** If even Scrapling's stealth fetch is blocked (hard anti-bot needing residential proxies / CAPTCHA solving), STOP and report "couldn't get past the anti-bot" — don't retry forever or keep escalating.

**Save tokens.** Always extract just what you need with a selector (`--css-selector '...'`) into a `.md`/`.txt`/`.json` file — do NOT dump full raw HTML into the conversation.

## CLI usage

Output format follows the file extension: `.md` (Markdown), `.txt` (plain text), `.html` (raw HTML), `.json`/`.jsonl`.

```bash
# Static page (HTTP — light, no browser). Add a selector to grab only what you need.
scrapling extract get 'https://example.com' out.md --css-selector '.content' --impersonate chrome

# JS-rendered page (opens a browser to run JS)
scrapling extract fetch 'https://example.com' out.md --css-selector '.dynamic' --network-idle

# Cloudflare / anti-bot protected page (stealth headless browser)
scrapling extract stealthy-fetch 'https://protected-site.com' out.md --solve-cloudflare --block-webrtc

# POST request
scrapling extract post 'https://example.com/api' out.json --json '{"query":"term"}'
```

| Strategy | CLI sub / Python class | Use when |
|---|---|---|
| HTTP | `get` / `Fetcher` | static pages, APIs, fast bulk — no browser |
| Dynamic | `fetch` / `DynamicFetcher` | JS-rendered content, SPAs |
| Stealth | `stealthy-fetch` / `StealthyFetcher` | Cloudflare, anti-bot sites |
| Spider | `Spider` (Python) | multi-page crawl with link-following |

## Python (for selectors, custom automation, spiders)

```python
from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher

page = Fetcher.get('https://quotes.toscrape.com/')             # HTTP (light)
page.css('.quote .text::text').getall()                        # CSS selector
page.xpath('//a/@href').getall()                               # XPath
page.find_by_text('Read more', tag='a')                        # by text

DynamicFetcher.fetch('https://example.com', headless=True, network_idle=True)             # JS render
StealthyFetcher.fetch('https://protected.com', headless=True, solve_cloudflare=True)      # anti-bot
```

Spider — multi-page crawl with pause/resume:
```python
from scrapling.spiders import Spider, Response

class QuotesSpider(Spider):
    name = "quotes"
    start_urls = ["https://quotes.toscrape.com/"]
    concurrent_requests = 10
    download_delay = 1
    async def parse(self, response: Response):
        for q in response.css('.quote'):
            yield {"text": q.css('.text::text').get(), "author": q.css('.author::text').get()}
        nxt = response.css('.next a::attr(href)').get()
        if nxt:
            yield response.follow(nxt)

result = QuotesSpider().start()        # QuotesSpider(crawldir="./chk") → Ctrl+C pauses, re-run resumes
result.items.to_json("out.json")
```

## Pitfalls
- **Browser already installed** here (`scrapling install` was run); `DynamicFetcher`/`StealthyFetcher` need it.
- **Timeouts**: dynamic/stealth are in **milliseconds** (default 30000); HTTP `Fetcher` is in **seconds**.
- **Cloudflare**: `--solve-cloudflare` adds 5–15s — only enable when needed.
- **Resource use**: stealth/dynamic run a real (headless) browser — don't run many at once; for plain pages use HTTP `get`.
- **Python**: 3.10+.

---
*Fetching reference adapted from the Hermes-agent `scrapling` skill (MIT, FEUAZUR); the tool-routing section above is TaroCub-specific.*
