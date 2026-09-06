---
name: reddit
description: Search Reddit and browse subreddit posts using the public JSON API. Use when you need to find Reddit discussions, community reactions, or story leads from specific subreddits.
---

# Reddit

Search Reddit, browse subreddit top posts, and read individual posts with comments. No API key required (from residential IPs).

## Tool

Use `reddit.js` from this skill directory:

```bash
node reddit.js <command> [options]
```

## Commands

### Search all of Reddit
```bash
reddit.js search "query" [-n count] [-t period] [-s sort]
```

### Top posts from a subreddit
```bash
reddit.js top <subreddit> [-n count] [-t period]
```

### Read a post with top comments
```bash
reddit.js post <url> [-c comment_count]
```

## Options

| Flag | Default | Values |
|------|---------|--------|
| `-n` | 10 | Number of results (max 100) |
| `-t` | year | `hour`, `day`, `week`, `month`, `year`, `all` |
| `-s` | top | `relevance`, `hot`, `top`, `new`, `comments` |
| `-c` | 5 | Number of comments to show |

## Output

Each post shows: score, comment count, title, subreddit, author, date, link, and a text preview. The `post` command additionally shows top comments with scores.

## Datacenter-IP block and REDDIT_PROXY

Reddit 403-blocks the public JSON API from datacenter IP ranges (verified from this container on 2026-09-06; `r.jina.ai` is blocked too). On this host, set a proxy before calling the tool:

```bash
REDDIT_PROXY=http://<host>:<port> node reddit.js top homelab -t week
```

Any HTTP proxy with a residential exit works (e.g. a home Clash instance). The error message repeats this hint. From a residential machine the tool works directly with no configuration.

## Notes

- **Rate limiting**: Reddit rate-limits unauthenticated requests. Add a small delay between rapid successive calls if needed.
- **Search relevance**: Global search can be noisy. Subreddit-specific `top` browsing tends to surface better results for niche research.
- **Subreddit names**: Pass without the `r/` prefix (e.g., `cybersecurity` not `r/cybersecurity`).

## Attribution

Ported from amosblomqvist/pi-config `skills/reddit/` (2026-08-25 snapshot). Single deliberate divergence: `REDDIT_PROXY` support (curl transport) for datacenter-blocked networks; everything else byte-faithful.
