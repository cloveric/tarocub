# TaroCub agent skills

Opt-in skills the bots' engines (Claude Code / Codex) can use. Each skill is a
`SKILL.md` discovered from the **user-level** skill dirs (`~/.claude/skills/` and
`~/.codex/skills/`), so **every bot — including newly-created instances —
inherits it** with no per-instance setup.

The files here are the source of truth (version-controlled); an install script
copies each into both engine skill dirs and sets up any prerequisites.

## scrapling — anti-bot web scraping

Cloudflare/Turnstile bypass, stealth + JS-render + spider crawl, via the
`scrapling` CLI. The bot escalates to it when `web_extract` is blocked or the
page is dynamic/protected (the routing ladder lives in the skill's "When to use"
section). Install / update:

```bash
bash scripts/install-scrapling.sh
```

(creates a Python venv, installs Scrapling + browser deps, symlinks `scrapling`
onto PATH, copies the skill into both engines). The fetching reference is adapted
from the [Hermes-agent](https://github.com/NousResearch/hermes-agent) `scrapling`
skill (MIT); the tool-routing section is TaroCub-specific.
