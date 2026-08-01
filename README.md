# Threadside

A userscript that shows the Hacker News discussion for whatever page you are on,
in a sidebar. One file, no build step, no dependencies.

## Credit

The idea is [Tommy Walichiewicz](https://github.com/twalichiewicz)'s, from
**[HNewhere](https://github.com/twalichiewicz/HNewhere)** (MIT). A comments
sidebar keyed off the URL you are already looking at is a genuinely good idea,
and this repo would not exist without having read that one first. Go star it.

This is an independent rewrite rather than a fork, because three things wanted
changing deeply enough to touch every part of the file: a thread cost one HTTP
request per comment, the comment tree's structure made collapsing work by
accident, and it sent the URL of essentially every page you visited to a third
party. [What changed](#what-changed-from-hnewhere) is spelled out below, with
measurements, and none of it is a criticism of shipping something that works.

---

## Install on Firefox

Firefox cannot run userscripts on its own. You need a userscript manager
extension first, then you feed it this one file.

### 1. Install a userscript manager

Pick one, from addons.mozilla.org:

- **[Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/)** - recommended, MIT licensed, open source.
- **[Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)** - more features, source-available but not open source.

Either works. The rest of these steps say Violentmonkey; Tampermonkey's
equivalents are in the same places under a different name.

### 2. Add the script

**Option A - paste it (simplest).**

1. Click the Violentmonkey toolbar icon, then the **wrench/settings** icon to
   open the dashboard.
2. Click **+** then **New**. An editor opens with an empty script template.
3. Select all of the template and replace it with the whole contents of
   `threadside.user.js`.
4. **Ctrl+S** (or the Save button). The tab title should change to
   `Threadside`. Close the editor.

To copy the file to your clipboard on macOS:

```sh
pbcopy < threadside.user.js
```

**Option B - serve it locally (gets you one-click updates).**

Userscript managers install from a URL, and Firefox extensions cannot read
`file://` paths, so serve the directory over HTTP:

```sh
./serve.sh          # http://127.0.0.1:8731
```

Then open <http://127.0.0.1:8731/threadside.user.js> in Firefox. Violentmonkey
intercepts any URL ending in `.user.js` and shows its install screen with a diff
of what the script is allowed to do. Click **Confirm installation**.

Because it remembers the install URL, editing the file and clicking **Check for
updates** in the dashboard reinstalls it. Handy while you are changing things.
The `@exclude *://localhost/*` line stops the script from *running* on localhost;
it does not stop you installing from there.

**Option C - install from GitHub (one click, self-updating).** Open this in
Firefox and confirm:

<https://raw.githubusercontent.com/tejasnafde/threadside/main/threadside.user.js>

`@updateURL` and `@downloadURL` already point there, so the manager checks for
new versions on its own. Do not combine this with Option A: two installs draw two
buttons.

### 3. Two Firefox settings worth checking

- **Private windows.** Extensions are disabled in private browsing by default.
  `about:addons` -> Violentmonkey -> **Run in Private Windows: Allow**, if you
  want it there.
- **Cross-origin requests.** Tampermonkey asks for permission the first time the
  script talks to `hn.algolia.com` and `hacker-news.firebaseio.com`. Both hosts
  are declared with `@connect`, so choose **Always allow domain**. Violentmonkey
  does not ask.

### 4. Check that it works

Open a page that is definitely on Hacker News:

<https://blog.rust-lang.org/2019/11/07/Async-await-stable.html>

An orange **HN 380** button should appear in the top right corner and jiggle
twice. Click it and the sidebar opens with the thread. If no button appears, open
the browser console (**Ctrl+Shift+K**) and set `DEBUG = true` near the top of the
script; it then logs why it declined to do anything.

### If two HN buttons appear

You have the script installed twice, most likely pasted once and then installed
from the raw URL. Open the manager's dashboard and delete one.

The script now also refuses to run twice in one document: the first instance
claims `<html data-threadside="1">` and any other instance stands down. The claim
goes through the DOM rather than a `window` property because a userscript sandbox
does not reliably share `window` between two instances, but the document is
always shared.

### If the button appears on a page that was never on Hacker News

Click it and look. The lookup requires an exact match on the canonicalised URL,
but sites reuse URL shapes, so a false positive is possible. This is the main
reason the sidebar no longer opens by itself: a wrong match is now a button you
ignore rather than a panel you have to close.

If a site is a repeat offender, use **Never look up `<host>`** from the menu.

### If the console says `cache hit <url> 0`

That means a lookup for this URL previously came back empty and the answer was
cached. Pick **Clear cached lookups** from the userscript menu and reload.

A cached zero used to be reachable two ways that were both wrong, and both are
fixed:

- **A failed request was cached as "no discussion".** A blocked cross-origin
  request, a timeout or a rate limit all produce zero matches, exactly like a
  page that genuinely was never submitted. The first is temporary and the second
  is not, and caching them the same way pinned the wrong answer for 12 hours
  with no requests left to notice. Only an answer that actually arrived is
  cached now.
- **`/post.html` and `/post/` were treated as different pages.** Static site
  generators serve one page at both spellings, and a submission from years ago
  carries whichever was current then, so a lookup for the directory form missed
  a submission stored under the `.html` form. Both now canonicalise to the same
  string. This is what the Rust blog link above tripped over.

---

## Using it

When a discussion exists, a small orange **HN** button appears in the corner with
the comment count on it, and jiggles twice. That is all it does. Nothing opens
until you click it.

The sidebar does not open by itself, on purpose. A panel taking a third of the
window uninvited is too much, and a wrong URL match makes it worse. If you want
the old behaviour, turn on **Auto-open sidebar** in the userscript menu.

| Action | How |
|---|---|
| Open the discussion for this page | Click the **HN** button, or the userscript menu -> **Show HN discussion for this page**, or `Alt+Shift+H` |
| Close the sidebar | **Close**, or `Esc`, or `Alt+Shift+H` again |
| Get it out of the way but keep it loaded | **Hide** (collapses to a draggable orange HN button) |
| Move the button | Drag it. The position is remembered across sites |
| Resize the sidebar | Drag its left edge. The width is remembered |
| Collapse one comment and its replies | `[-]` next to the author, HN's own behaviour |
| Collapse everything | **collapse all** under the story title |

The userscript menu (Violentmonkey toolbar icon, or Tampermonkey icon ->
Threadside) also holds:

- **Auto-detect: ON/OFF** - the master switch for looking pages up unprompted.
  Off means no requests at all until you ask.
- **Auto-open sidebar: ON/OFF** - off by default. On, the sidebar opens itself
  whenever a discussion is found, with no button step.
- **Never look up `<host>`** - a per-site block, for sites you would rather the
  script never see.
- **Theme: auto/light/dark** - `auto` follows `prefers-color-scheme`.
- **Clear cached lookups** - empties the local URL cache.

Clicking a story link on news.ycombinator.com records the story id locally for
10 minutes, so landing on the article opens *that exact thread* with no lookup
request at all. This works with several stories opened into background tabs,
which the original could not do.

---

## What it sends, and where

Two hosts, both declared with `@connect`:

- `hn.algolia.com` - URL to story-id lookup, and the comment tree.
- `hacker-news.firebaseio.com` - the story row, for score, comment count and
  HN's ranked ordering of top-level comments.

The lookup is the only request that contains something about you, so it is the
part that got the attention:

1. **The URL is stripped before it is sent.** What leaves the browser is
   `host + path`, plus only query params from a short allowlist of
   content-identifying ones (`v`, `id`, `p`, `page`, `post`, `story`, `article`,
   `item`, `topic`, `paperid`). Everything else is dropped, including `q=` and
   `search=`: your search terms are nobody's business and no HN submission is
   identified by them.
2. **Results are cached locally for 12 hours**, hits and misses alike, so
   revisiting a page is free and quiet.
3. **Auto-detect refuses outright** on pages that look private, before any
   request is made. Any one of these is enough:
   - a non-standard port, a bare IP host, a single-label host, or a
     `.local`/`.internal`/`.lan`/`.test` name (a dev server or an intranet);
   - a credential-shaped query or fragment param (`token`, `access_token`,
     `code`, `session`, `sid`, `key`, `secret`, `signature`, `password`, `otp`,
     `email`, `invite`, ...);
   - a long separator-free path segment, which is what private share links look
     like (Notion page ids, Drive file ids, signed URLs);
   - `<meta name="robots" content="noindex">`, since a page that asks not to be
     indexed is not a page that is on Hacker News;
   - a password field anywhere in the document.
4. **Turning auto-detect off makes the script fully passive.** It then issues no
   requests at all until you pick something from the menu or press the shortcut.

The `@exclude` list only covers hosts that are unambiguously private surfaces
(mail, Drive, Slack, Notion, payment processors). It deliberately does *not*
contain a line like `*://*.bank.com/*`, which matches essentially no real bank
and is security theatre. The runtime checks above are what actually do the work.

Requests go through `GM.xmlHttpRequest` rather than `fetch`. Both APIs send
permissive CORS headers so `fetch` would usually work, but a page's
Content-Security-Policy can block a page-context `fetch`, and a granted
userscript runs inside that policy.

---

## What changed from HNewhere

### A thread is 2 requests, not one per comment

The original walked the tree depth-first, awaiting one Firebase call per
comment, yielding to the event loop every 10 siblings. A 400-comment thread was
400 sequential round trips.

Threadside asks Algolia's `/api/v1/items/<id>` for the entire tree in one call,
in parallel with one Firebase call for the story row. Measured against the story
used in the install check above: **374 comment nodes in a single request**.

Firebase is still worth its one call, because the two sources disagree in a way
that matters. Algolia returns children in ascending id order (chronological);
Firebase's `kids` array is in HN's *ranked* order, which is the order you see on
the site. So the top level is reordered to match `kids`, and anything Firebase
does not list is appended. Verified on the same story: Algolia's first children
were `21473370, 21473386, 21473418`, HN's ranked order was
`21474031, 21473672, 21474576`.

Algolia's index also drops dead and flagged comments (374 nodes against
Firebase's 380 descendants, 32 top-level against 35). That matches what a
logged-out reader sees on HN, so it is left alone.

If Algolia has not indexed the thread yet, which happens on very fresh
submissions, it falls back to the Firebase walk. That fallback is now
breadth-first and batched 12 at a time, so it costs one round trip per depth
level rather than one per comment, and if it hits its 1200-comment cap it says
so in the sidebar instead of quietly stopping.

### The comment tree has a real structure

The original nested the replies container *inside* the comment's own text
container:

```html
<div class="text">
  <div class="children">   <!-- the comment body AND its replies, together -->
```

Collapsing toggled `.children`, so it hid the body along with the replies. That
happens to be what HN does, so the behaviour was right by accident, but the
replies inherited the body's typography and there was no way to express "hide
the replies, keep the comment".

Here `meta`, `body` and `kids` are siblings, and collapsing is explicit: the
body and the replies both hide, and the header gains `(12 replies)` the way HN
shows `(12 children)`.

### Resizing hit-tests the right element

The original registered `mousedown` on the whole panel and started a resize when
`e.offsetX < 8`. But `offsetX` is relative to `event.target`, not to the element
the listener sits on, so a click within 8px of the left edge of *any child
element* started a drag-resize. There is now a dedicated 7px handle, using
pointer events, which cannot be ambiguous.

### Smaller things

- Comment HTML goes through an **allowlist** sanitiser: unknown tags are
  unwrapped (text kept), script-bearing tags removed, every attribute stripped
  except `href` on `<a>`, and surviving links forced to
  `target="_blank" rel="noopener noreferrer nofollow"`. The original used a
  denylist, which is the wrong default.
- The floating buttons live in their own shadow root too, so a page's
  `button { }` rules cannot restyle them.
- Dark mode, following `prefers-color-scheme` unless you pin a theme.
- Ask HN / self-post text is rendered. The original dropped it.
- Failures say so. The original left `Loading...` on screen forever.
- SPA navigation is noticed (2s poll plus `popstate`/`hashchange`), so the
  sidebar does not keep showing the previous article's thread.
- Large deep subtrees render behind a `show N replies` button, and top-level
  comments render in chunks of 20 across frames, so a 1000-comment thread does
  not lock the tab.
- Fixed: the never-called `clampButtonPosition`, `renderStory`'s unused
  `multiple`/`stories` options, a `window` resize listener leaked per button,
  `"1 minutes ago"`, and debug `console.log`s left in a release.
- The HN click record is a list of up to 12 entries instead of a single global
  slot, so several stories opened into background tabs each find their own
  thread.

---

## Tests

There is no build step, but the parts that are easy to get quietly wrong (URL
canonicalisation, the sanitiser, the privacy gate, comment tree shape) have a
harness. It loads the userscript inside jsdom, swaps the boot call for an export
of the internals, and asserts against them.

```sh
cd test
npm install      # jsdom, the only dependency, dev-only
npm test
```

111 assertions. The last group stubs `GM.xmlHttpRequest` and drives the real
thing end to end: look a URL up, fetch the thread, render it into the shadow
root, collapse it, close it. That group is what pins down the claims made above,
including *"a thread costs 2 requests"*, which is asserted by counting the stub's
calls rather than taken on trust.

The rest are unit assertions, several of them regression guards for mistakes that
were actively tempting while writing this: a long hyphenated article slug must
not be mistaken for a private share id, `.kids` must never end up inside
`.body`, a blocked page must issue *zero* requests rather than one it discards,
and `mapLimit` must return results in input order even though it completes them
out of order.

---

## Configuration

Defaults live in the `DEFAULTS` object near the top of the file. Anything you
change through the menu is stored and wins over them.

| Setting | Default | Meaning |
|---|---|---|
| `autoDetect` | `true` | Look pages up without being asked |
| `autoOpen` | `false` | Open the sidebar itself instead of showing a button |
| `theme` | `"auto"` | `auto`, `light` or `dark` |
| `sendQueryParams` | `true` | Include allowlisted query params in lookups |
| `minPoints` | `0` | Ignore submissions below this score |
| `blockedHosts` | `[]` | Hosts never to look up |
| `cacheMinutes` | `720` | Lookup cache lifetime |
| `shortcut` | `"Alt+Shift+H"` | Manual open. `""` disables |

`Alt+Shift+H` was chosen to stay clear of Firefox's own bindings; `Ctrl+Shift+H`
opens the History library, so do not use that one.

---

## License

MIT, the same as [HNewhere](https://github.com/twalichiewicz/HNewhere), whose
idea this is. See [Credit](#credit).
