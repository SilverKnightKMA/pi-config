---
name: stop-slop
description: Remove AI-writing tells from prose. Use when writing, rewriting, editing, or reviewing docs, READMEs, articles, blog posts, emails, release notes, or any prose that should read as natural, specific, and non-formulaic; not for commit messages or code review.
metadata:
  source: https://github.com/hardikpandya/stop-slop
  source_author: Hardik Pandya
  source_license: MIT
  adapted_by: SilverKnightKMA pi-config
---

# Stop Slop

Remove predictable AI-writing patterns from prose, by rewriting toward specificity — never by thesaurus-swapping flagged words (that launders the slop instead of removing it).

## Scope

- IN: docs, READMEs, articles, posts, emails, release notes, explanations — prose deliverables.
- OUT: commit messages (Conventional Commits is intentional ritual), code, logs.
- Code comments: only substantial explanatory blocks/docstrings; rules 1-5 apply there.

Never let these rules damage accuracy, meaning, safety, quotations, legal/technical terms, or the user's explicitly requested voice.

## Rules

1. **State the point.** No throat-clearing openers, no "here's what…", no meta-commentary about the text itself.
2. **State Y directly.** No negative parallelism ("not X, but Y") unless the second clause adds genuinely new information.
3. **Name the actor.** Prefer active voice; no anthropomorphic agency ("the market rewards" → "buyers pay"). Technical passives that hide no actor are fine.
4. **Be specific.** Replace vague declaratives and lazy extremes (*every*, *always*, *never*) with the actual fact, number, or actor. No "studies show" without naming the study.
5. **Cut filler and puffery**: intensifiers that change nothing, AI-vocabulary, copula dodges ("serves as a" → "is a"), -ing significance trails.
6. **No manufactured drama**: no dramatic fragmentation ("X. That's it. That's the thing."), no negative listing ("Not a X. Not a Y. A Z.").
7. **Watch triads and rhythm**: prefer 1-2 items over a habitual three; vary sentence lengths and paragraph endings; no runs of punchy one-liners.
8. **Density, not presence**: one flagged phrase may be fine; several pulling the same way in one section means rewrite that section.
9. **Exemptions**: verbatim quotes, code identifiers, legal/technical terms, accessibility text, the user's requested voice. Density still applies to the surrounding prose.
10. **Accuracy first**: slop rules never override accuracy, meaning, or safety.
11. **Vietnamese prose**: apply the Vietnamese list alongside the English one.

Quick blacklist (top tier; full inventories in [references/phrases.md](references/phrases.md)):

- Vocabulary: delve, tapestry, underscore, showcase, pivotal, crucial, intricate, meticulous, vibrant, testament, boasts, robust, seamless, leverage, utilize
- Phrases: "here's the thing", "let that sink in", "it's worth noting", "in today's [X]", "at the end of the day", "when it comes to", "not just X but Y", "and that's okay", "think about it", "studies have shown" (uncited)
- Structure one-liners: binary contrast · negative list · triad escalation · em-dash pivot (mid-sentence register relaunch) · "Additionally/Moreover" paragraph opener
- Vietnamese: "không chỉ… mà còn…", "không phải X, mà là Y", "đóng vai trò then chốt", "trong bối cảnh/thời đại…", "Điều đáng chú ý là", "cần lưu ý rằng", "hãy nhớ rằng", "tóm lại / nhìn chung" endings, openers "tuy nhiên / đồng thời / bên cạnh đó / hơn nữa", "góp phần", "có thể thấy rằng"

## Pre-delivery checklist (pass/fail; no scores)

Work through these; each is grep-able or directly checkable. If any still fails after one revision pass, say so to the user instead of hiding it:

- [ ] No throat-clearing opener in the first sentence of any section
- [ ] No "not X, but Y" contrast (or the second clause genuinely adds information)
- [ ] No uncited authority claim
- [ ] No copula dodge ("serves as", "stands as", "functions as" where "is" fits)
- [ ] No -ing trail at sentence end ("…, highlighting…")
- [ ] No transition word opening a paragraph (Additionally, Moreover, Furthermore; VN: tuy nhiên, đồng thời)
- [ ] No dramatic fragmentation or negative listing
- [ ] No three-item list where two carry the meaning
- [ ] No em-dash used to relaunch a sentence at a grander register (prefer comma, colon, or period)
- [ ] No AI-vocabulary hits (list above) beyond isolated, justified use
- [ ] Every claim of fact has a number, name, or pointer
- [ ] Sentence lengths vary; not every paragraph ends in a punchy one-liner

These lists are descriptive and dated: tells drift by model and year (delve collapsed after 2024; em-dash use is fading). Expect drift; re-check lists against current evidence rather than fossilizing them.

Patterns and exceptions in depth: [references/structures.md](references/structures.md). Before/after rewrites: [references/examples.md](references/examples.md).

## Attribution

Derived from **hardikpandya/stop-slop** (MIT, Hardik Pandya). Cross-validated against Wikipedia "Signs of AI writing" and the excess-vocabulary literature (Kobak et al.); divergences deliberate and recorded in the survey. Preserve this attribution when redistributing.
