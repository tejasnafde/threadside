/*
 * Loads threadside.user.js inside jsdom, swaps its boot call for an export of
 * the internals, and exercises the parts worth being sure about.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "threadside.user.js");
let src = readFileSync(SRC, "utf8");

const BOOT = 'main().catch((error) => debug("boot failed", error));';
if (!src.includes(BOOT)) throw new Error("boot call not found, harness is stale");

src = src.replace(
	BOOT,
	`__collect({
		canonicalize, sameCanonicalURL, sanitizeHTML, orderChildren, relTime,
		plural, countTree, countDescendants, fromAlgoliaNode, normalizeStory,
		autoDetectBlockedReason, buildComment, mapLimit,
		openDiscussion, findStories, fetchThread, detect, closeSidebar, claimDocument, navigated,
		getSettings: () => settings,
		patchSettings: (p) => { settings = { ...settings, ...p }; },
		DEFAULTS,
	});`,
);

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) pass++;
	else {
		fail++;
		console.log("FAIL  " + name + "\n        got:      " + JSON.stringify(actual) + "\n        expected: " + JSON.stringify(expected));
	}
}
function truthy(name, actual) {
	if (actual) pass++;
	else { fail++; console.log("FAIL  " + name + "  (got falsy: " + JSON.stringify(actual) + ")"); }
}

function build(url, html = "<body></body>", { routes = null, storage = {} } = {}) {
	const dom = new JSDOM(html, { url, pretendToBeVisual: true });
	const { window } = dom;
	window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	let captured = null;
	const requested = [];

	const xhr = (options) => {
		requested.push(options.url);
		const key = Object.keys(routes || {}).find((k) => options.url.includes(k));
		setTimeout(() => {
			if (!key) return options.onerror({ status: 0 });
			options.onload({ status: 200, responseText: JSON.stringify(routes[key]) });
		}, 0);
	};

	const sandbox = {
		__collect: (api) => {
			captured = api;
			api.dom = dom;
			api.requested = requested;
		},
		window,
		document: window.document,
		location: window.location,
		navigator: window.navigator,
		requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
		setTimeout,
		clearTimeout,
		setInterval: () => 0,
		console,
		URL: window.URL,
		GM: {
			getValue: async (k, d) => (k in storage ? storage[k] : d),
			setValue: async (k, v) => {
				storage[k] = v;
			},
			deleteValue: async (k) => {
				delete storage[k];
			},
			xmlHttpRequest: xhr,
		},
		GM_registerMenuCommand: () => {},
	};
	const fn = new Function(
		...Object.keys(sandbox),
		"'use strict';" + src.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/m, ""),
	);
	fn(...Object.values(sandbox));
	if (!captured) throw new Error("internals were not captured for " + url);
	return captured;
}

/* ---------------- canonicalize ---------------- */

const t = build("https://example.com/");

check("strips scheme, www and trailing slash",
	t.canonicalize("https://www.Example.com/a/b/"), "example.com/a/b");
check("http and https canonicalise the same",
	t.canonicalize("http://example.com/a"), t.canonicalize("https://example.com/a"));
check("drops utm params",
	t.canonicalize("https://example.com/a?utm_source=x&utm_campaign=y"), "example.com/a");
check("drops fbclid and gclid",
	t.canonicalize("https://example.com/a?fbclid=123&gclid=456"), "example.com/a");
check("keeps ?v= for youtube-style urls",
	t.canonicalize("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42&list=PL9"),
	"youtube.com/watch?v=dQw4w9WgXcQ");
check("drops search terms in ?q=",
	t.canonicalize("https://example.com/search?q=my+private+query"), "example.com/search");
check("sorts kept params so order does not matter",
	t.canonicalize("https://example.com/x?p=2&id=9"), t.canonicalize("https://example.com/x?id=9&p=2"));
check("rejects non-http schemes", t.canonicalize("ftp://example.com/a"), "");
check("rejects garbage", t.canonicalize("not a url"), "");
check("hash is ignored", t.canonicalize("https://example.com/a#section"), "example.com/a");
check(".html and the directory form are the same page",
	t.canonicalize("https://blog.rust-lang.org/2019/11/07/Async-await-stable.html"),
	t.canonicalize("https://blog.rust-lang.org/2019/11/07/Async-await-stable/"));
check(".htm counts too", t.canonicalize("https://example.com/a.htm"), "example.com/a");
check("index.html is the directory",
	t.canonicalize("https://example.com/blog/index.html"), "example.com/blog");
check("a dot in a slug is not a suffix",
	t.canonicalize("https://example.com/v1.2.3/notes"), "example.com/v1.2.3/notes");
check("other extensions are left alone",
	t.canonicalize("https://example.com/paper.pdf"), "example.com/paper.pdf");
check("sameCanonicalURL matches across www + utm",
	t.sameCanonicalURL("https://www.example.com/a?utm_source=hn", "http://example.com/a/"), true);
check("sameCanonicalURL rejects empty vs empty", t.sameCanonicalURL("junk", "junk"), false);
check("different paths differ", t.sameCanonicalURL("https://e.com/a", "https://e.com/b"), false);

/* ---------------- sanitizer ---------------- */

check("script tags removed", t.sanitizeHTML('<p>hi</p><script>alert(1)</script>'), "<p>hi</p>");
check("img removed", t.sanitizeHTML('<p>a</p><img src=x onerror=alert(1)>'), "<p>a</p>");
check("event handlers stripped", t.sanitizeHTML('<p onclick="alert(1)">x</p>'), "<p>x</p>");
check("style attribute stripped", t.sanitizeHTML('<p style="position:fixed">x</p>'), "<p>x</p>");
check("javascript: href dropped, element kept",
	t.sanitizeHTML('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
check("data: href dropped", t.sanitizeHTML('<a href="data:text/html,<b>x">y</a>'), "<a>y</a>");
check("http href kept and hardened",
	t.sanitizeHTML('<a href="https://ok.com/p">x</a>'),
	'<a href="https://ok.com/p" target="_blank" rel="noopener noreferrer nofollow">x</a>');
check("unknown tag unwrapped, text kept",
	t.sanitizeHTML('<marquee>keep me</marquee>'), "keep me");
check("nested unknown tag unwrapped but inner allowed tag survives",
	t.sanitizeHTML('<div><section><i>italic</i></section></div>'), "<i>italic</i>");
check("form controls removed entirely",
	t.sanitizeHTML('<form><input name=pw><button>go</button></form>x'), "x");
check("hn typical body survives intact",
	t.sanitizeHTML('<p>one <i>two</i> <code>three</code></p><pre><code>x=1</code></pre>'),
	'<p>one <i>two</i> <code>three</code></p><pre><code>x=1</code></pre>');
check("iframe removed", t.sanitizeHTML('<iframe src="https://evil.com"></iframe>ok'), "ok");
check("svg removed", t.sanitizeHTML('<svg><use href="#x"/></svg>ok'), "ok");
check("id and class attributes stripped from allowed tags",
	t.sanitizeHTML('<p id="a" class="b" data-x="c">t</p>'), "<p>t</p>");
truthy("no onerror survives anywhere",
	!/onerror/i.test(t.sanitizeHTML('<p><b onerror=x>y</b><img onerror=z></p>')));

/* ---------------- ordering ---------------- */

const kids = [{ id: 3 }, { id: 1 }, { id: 2 }];
check("reorders children to match firebase ranked kids",
	t.orderChildren(kids, [2, 3, 1]).map((c) => c.id), [2, 3, 1]);
check("appends children firebase does not list",
	t.orderChildren([{ id: 1 }, { id: 2 }, { id: 9 }], [2, 1]).map((c) => c.id), [2, 1, 9]);
check("tolerates firebase ids algolia lacks (dead comments)",
	t.orderChildren([{ id: 1 }], [7, 1, 8]).map((c) => c.id), [1]);
check("empty kids leaves order alone",
	t.orderChildren(kids, []).map((c) => c.id), [3, 1, 2]);
check("string vs number ids still match",
	t.orderChildren([{ id: "10" }, { id: "11" }], [11, 10]).map((c) => c.id), ["11", "10"]);

/* ---------------- tree shape ---------------- */

const algolia = {
	id: 100, title: "T", url: "https://e.com/a", author: "alice", created_at_i: 1, points: 5,
	children: [
		{ id: 1, author: "bob", text: "b", created_at_i: 2, children: [
			{ id: 3, author: "carol", text: "c", created_at_i: 3, children: [] },
		] },
		{ id: 2, author: null, text: null, created_at_i: 4, children: [
			{ id: 4, author: "dan", text: "d", created_at_i: 5, children: [] },
		] },
	],
};
const nodes = algolia.children.map(t.fromAlgoliaNode);
check("counts every node in the tree", t.countTree(nodes), 4);
check("descendants excludes the node itself", t.countDescendants(nodes[0]), 1);
check("flags deleted nodes", nodes[1].deleted, true);
check("keeps children of deleted nodes", nodes[1].children.length, 1);
check("maps author to by", nodes[0].by, "bob");

const story = t.normalizeStory(100, algolia, { score: 42, descendants: 7, title: "FB title", kids: [2, 1] });
check("firebase score wins over algolia points", story.score, 42);
check("descendants comes from firebase", story.descendants, 7);
check("descendants is null without firebase", t.normalizeStory(100, algolia, null).descendants, null);
check("falls back to algolia points", t.normalizeStory(100, algolia, null).score, 5);

/* ---------------- relTime / plural ---------------- */

const now = Math.floor(Date.now() / 1000);
check("just now", t.relTime(now - 5), "just now");
check("singular minute has no s", t.relTime(now - 60), "1 minute ago");
check("plural minutes", t.relTime(now - 300), "5 minutes ago");
check("hours", t.relTime(now - 7200), "2 hours ago");
check("singular day", t.relTime(now - 86400), "1 day ago");
check("months", t.relTime(now - 2592000 * 3), "3 months ago");
check("years", t.relTime(now - 31536000 * 2), "2 years ago");
check("missing timestamp is empty", t.relTime(0), "");
check("plural helper singular", t.plural(1, "point"), "1 point");
check("plural helper plural", t.plural(2, "point"), "2 points");
check("plural helper irregular", t.plural(3, "reply", "replies"), "3 replies");

/* ---------------- privacy gate ---------------- */

function reason(url, html = "<body></body>", patch = {}) {
	const env = build(url, html);
	env.patchSettings(patch);
	return env.autoDetectBlockedReason();
}

check("ordinary article is allowed",
	reason("https://blog.rust-lang.org/2019/11/07/Async-await-stable.html"), null);
check("long hyphenated slug is allowed (regression guard)",
	reason("https://example.com/2024/01/this-is-a-very-long-article-slug-about-things"), null);
truthy("dev server port blocked", reason("https://example.com:3000/x"));
truthy("bare ip blocked", reason("http://192.168.1.10/dashboard"));
truthy("single-label host blocked", reason("http://intranet/reports"));
truthy("dot-local blocked", reason("http://nas.local/files"));
truthy("access_token blocked", reason("https://example.com/cb?access_token=abc123"));
truthy("oauth code blocked", reason("https://example.com/cb?code=abc123"));
truthy("session id blocked", reason("https://example.com/x?sid=deadbeef"));
truthy("token in fragment blocked", reason("https://example.com/x#id_token=zzz"));
truthy("opaque 32-hex share id blocked",
	reason("https://example.com/page/0123456789abcdef0123456789abcdef"));
truthy("drive-style id blocked",
	reason("https://example.com/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"));
truthy("noindex page blocked",
	reason("https://example.com/x", '<head><meta name="robots" content="noindex, nofollow"></head><body></body>'));
truthy("uppercase NOINDEX blocked",
	reason("https://example.com/x", '<head><meta name="ROBOTS" content="NOINDEX"></head><body></body>'));
check("index,follow is fine",
	reason("https://example.com/x", '<head><meta name="robots" content="index, follow"></head><body></body>'), null);
truthy("password field blocked",
	reason("https://example.com/login", '<body><input type="password"></body>'));
truthy("autoDetect off blocks everything",
	reason("https://example.com/x", "<body></body>", { autoDetect: false }));
truthy("blocked host list honoured",
	reason("https://example.com/x", "<body></body>", { blockedHosts: ["example.com"] }));
check("port 443 explicit is fine", reason("https://example.com:443/x"), null);

/* ---------------- comment DOM ---------------- */

const env = build("https://example.com/a");
const el = env.buildComment(env.fromAlgoliaNode(algolia.children[0]), 0, "100");
check("comment has meta, body and kids as siblings",
	[...el.children].map((c) => c.className.split(" ")[0]), ["meta", "body", "kids"]);
truthy("kids is NOT inside body (the HNewhere bug)", el.querySelector(".body .kids") === null);
truthy("reply link present", el.querySelector(".reply") !== null);
truthy("child comment rendered inside kids", el.querySelector(".kids > .c") !== null);
truthy("reply count note rendered for collapse", el.querySelector(".kidnote") !== null);
truthy("toggle starts expanded", el.querySelector(".tg").getAttribute("aria-expanded") === "true");
el.querySelector(".tg").onclick();
truthy("toggle collapses", el.classList.contains("collapsed"));
truthy("aria-expanded follows collapse", el.querySelector(".tg").getAttribute("aria-expanded") === "false");
el.querySelector(".tg").onclick();
truthy("toggle expands again", !el.classList.contains("collapsed"));

const deletedEl = env.buildComment(env.fromAlgoliaNode(algolia.children[1]), 0, "100");
truthy("deleted comment has no reply link of its own",
	deletedEl.querySelector(":scope > .meta > .reply") === null);
truthy("deleted comment body says so",
	/\[deleted\]/.test(deletedEl.querySelector(":scope > .body").innerHTML));
truthy("non-deleted child keeps its reply link",
	deletedEl.querySelector(".kids > .c > .meta > .reply") !== null);
truthy("deleted comment still shows its child", deletedEl.querySelector(".kids > .c") !== null);

/* ---------------- mapLimit ---------------- */

const order = [];
const out = await env.mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
	await new Promise((r) => setTimeout(r, (6 - n) * 5));
	order.push(n);
	return n * 10;
});
check("mapLimit preserves input order in results", out, [10, 20, 30, 40, 50]);
truthy("mapLimit actually interleaved (completion order differs)", order.join() !== "1,2,3,4,5");
check("mapLimit on empty input", await env.mapLimit([], 4, async (x) => x), []);

/* ---------------- full open + render pipeline, HTTP stubbed ---------------- */

const ROUTES = {
	"/search?tags=story": {
		hits: [
			{ objectID: "100", title: "A story", url: "https://example.com/post", points: 42, num_comments: 4, created_at_i: 1000 },
			{ objectID: "999", title: "Elsewhere", url: "https://other.com/x", points: 5, num_comments: 1, created_at_i: 900 },
		],
	},
	"/items/100": algolia,
	"/item/100.json": { id: 100, title: "A story", url: "https://example.com/post", by: "alice", time: 1000, score: 42, descendants: 4, kids: [2, 1] },
};

const app = build("https://example.com/post", "<body><p>page</p></body>", { routes: ROUTES });

const found = await app.findStories("https://example.com/post");
check("findStories keeps only exact url matches", found.map((s) => s.id), ["100"]);
check("findStories carries points through", found[0].points, 42);

const thread = await app.fetchThread("100");
check("fetchThread used the single-request algolia path", thread.source, "algolia");
check("fetchThread reordered top level to HN ranked order",
	thread.children.map((c) => c.id), [2, 1]);
check("fetchThread took exactly 2 requests",
	app.requested.filter((u) => u.includes("/items/100") || u.includes("/item/100.json")).length, 2);

await app.openDiscussion(["100"]);
await new Promise((r) => setTimeout(r, 60));

const shadowHost = [...app.dom.window.document.body.children].find((n) => n.shadowRoot);
truthy("sidebar host attached with a shadow root", !!shadowHost);
const sr = shadowHost.shadowRoot;
truthy("panel rendered", !!sr.querySelector("#panel"));
truthy("story title rendered", /A story/.test(sr.querySelector(".story-title").textContent));
truthy("score rendered", /42 points/.test(sr.querySelector(".story-meta").textContent));
check("top-level comments rendered", sr.querySelectorAll(".kids.flat > .c").length, 2);
check("whole tree rendered", sr.querySelectorAll(".c").length, 4);
truthy("comment count in header", /4 comments/.test(sr.querySelector(".count").textContent));
truthy("resize handle exists", !!sr.querySelector("#resizer"));
truthy("theme attribute set", ["light", "dark"].includes(sr.querySelector("#panel").dataset.theme));

const collapseAll = [...sr.querySelectorAll(".story-actions button")].find((b) => b.textContent === "collapse all");
truthy("collapse all button present", !!collapseAll);
collapseAll.onclick();
check("collapse all collapses every comment",
	sr.querySelectorAll(".c.collapsed").length, 4);
check("collapse all relabels itself", collapseAll.textContent, "expand all");
collapseAll.onclick();
check("expand all restores", sr.querySelectorAll(".c.collapsed").length, 0);

app.closeSidebar();
truthy("closeSidebar removes the host",
	![...app.dom.window.document.body.children].some((n) => n.shadowRoot && n.shadowRoot.querySelector("#panel")));

/* a page with no submission must render an error, not hang on "Loading..." */
const empty = build("https://example.com/nope", "<body></body>", {
	routes: { "/search?tags=story": { hits: [] } },
});
await empty.detect();
await new Promise((r) => setTimeout(r, 30));
truthy("no sidebar when nothing is found",
	![...empty.dom.window.document.body.children].some((n) => n.shadowRoot));

/* auto-detect must not issue a single request on a blocked page */
const blockedApp = build("https://example.com/login", '<body><input type="password"></body>', { routes: ROUTES });
await blockedApp.detect();
check("blocked page issues zero requests", blockedApp.requested.length, 0);

/* the lookup cache must stop a second request for the same url */
const shared = {};
const first = build("https://example.com/post", "<body></body>", { routes: ROUTES, storage: shared });
await first.findStories("https://example.com/post");
const searchesBefore = first.requested.filter((u) => u.includes("/search")).length;
const second = build("https://example.com/post", "<body></body>", { routes: ROUTES, storage: shared });
await second.findStories("https://example.com/post");
check("first lookup hit the network", searchesBefore, 1);
check("second lookup served from cache", second.requested.filter((u) => u.includes("/search")).length, 0);

/* a fragment is not a new page (slowroads.io writes its save state into it) */
const nav = build("https://slowroads.io/#A0-67e11bb9@3");
check("same url is not a navigation", nav.navigated(), false);
nav.dom.window.location.hash = "#A0-67e11bb9@9";
check("hash change is not a navigation", nav.navigated(), false);
nav.dom.window.location.hash = "#totally-different";
check("another hash change is still not a navigation", nav.navigated(), false);
nav.dom.window.history.pushState({}, "", "/other-page");
check("a path change IS a navigation", nav.navigated(), true);
check("and only once", nav.navigated(), false);

/* one instance per document, so a duplicate install cannot draw two buttons */
const solo = build("https://example.com/a");
check("first instance claims the document", solo.claimDocument(), true);
check("second instance stands down", solo.claimDocument(), false);

/* auto-open off (the default) shows a button, not a sidebar */
const quiet = build("https://example.com/post", "<body></body>", { routes: ROUTES });
await quiet.detect();
await new Promise((r) => setTimeout(r, 60));
const quietHost = [...quiet.dom.window.document.body.children].find((n) => n.shadowRoot);
truthy("something was drawn", !!quietHost);
truthy("it is a button, not a panel", !quietHost.shadowRoot.querySelector("#panel"));
const btn = quietHost.shadowRoot.querySelector("button");
check("button shows the comment count", btn.textContent, "HN 4");
truthy("button jiggles for attention", btn.classList.contains("attention"));

/* autoOpen: true restores the old behaviour */
const eager = build("https://example.com/post", "<body></body>", { routes: ROUTES });
eager.patchSettings({ autoOpen: true });
await eager.detect();
await new Promise((r) => setTimeout(r, 60));
truthy("autoOpen opens the panel",
	!![...eager.dom.window.document.body.children].some((n) => n.shadowRoot && n.shadowRoot.querySelector("#panel")));

/* a failed request must not be cached as "no discussion" */
const flaky = {};
const down = build("https://example.com/post", "<body></body>", { routes: {}, storage: flaky });
check("failed lookup returns nothing", (await down.findStories("https://example.com/post")).length, 0);
check("failed lookup wrote no cache entry", Object.keys(flaky).includes("ts.lookupCache"), false);
const recovered = build("https://example.com/post", "<body></body>", { routes: ROUTES, storage: flaky });
check("next lookup retries instead of trusting the failure",
	(await recovered.findStories("https://example.com/post")).map((s) => s.id), ["100"]);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
