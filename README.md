# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/4Quaranz/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/4Quaranz/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` returns
exactly the output tree makefun-site's `build()` returns for every site —
each page's `index.html`, the index and tag pages, `build-report.txt` and
each static file, byte for byte — including its own front matter, template
dialect, Markdown subset, slug rule and report.

## How it is fast

- **Markdown in one sweep:** each body is lexed and rendered in a single
  pass over the string (no token list, no per-line regexes), and inline
  text jumps between special characters with a native regex scan instead
  of stepping character by character; plain runs are escaped in one
  native replace.
- **Cached slugs:** `slugify()` has an ASCII fast path plus a cache —
  titles, tags and headings repeat a lot across a site. The cache is
  cleared at the start of every `build()`, so each case is answered alone.
- **Front matter from the head only:** only the lines between the `---`
  fences are scanned; the body is one slice, never split into lines.
- **Compiled templates:** each template is parsed once per case and
  compiled to a plain JS function (`new Function`), with a table of its
  paths so rendering never allocates a path array; scope lookup,
  truthiness and value formatting keep the reference semantics exactly.
- **Memoised links:** relative link targets are resolved through a
  per-build memo.
- The driver (`main.ts`) turns V8's incremental marking off, as the house
  baseline does, before importing `solve.js`.

## Results (practice set, 3 cases)

- All 3 practice cases identical to makefun-site 1.0.0's answers, and
  24/24 further cases drawn from the published generator with fresh seeds
  identical too.
- Median build time, interleaved with the baseline in one process:
  ~274 ms for the set against the baseline's ~553 ms — about 2x faster.

## Run it

```sh
mkdir -p /tmp/site-out
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=/tmp/site-out node main.ts
```

`main.ts` reads every case from `cases.json`, answers each one alone with
`run()` from `solve.js`, and writes `answers.json`.

## Files

- `solve.js` — the drop-in: `run(input)` returns makefun-site 1.0.0's answer.
- `main.ts` — the program the harness runs (`node /bot/main.ts`).
- `package.json` — `{"type": "module"}`, so `solve.js` loads as an ES module.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=scveefga&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
