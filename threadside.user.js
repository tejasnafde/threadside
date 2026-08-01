// ==UserScript==
// @name         Threadside
// @namespace    https://tn07.dev/threadside
// @version      1.1.0
// @description  Read the Hacker News discussion for the page you are on, in a sidebar. One request per thread, on-demand by default.
// @author       tejas
// @license      MIT
// @homepageURL  https://github.com/tejasnafde/threadside
// @supportURL   https://github.com/tejasnafde/threadside/issues
// @updateURL    https://raw.githubusercontent.com/tejasnafde/threadside/main/threadside.user.js
// @downloadURL  https://raw.githubusercontent.com/tejasnafde/threadside/main/threadside.user.js
// @match        *://*/*
// @exclude      *://localhost/*
// @exclude      *://127.0.0.1/*
// @exclude      *://0.0.0.0/*
// @exclude      *://accounts.google.com/*
// @exclude      *://mail.google.com/*
// @exclude      *://docs.google.com/*
// @exclude      *://drive.google.com/*
// @exclude      *://calendar.google.com/*
// @exclude      *://meet.google.com/*
// @exclude      *://*.googleusercontent.com/*
// @exclude      *://*.slack.com/*
// @exclude      *://web.whatsapp.com/*
// @exclude      *://*.notion.so/*
// @exclude      *://*.atlassian.net/*
// @exclude      *://chatgpt.com/*
// @exclude      *://claude.ai/*
// @exclude      *://*.paypal.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.doubleclick.net/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.xmlHttpRequest
// @grant        GM.registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      hn.algolia.com
// @connect      hacker-news.firebaseio.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Threadside
 *
 * The idea, and the shape of the thing, come from HNewhere by Tommy
 * Walichiewicz: https://github.com/twalichiewicz/HNewhere (MIT). Credit where
 * it is due: a comments sidebar keyed off the URL you are already looking at is
 * a good idea, and this would not exist without having read that first.
 *
 * This is an independent rewrite rather than a fork, with four things changed
 * on purpose:
 *
 *   1. A thread costs 2 HTTP requests, not one-per-comment. The comment tree
 *      comes from Algolia's /items/<id> endpoint in a single call; Firebase is
 *      used only for the story row (score, descendant count and HN's ranked
 *      ordering of top-level comments). The old per-comment Firebase walk
 *      survives as a fallback, but breadth-first and batched.
 *   2. Lookups are cached and query strings are filtered, so far fewer URLs
 *      leave the browser, and auto-detect refuses to run at all on pages that
 *      look private (noindex, password field, dev port, token in the URL).
 *   3. The comment tree has a real structure: meta / body / kids as siblings,
 *      so collapsing is deliberate rather than a side effect of the body and
 *      the replies sharing one container.
 *   4. Everything the script draws lives in a shadow root, including the
 *      floating buttons, so page CSS cannot reach it.
 */

(function () {
	"use strict";

	/* ------------------------------------------------------------------ *
	 * Configuration
	 * ------------------------------------------------------------------ */

	const DEBUG = false;

	const KEY = {
		settings: "ts.settings",
		width: "ts.width",
		buttonPos: "ts.buttonPos",
		recent: "ts.recentClicks",
		cache: "ts.lookupCache",
	};

	const DEFAULTS = {
		// false means the script never touches the network until you ask it to.
		autoDetect: true,
		// Open the sidebar by itself when a discussion is found. Off by default:
		// a panel taking over a third of the window uninvited is too much, and a
		// wrong match makes it worse. When off, a small button appears with the
		// comment count and jiggles once, and you decide.
		autoOpen: false,
		// auto | light | dark
		theme: "auto",
		// Include content-identifying query params (?v=, ?id=) in lookups.
		sendQueryParams: true,
		// Ignore submissions below this score. 0 keeps everything.
		minPoints: 0,
		// Hosts you never want looked up, managed from the userscript menu.
		blockedHosts: [],
		// How long a lookup result (hit or miss) stays cached.
		cacheMinutes: 720,
		// Manual open shortcut. Set to "" to disable.
		shortcut: "Alt+Shift+H",
	};

	const HN = "https://news.ycombinator.com";
	const ALGOLIA = "https://hn.algolia.com/api/v1";
	const FIREBASE = "https://hacker-news.firebaseio.com/v0";

	const RECENT_TTL_MS = 10 * 60 * 1000;
	const MAX_RECENT = 12;
	const MAX_CACHE_ENTRIES = 400;
	const REQUEST_TIMEOUT_MS = 15000;

	// Only used by the Firebase fallback path.
	const FALLBACK_COMMENT_CAP = 1200;
	const FALLBACK_CONCURRENCY = 12;

	const RENDER_CHUNK = 20;
	const LAZY_DEPTH = 3;
	const LAZY_MIN_DESCENDANTS = 30;
	const INDENT_MAX_DEPTH = 8;

	// Query params that identify content rather than a person or a session.
	// Everything else is dropped before a URL is sent to Algolia.
	// Deliberately excludes q= and search= : those are search terms, which are
	// nobody else's business, and no HN submission is identified by them.
	const KEEP_PARAMS = new Set([
		"v",
		"id",
		"p",
		"page",
		"post",
		"postid",
		"story",
		"storyid",
		"article",
		"articleid",
		"item",
		"itemid",
		"threadid",
		"topic",
		"paperid",
	]);

	const TRACKING_PARAM_PREFIXES = ["utm_", "mc_", "pk_", "hsa_", "_hs"];

	const SECRET_PARAM_RE =
		/(^|[?&#])(access_token|id_token|refresh_token|token|auth|authorization|code|session|sessionid|jsessionid|sid|phpsessid|key|api_key|apikey|secret|signature|sig|password|passwd|pwd|otp|email|invite|share_token)=/i;

	const PRIVATE_HOST_RE =
		/(^|\.)(local|internal|localdomain|lan|test|localhost|home\.arpa)$/i;

	const IP_HOST_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;

	// A long separator-free path segment usually means a private share link
	// (Notion page ids, Drive file ids, signed URLs). Hyphens and underscores
	// are excluded from the class on purpose: article slugs are long but always
	// separated, so including them would reject exactly the pages this script
	// exists to serve.
	const OPAQUE_SEGMENT_RE = /(^|\/)[A-Za-z0-9]{28,}(\/|$)/;

	/* ------------------------------------------------------------------ *
	 * Small utilities
	 * ------------------------------------------------------------------ */

	let settings = { ...DEFAULTS };
	let sidebarHost = null;
	let floatingHost = null;
	let opening = false;
	let currentHref = location.href;

	function debug(...args) {
		if (DEBUG) console.log("[threadside]", ...args);
	}

	function nextFrame() {
		return new Promise((resolve) => {
			if (document.hidden) setTimeout(resolve, 0);
			else requestAnimationFrame(() => resolve());
		});
	}

	async function mapLimit(items, limit, fn) {
		const out = new Array(items.length);
		let cursor = 0;

		const workers = new Array(Math.min(limit, items.length)).fill(0).map(
			async () => {
				for (;;) {
					const index = cursor++;
					if (index >= items.length) return;
					out[index] = await fn(items[index], index);
				}
			},
		);

		await Promise.all(workers);
		return out;
	}

	function escapeHTML(value) {
		return String(value === undefined || value === null ? "" : value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	function relTime(timestamp) {
		if (!timestamp) return "";

		const seconds = Math.floor(Date.now() / 1000 - timestamp);
		if (seconds < 45) return "just now";

		const units = [
			["minute", 60],
			["hour", 3600],
			["day", 86400],
			["month", 2592000],
			["year", 31536000],
		];

		let label = "minute";
		let size = 60;

		for (const [name, span] of units) {
			if (seconds >= span) {
				label = name;
				size = span;
			}
		}

		const count = Math.floor(seconds / size);
		return count + " " + label + (count === 1 ? "" : "s") + " ago";
	}

	function plural(count, singular, pluralForm) {
		return count + " " + (count === 1 ? singular : pluralForm || singular + "s");
	}

	function isMobile() {
		return window.matchMedia("(max-width: 700px)").matches;
	}

	// ponytail: one instance per document, claimed through the DOM rather than a
	// window property, because a userscript sandbox does not reliably share
	// window between two instances but always shares the document. Two installs
	// of the same script (pasted, then installed from the raw URL) otherwise
	// each draw their own button and neither can see the other's.
	function claimDocument() {
		const root = document.documentElement;
		if (root.hasAttribute("data-threadside")) return false;
		root.setAttribute("data-threadside", "1");
		return true;
	}

	/* ------------------------------------------------------------------ *
	 * Storage (works with either the GM.* or the GM_* flavour)
	 * ------------------------------------------------------------------ */

	const store = {
		async get(key, fallback) {
			try {
				if (typeof GM !== "undefined" && GM && typeof GM.getValue === "function") {
					const value = await GM.getValue(key, fallback);
					return value === undefined ? fallback : value;
				}
				if (typeof GM_getValue === "function") {
					const value = GM_getValue(key, fallback);
					return value === undefined ? fallback : value;
				}
			} catch (error) {
				debug("storage read failed", key, error);
			}
			return fallback;
		},

		async set(key, value) {
			try {
				if (typeof GM !== "undefined" && GM && typeof GM.setValue === "function") {
					await GM.setValue(key, value);
					return;
				}
				if (typeof GM_setValue === "function") GM_setValue(key, value);
			} catch (error) {
				debug("storage write failed", key, error);
			}
		},

		async del(key) {
			try {
				if (typeof GM !== "undefined" && GM && typeof GM.deleteValue === "function") {
					await GM.deleteValue(key);
					return;
				}
				if (typeof GM_deleteValue === "function") GM_deleteValue(key);
			} catch (error) {
				debug("storage delete failed", key, error);
			}
		},
	};

	function registerMenu(label, handler) {
		try {
			if (typeof GM_registerMenuCommand === "function") {
				GM_registerMenuCommand(label, handler);
				return;
			}
			if (
				typeof GM !== "undefined" &&
				GM &&
				typeof GM.registerMenuCommand === "function"
			) {
				GM.registerMenuCommand(label, handler);
			}
		} catch (error) {
			debug("menu registration failed", label, error);
		}
	}

	/* ------------------------------------------------------------------ *
	 * Network
	 *
	 * Both endpoints send permissive CORS headers, so plain fetch() would
	 * often work. GM.xmlHttpRequest is used instead because a page's
	 * Content-Security-Policy can block a page-context fetch, and a userscript
	 * with grants runs inside that page's CSP.
	 * ------------------------------------------------------------------ */

	function httpJSON(url) {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};

			const options = {
				method: "GET",
				url: url,
				timeout: REQUEST_TIMEOUT_MS,
				headers: { Accept: "application/json" },
				onload(response) {
					if (response.status < 200 || response.status >= 300) {
						debug("http", response.status, url);
						return finish(null);
					}
					try {
						finish(JSON.parse(response.responseText));
					} catch (error) {
						debug("bad json", url, error);
						finish(null);
					}
				},
				onerror: () => finish(null),
				ontimeout: () => finish(null),
				onabort: () => finish(null),
			};

			try {
				if (
					typeof GM !== "undefined" &&
					GM &&
					typeof GM.xmlHttpRequest === "function"
				) {
					GM.xmlHttpRequest(options);
				} else if (typeof GM_xmlhttpRequest === "function") {
					GM_xmlhttpRequest(options);
				} else {
					finish(null);
				}
			} catch (error) {
				debug("request threw", url, error);
				finish(null);
			}
		});
	}

	/* ------------------------------------------------------------------ *
	 * URL canonicalisation and privacy gating
	 * ------------------------------------------------------------------ */

	function canonicalize(href) {
		let url;
		try {
			url = new URL(href);
		} catch {
			return "";
		}

		if (url.protocol !== "http:" && url.protocol !== "https:") return "";

		const host = url.hostname.replace(/^www\./i, "").toLowerCase();

		// Strip trailing slashes, index pages and the .html suffix. Static site
		// generators serve the same page at /post.html and /post/, and a
		// submission from years ago carries whichever spelling was current then.
		// Both sides go through this, so the comparison stays symmetric.
		const path = url.pathname
			.replace(/\/+$/, "")
			.replace(/\/index\.html?$/i, "")
			.replace(/\.html?$/i, "");

		const kept = [];
		if (settings.sendQueryParams) {
			for (const [name, value] of url.searchParams.entries()) {
				const lower = name.toLowerCase();
				if (!KEEP_PARAMS.has(lower)) continue;
				if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) continue;
				if (!value) continue;
				kept.push([lower, value]);
			}
			kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		}

		const query = kept.length
			? "?" + kept.map(([n, v]) => n + "=" + v).join("&")
			: "";

		return host + path + query;
	}

	function sameCanonicalURL(a, b) {
		const left = canonicalize(a);
		return left !== "" && left === canonicalize(b);
	}

	/**
	 * Reasons auto-detect declines to send this URL anywhere. Returns null when
	 * the page is fine to look up. A manual request bypasses all of this: an
	 * explicit click is consent.
	 */
	function autoDetectBlockedReason() {
		if (!settings.autoDetect) return "auto-detect is off";

		if (location.protocol !== "http:" && location.protocol !== "https:") {
			return "not an http(s) page";
		}

		const host = location.hostname.toLowerCase();

		if (!host.includes(".")) return "single-label host, looks like an intranet";
		if (IP_HOST_RE.test(host)) return "host is a bare IP address";
		if (PRIVATE_HOST_RE.test(host)) return "private-use hostname";

		if (location.port && location.port !== "80" && location.port !== "443") {
			return "non-standard port, looks like a local server";
		}

		if (settings.blockedHosts.includes(host)) return "host is on your block list";

		if (SECRET_PARAM_RE.test(location.search + location.hash)) {
			return "URL carries something credential-shaped";
		}

		if (OPAQUE_SEGMENT_RE.test(location.pathname)) {
			return "URL contains an opaque id, looks like a private link";
		}

		const robots = document.querySelector('meta[name="robots" i]');
		if (robots && /noindex|none/i.test(robots.getAttribute("content") || "")) {
			return "page is marked noindex";
		}

		if (document.querySelector('input[type="password"]')) {
			return "page has a password field";
		}

		return null;
	}

	/* ------------------------------------------------------------------ *
	 * Lookup cache
	 * ------------------------------------------------------------------ */

	async function readCache(canonical) {
		const cache = await store.get(KEY.cache, {});
		const entry = cache[canonical];
		if (!entry) return null;

		if (Date.now() - entry.t > settings.cacheMinutes * 60 * 1000) return null;
		return entry.s || [];
	}

	async function writeCache(canonical, stories) {
		const cache = await store.get(KEY.cache, {});
		cache[canonical] = { t: Date.now(), s: stories };

		const keys = Object.keys(cache);
		if (keys.length > MAX_CACHE_ENTRIES) {
			keys
				.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0))
				.slice(0, keys.length - MAX_CACHE_ENTRIES)
				.forEach((k) => delete cache[k]);
		}

		await store.set(KEY.cache, cache);
	}

	/* ------------------------------------------------------------------ *
	 * Finding the submissions for a URL
	 * ------------------------------------------------------------------ */

	async function findStories(href, { useCache = true } = {}) {
		const canonical = canonicalize(href);
		if (!canonical) return [];

		if (useCache) {
			const cached = await readCache(canonical);
			if (cached) {
				debug("cache hit", canonical, cached.length);
				return cached;
			}
		}

		// Two queries at most: the canonical form, and the bare host + path when
		// the canonical form carries a query string.
		const bare = canonical.split("?")[0];
		const queries = bare === canonical ? [canonical] : [canonical, bare];

		const matches = new Map();
		let answered = false;

		for (const query of queries) {
			const result = await httpJSON(
				ALGOLIA +
					"/search?tags=story&restrictSearchableAttributes=url&hitsPerPage=100&query=" +
					encodeURIComponent(query),
			);

			if (!result || !Array.isArray(result.hits)) continue;
			answered = true;

			for (const hit of result.hits) {
				if (!hit.url) continue;
				if (canonicalize(hit.url) !== canonical) continue;
				if ((hit.points || 0) < settings.minPoints) continue;

				matches.set(String(hit.objectID), {
					id: String(hit.objectID),
					title: hit.title || "",
					points: hit.points || 0,
					comments: hit.num_comments || 0,
					time: hit.created_at_i || 0,
				});
			}

			if (matches.size) break;
		}

		const stories = [...matches.values()].sort((a, b) => b.time - a.time);

		// Only cache an answer we actually got. A blocked, timed out or rate
		// limited request also produces zero matches, and caching that would
		// pin "no discussion here" for 12 hours with no requests left to
		// notice it was wrong.
		if (answered) await writeCache(canonical, stories);
		else debug("lookup got no response, not caching", canonical);

		return stories;
	}

	/* ------------------------------------------------------------------ *
	 * Fetching one thread
	 * ------------------------------------------------------------------ */

	function fromAlgoliaNode(node) {
		const children = Array.isArray(node.children)
			? node.children.map(fromAlgoliaNode)
			: [];

		return {
			id: node.id,
			by: node.author || "",
			time: node.created_at_i || 0,
			text: node.text || "",
			children,
			deleted: !node.author && !node.text,
		};
	}

	function orderChildren(children, kids) {
		if (!Array.isArray(kids) || !kids.length) return children;

		const remaining = new Map(children.map((c) => [String(c.id), c]));
		const ordered = [];

		for (const kid of kids) {
			const key = String(kid);
			if (remaining.has(key)) {
				ordered.push(remaining.get(key));
				remaining.delete(key);
			}
		}

		for (const child of children) {
			if (remaining.delete(String(child.id))) ordered.push(child);
		}

		return ordered;
	}

	function countTree(nodes) {
		let total = 0;
		for (const node of nodes || []) total += 1 + countTree(node.children);
		return total;
	}

	function countDescendants(node) {
		return countTree(node.children);
	}

	function normalizeStory(id, algolia, firebase) {
		const a = algolia || {};
		const f = firebase || {};

		return {
			id: String(id),
			title: f.title || a.title || "(untitled)",
			url: f.url || a.url || "",
			by: f.by || a.author || "",
			time: f.time || a.created_at_i || 0,
			score: typeof f.score === "number" ? f.score : a.points || 0,
			descendants: typeof f.descendants === "number" ? f.descendants : null,
			text: f.text || a.text || "",
		};
	}

	async function fetchThread(storyId) {
		const [tree, item] = await Promise.all([
			httpJSON(ALGOLIA + "/items/" + encodeURIComponent(storyId)),
			httpJSON(FIREBASE + "/item/" + encodeURIComponent(storyId) + ".json"),
		]);

		if (tree && tree.id) {
			const children = orderChildren(
				(Array.isArray(tree.children) ? tree.children : []).map(fromAlgoliaNode),
				item && item.kids,
			);

			return {
				story: normalizeStory(storyId, tree, item),
				children,
				truncated: false,
				source: "algolia",
			};
		}

		debug("algolia items missed, falling back to firebase", storyId);
		return fetchThreadViaFirebase(storyId, item);
	}

	/**
	 * Fallback for the case where Algolia has not indexed the thread yet
	 * (very fresh submissions) or is rate limiting. Breadth-first and batched,
	 * so it is one round trip per depth level rather than one per comment.
	 */
	async function fetchThreadViaFirebase(storyId, prefetched) {
		const item =
			prefetched ||
			(await httpJSON(FIREBASE + "/item/" + encodeURIComponent(storyId) + ".json"));

		if (!item) return null;

		const root = { children: [], kids: item.kids || [] };
		let frontier = [root];
		let fetched = 0;
		let truncated = false;

		while (frontier.length) {
			const jobs = [];
			for (const parent of frontier) {
				for (const id of parent.kids || []) jobs.push({ parent, id });
			}
			if (!jobs.length) break;

			if (fetched + jobs.length > FALLBACK_COMMENT_CAP) {
				jobs.length = Math.max(0, FALLBACK_COMMENT_CAP - fetched);
				truncated = true;
			}
			if (!jobs.length) break;

			const items = await mapLimit(jobs, FALLBACK_CONCURRENCY, (job) =>
				httpJSON(FIREBASE + "/item/" + job.id + ".json"),
			);

			fetched += jobs.length;
			const next = [];

			items.forEach((fetchedItem, index) => {
				const { parent, id } = jobs[index];

				const node = {
					id,
					by: (fetchedItem && fetchedItem.by) || "",
					time: (fetchedItem && fetchedItem.time) || 0,
					text: (fetchedItem && fetchedItem.text) || "",
					children: [],
					kids: (fetchedItem && fetchedItem.kids) || [],
					deleted: !fetchedItem || !!fetchedItem.deleted || !!fetchedItem.dead,
				};

				parent.children.push(node);
				if (node.kids.length) next.push(node);
			});

			frontier = next;
		}

		return {
			story: normalizeStory(storyId, null, item),
			children: root.children,
			truncated,
			source: "firebase",
		};
	}

	/* ------------------------------------------------------------------ *
	 * Sanitiser
	 *
	 * Allowlist, not denylist. HN comment bodies only ever contain a handful
	 * of tags, so anything unexpected is unwrapped (text kept, element gone)
	 * and anything script-bearing is removed outright.
	 * ------------------------------------------------------------------ */

	const KEEP_TAGS = new Set([
		"P",
		"A",
		"I",
		"B",
		"U",
		"S",
		"EM",
		"STRONG",
		"CODE",
		"PRE",
		"BR",
		"BLOCKQUOTE",
		"UL",
		"OL",
		"LI",
		"DEL",
		"INS",
		"SUP",
		"SUB",
	]);

	const DROP_TAGS = new Set([
		"SCRIPT",
		"STYLE",
		"LINK",
		"META",
		"BASE",
		"TEMPLATE",
		"IFRAME",
		"FRAME",
		"FRAMESET",
		"OBJECT",
		"EMBED",
		"APPLET",
		"FORM",
		"INPUT",
		"BUTTON",
		"SELECT",
		"OPTION",
		"TEXTAREA",
		"IMG",
		"PICTURE",
		"SOURCE",
		"AUDIO",
		"VIDEO",
		"TRACK",
		"CANVAS",
		"SVG",
		"MATH",
		"NOSCRIPT",
		"DIALOG",
	]);

	const SAFE_HREF_RE = /^(https?:|mailto:)/i;

	function sanitizeHTML(html) {
		const template = document.createElement("template");
		template.innerHTML = String(html || "");

		for (const el of [...template.content.querySelectorAll("*")]) {
			const tag = el.tagName.toUpperCase();

			if (DROP_TAGS.has(tag)) {
				el.remove();
				continue;
			}

			if (!KEEP_TAGS.has(tag)) {
				el.replaceWith(...el.childNodes);
				continue;
			}

			for (const attr of [...el.attributes]) {
				if (tag === "A" && attr.name.toLowerCase() === "href") continue;
				el.removeAttribute(attr.name);
			}

			if (tag === "A") {
				const href = (el.getAttribute("href") || "").trim();
				if (!SAFE_HREF_RE.test(href)) {
					el.removeAttribute("href");
				} else {
					el.setAttribute("target", "_blank");
					el.setAttribute("rel", "noopener noreferrer nofollow");
				}
			}
		}

		return template.innerHTML;
	}

	/* ------------------------------------------------------------------ *
	 * Popups
	 * ------------------------------------------------------------------ */

	function openHNWindow(url) {
		const popup = window.open(
			url,
			"hn_thread",
			"width=780,height=760,resizable=yes,scrollbars=yes",
		);
		if (!popup) window.open(url, "_blank", "noopener");
	}

	function replyURL(commentId, storyId) {
		return (
			HN +
			"/reply?id=" +
			commentId +
			"&goto=" +
			encodeURIComponent("item?id=" + storyId + "#" + commentId)
		);
	}

	/* ------------------------------------------------------------------ *
	 * Theme
	 * ------------------------------------------------------------------ */

	function resolveTheme() {
		if (settings.theme === "light" || settings.theme === "dark") {
			return settings.theme;
		}
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	}

	/* ------------------------------------------------------------------ *
	 * Floating button (shadow-isolated, draggable, position persisted)
	 * ------------------------------------------------------------------ */

	async function createFloatingButton({ label, title, onActivate, attention }) {
		removeFloatingButton();

		const host = document.createElement("div");
		host.style.cssText = "all:initial;position:static;";
		const shadow = host.attachShadow({ mode: "open" });

		shadow.innerHTML = `
<style>
:host { all: initial; }
button {
	position: fixed;
	top: 12px;
	right: 12px;
	z-index: 2147483647;
	background: #ff6600;
	color: #fff;
	border: 0;
	border-radius: 4px;
	padding: 5px 9px;
	font: bold 11px/1.2 Verdana, Geneva, sans-serif;
	cursor: pointer;
	box-shadow: 0 1px 5px rgba(0, 0, 0, 0.3);
	user-select: none;
	touch-action: none;
	-webkit-tap-highlight-color: transparent;
}
button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }

/* Two short jiggles once, then still. Enough to be noticed in peripheral
   vision, short enough not to be a nuisance on every page load. */
@keyframes jiggle {
	0%, 100% { transform: rotate(0deg) scale(1); }
	15% { transform: rotate(-7deg) scale(1.08); }
	30% { transform: rotate(6deg) scale(1.08); }
	45% { transform: rotate(-4deg) scale(1.04); }
	60% { transform: rotate(3deg) scale(1.02); }
}
button.attention { animation: jiggle 0.75s ease-in-out 2; }

@media (prefers-reduced-motion: reduce) {
	button.attention { animation: none; }
}
</style>
<button type="button"></button>`;

		const button = shadow.querySelector("button");
		button.textContent = label;
		if (attention) button.classList.add("attention");
		button.title = title || label;
		button.setAttribute("aria-label", title || label);

		document.body.appendChild(host);
		floatingHost = host;

		const saved = await store.get(KEY.buttonPos, null);
		const clamp = () => {
			const maxX = window.innerWidth - button.offsetWidth;
			const maxY = window.innerHeight - button.offsetHeight;
			button.style.left =
				Math.max(0, Math.min(button.offsetLeft, maxX)) + "px";
			button.style.top = Math.max(0, Math.min(button.offsetTop, maxY)) + "px";
			button.style.right = "auto";
		};

		if (saved && typeof saved.x === "number") {
			button.style.left = saved.x + "px";
			button.style.top = saved.y + "px";
			button.style.right = "auto";
			clamp();
		}

		window.addEventListener("resize", clamp);

		let dragging = false;
		let moved = false;
		let suppressClick = false;
		let startX = 0;
		let startY = 0;
		let startLeft = 0;
		let startTop = 0;

		button.addEventListener("pointerdown", (event) => {
			dragging = true;
			moved = false;
			startX = event.clientX;
			startY = event.clientY;

			const rect = button.getBoundingClientRect();
			startLeft = rect.left;
			startTop = rect.top;

			try {
				button.setPointerCapture(event.pointerId);
			} catch {
				/* not fatal */
			}
		});

		button.addEventListener("pointermove", (event) => {
			if (!dragging) return;

			const dx = event.clientX - startX;
			const dy = event.clientY - startY;
			if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;

			button.style.left =
				Math.min(
					Math.max(0, startLeft + dx),
					window.innerWidth - button.offsetWidth,
				) + "px";
			button.style.top =
				Math.min(
					Math.max(0, startTop + dy),
					window.innerHeight - button.offsetHeight,
				) + "px";
			button.style.right = "auto";
		});

		const endDrag = (event) => {
			if (!dragging) return;
			dragging = false;

			if (moved) {
				suppressClick = true;
				store.set(KEY.buttonPos, {
					x: button.offsetLeft,
					y: button.offsetTop,
				});
				setTimeout(() => {
					suppressClick = false;
				}, 0);
			}

			try {
				if (button.hasPointerCapture(event.pointerId)) {
					button.releasePointerCapture(event.pointerId);
				}
			} catch {
				/* not fatal */
			}
		};

		button.addEventListener("pointerup", endDrag);
		button.addEventListener("pointercancel", endDrag);

		button.addEventListener("click", (event) => {
			if (suppressClick) {
				event.preventDefault();
				event.stopImmediatePropagation();
				return;
			}
			onActivate();
		});

		host._cleanup = () => {
			window.removeEventListener("resize", clamp);
		};

		return host;
	}

	function removeFloatingButton() {
		if (!floatingHost) return;
		floatingHost._cleanup?.();
		floatingHost.remove();
		floatingHost = null;
	}

	/* ------------------------------------------------------------------ *
	 * Sidebar shell
	 * ------------------------------------------------------------------ */

	function closeSidebar() {
		if (!sidebarHost) return;
		sidebarHost._cleanup?.();
		sidebarHost.remove();
		sidebarHost = null;
	}

	async function createSidebar() {
		closeSidebar();
		removeFloatingButton();

		const savedWidth = await store.get(KEY.width, 440);
		const width = Math.min(
			Math.max(Number(savedWidth) || 440, 300),
			Math.round(window.innerWidth * 0.9),
		);

		const host = document.createElement("div");
		host.style.cssText = "all:initial;position:static;";
		const shadow = host.attachShadow({ mode: "open" });

		shadow.innerHTML = `
<style>
:host { all: initial; }

#panel {
	--bg: #f6f6ef;
	--fg: #14161a;
	--muted: #767676;
	--rule: #dcdcd0;
	--accent: #ff6600;
	--accent-fg: #1a1a1a;
	--link: #0b3c8c;
	--surface: rgba(0, 0, 0, 0.035);

	position: fixed;
	top: 0;
	right: 0;
	height: 100vh;
	width: ${width}px;
	min-width: 300px;
	max-width: 90vw;
	z-index: 2147483646;
	display: flex;
	flex-direction: column;
	background: var(--bg);
	color: var(--fg);
	border-left: 1px solid var(--rule);
	box-shadow: -4px 0 18px rgba(0, 0, 0, 0.18);
	font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
		Helvetica, Arial, sans-serif;
	box-sizing: border-box;
}

#panel[data-theme="dark"] {
	--bg: #15171b;
	--fg: #dfe3e8;
	--muted: #8b949e;
	--rule: #2b3037;
	--accent: #d4530a;
	--accent-fg: #ffffff;
	--link: #9ecbff;
	--surface: rgba(255, 255, 255, 0.05);
	box-shadow: -4px 0 18px rgba(0, 0, 0, 0.55);
}

#panel * { box-sizing: border-box; }

#resizer {
	position: absolute;
	left: 0;
	top: 0;
	width: 7px;
	height: 100%;
	cursor: col-resize;
	background: transparent;
	touch-action: none;
}
#resizer:hover,
#resizer.active { background: var(--accent); opacity: 0.55; }

header {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 7px 9px 7px 12px;
	background: var(--accent);
	color: var(--accent-fg);
	font-weight: 700;
}
header .brand { flex: 1 1 auto; letter-spacing: 0.2px; }
header .count { font-weight: 400; opacity: 0.85; font-size: 11px; }
header button {
	background: rgba(0, 0, 0, 0.12);
	border: 0;
	border-radius: 3px;
	color: inherit;
	cursor: pointer;
	font-family: inherit;
	font-size: 12px;
	font-weight: 600;
	line-height: 1;
	padding: 5px 7px;
}
header button:hover { background: rgba(0, 0, 0, 0.24); }

#body {
	flex: 1 1 auto;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 10px 12px 40px;
	overscroll-behavior: contain;
	word-wrap: break-word;
}

.status { color: var(--muted); padding: 12px 2px; }
.status.error { color: #c0392b; }
#panel[data-theme="dark"] .status.error { color: #ff8b7a; }

.thread + .thread { border-top: 1px solid var(--rule); margin-top: 18px; padding-top: 14px; }

.story-title { font-size: 15px; font-weight: 600; }
.story-title a { color: var(--fg); text-decoration: none; }
.story-title a:hover { text-decoration: underline; }
.story-meta { color: var(--muted); font-size: 11px; margin-top: 3px; }
.story-text { margin-top: 8px; padding: 8px 10px; background: var(--surface); border-radius: 4px; }
.story-actions { display: flex; gap: 6px; margin: 9px 0 4px; flex-wrap: wrap; }
.story-actions button {
	background: var(--surface);
	border: 1px solid var(--rule);
	border-radius: 3px;
	color: var(--fg);
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	line-height: 1;
	padding: 5px 8px;
}
.story-actions button:hover { border-color: var(--accent); }

.c { margin: 11px 0; }
.kids { margin-left: 11px; padding-left: 9px; border-left: 1px solid var(--rule); }
.kids.flat { margin-left: 0; padding-left: 0; border-left: 0; }

.meta { color: var(--muted); font-size: 11px; display: flex; align-items: baseline; gap: 5px; flex-wrap: wrap; }
.meta a { color: var(--muted); text-decoration: none; }
.meta a:hover { text-decoration: underline; }
.meta .user { font-weight: 600; }
.meta .sep { opacity: 0.5; }
.tg {
	background: none;
	border: 0;
	color: var(--muted);
	cursor: pointer;
	font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
	padding: 0 2px 0 0;
}
.tg:hover { color: var(--accent); }
.kidnote { display: none; }

.body { margin-top: 4px; }
.body p { margin: 8px 0; }
.body p:first-child { margin-top: 0; }
.body a { color: var(--link); overflow-wrap: anywhere; }
.body pre {
	background: var(--surface);
	border-radius: 4px;
	font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	margin: 8px 0;
	max-width: 100%;
	overflow-x: auto;
	padding: 8px;
}
.body code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.body blockquote { border-left: 2px solid var(--rule); color: var(--muted); margin: 8px 0; padding-left: 9px; }

.c.collapsed > .body,
.c.collapsed > .kids { display: none; }
.c.collapsed > .meta > .kidnote { display: inline; }

.more {
	background: var(--surface);
	border: 1px dashed var(--rule);
	border-radius: 3px;
	color: var(--muted);
	cursor: pointer;
	display: block;
	font-family: inherit;
	font-size: 11px;
	line-height: 1;
	margin: 6px 0;
	padding: 6px 8px;
	text-align: left;
	width: 100%;
}
.more:hover { border-color: var(--accent); color: var(--fg); }

.note { color: var(--muted); font-size: 11px; font-style: italic; margin: 12px 0; }
</style>

<div id="panel" data-theme="light">
	<div id="resizer" title="drag to resize"></div>
	<header>
		<span class="brand">Threadside</span>
		<span class="count"></span>
		<button id="minimize" type="button" title="Minimize to a button">Hide</button>
		<button id="close" type="button" title="Close (Esc)">Close</button>
	</header>
	<div id="body"><div class="status">Loading...</div></div>
</div>`;

		document.body.appendChild(host);
		sidebarHost = host;

		const panel = shadow.querySelector("#panel");
		const body = shadow.querySelector("#body");
		const countLabel = shadow.querySelector(".count");

		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const applyTheme = () => panel.setAttribute("data-theme", resolveTheme());
		applyTheme();
		media.addEventListener("change", applyTheme);

		/* Resize. A dedicated handle element rather than a hit test on the
		 * panel: offsetX on a delegated listener is relative to event.target,
		 * so "within 8px of the left edge" silently meant "within 8px of the
		 * left edge of whatever child you clicked". */
		const resizer = shadow.querySelector("#resizer");
		let resizeTimer = null;
		let destroyed = false;

		resizer.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			resizer.classList.add("active");

			const startX = event.clientX;
			const startWidth = panel.offsetWidth;

			const previousUserSelect = document.body.style.userSelect;
			const previousCursor = document.body.style.cursor;
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";

			const onMove = (moveEvent) => {
				const nextWidth = Math.min(
					Math.max(startWidth + (startX - moveEvent.clientX), 300),
					Math.round(window.innerWidth * 0.9),
				);
				panel.style.width = nextWidth + "px";

				clearTimeout(resizeTimer);
				resizeTimer = setTimeout(() => {
					if (!destroyed) store.set(KEY.width, nextWidth);
				}, 200);
			};

			const onUp = () => {
				resizer.classList.remove("active");
				document.body.style.userSelect = previousUserSelect;
				document.body.style.cursor = previousCursor;
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onUp);
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onUp);
		});

		const onKeyDown = (event) => {
			if (event.key === "Escape" && sidebarHost === host) {
				closeSidebar();
				showFloatingButton("HN", "Reopen the discussion", lastOpenedIds);
			}
		};
		document.addEventListener("keydown", onKeyDown, true);

		host._cleanup = () => {
			destroyed = true;
			clearTimeout(resizeTimer);
			media.removeEventListener("change", applyTheme);
			document.removeEventListener("keydown", onKeyDown, true);
		};

		shadow.querySelector("#close").onclick = () => {
			closeSidebar();
			showFloatingButton("HN", "Reopen the discussion", lastOpenedIds);
		};

		shadow.querySelector("#minimize").onclick = () => {
			panel.style.display = "none";
			showFloatingButton("HN", "Show the discussion", null, () => {
				removeFloatingButton();
				panel.style.display = "";
			});
		};

		return {
			host,
			shadow,
			body,
			setCount(text) {
				countLabel.textContent = text || "";
			},
			setStatus(text) {
				body.innerHTML = "";
				const div = document.createElement("div");
				div.className = "status";
				div.textContent = text;
				body.appendChild(div);
			},
			setError(text) {
				body.innerHTML = "";
				const div = document.createElement("div");
				div.className = "status error";
				div.textContent = text;
				body.appendChild(div);
			},
		};
	}

	let lastOpenedIds = null;

	function showFloatingButton(label, title, ids, handler, attention) {
		createFloatingButton({
			label,
			title,
			attention,
			onActivate:
				handler ||
				(() => {
					removeFloatingButton();
					if (ids && ids.length) openDiscussion(ids);
					else manualLookup();
				}),
		}).catch((error) => debug("button failed", error));
	}

	/* ------------------------------------------------------------------ *
	 * Rendering
	 * ------------------------------------------------------------------ */

	function renderStoryHeader(story, container, onCollapseAll) {
		const link = story.url || HN + "/item?id=" + story.id;
		const safeLink = SAFE_HREF_RE.test(link) ? link : HN + "/item?id=" + story.id;

		const wrapper = document.createElement("div");
		wrapper.innerHTML = `
<div class="story-title">
	<a target="_blank" rel="noopener noreferrer" href="${escapeHTML(safeLink)}">${escapeHTML(story.title)}</a>
</div>
<div class="story-meta">
	${escapeHTML(plural(story.score, "point"))}
	by <a target="_blank" rel="noopener noreferrer" href="${escapeHTML(HN + "/user?id=" + encodeURIComponent(story.by))}">${escapeHTML(story.by)}</a>
	<span class="sep">|</span> ${escapeHTML(relTime(story.time))}
	${story.descendants === null ? "" : '<span class="sep">|</span> ' + escapeHTML(plural(story.descendants, "comment"))}
</div>
${story.text ? `<div class="story-text">${sanitizeHTML(story.text)}</div>` : ""}
<div class="story-actions">
	<button type="button" class="act-thread">open on HN</button>
	<button type="button" class="act-comment">add comment</button>
	<button type="button" class="act-collapse">collapse all</button>
</div>`;

		while (wrapper.firstChild) container.appendChild(wrapper.firstChild);

		container.querySelector(".act-thread").onclick = () =>
			openHNWindow(HN + "/item?id=" + story.id);
		container.querySelector(".act-comment").onclick = () =>
			openHNWindow(HN + "/item?id=" + story.id);

		const collapseButton = container.querySelector(".act-collapse");
		let collapsed = false;
		collapseButton.onclick = () => {
			collapsed = !collapsed;
			onCollapseAll(collapsed);
			collapseButton.textContent = collapsed ? "expand all" : "collapse all";
		};
	}

	function buildComment(node, depth, storyId) {
		const el = document.createElement("div");
		el.className = "c";
		el.dataset.id = String(node.id);

		const descendants = countDescendants(node);
		const userHref = HN + "/user?id=" + encodeURIComponent(node.by);

		const authorHTML = node.deleted
			? '<span class="user">[deleted]</span>'
			: `<a class="user" target="_blank" rel="noopener noreferrer" href="${escapeHTML(userHref)}">${escapeHTML(node.by || "anonymous")}</a>`;

		el.innerHTML = `
<div class="meta">
	<button class="tg" type="button" aria-expanded="true" title="Collapse this comment">[-]</button>
	${authorHTML}
	<span class="sep">|</span><time>${escapeHTML(relTime(node.time))}</time>
	<span class="sep">|</span><a class="permalink" target="_blank" rel="noopener noreferrer" href="${escapeHTML(HN + "/item?id=" + node.id)}">link</a>
	${node.deleted ? "" : '<span class="sep">|</span><a class="reply" href="#">reply</a>'}
	${descendants ? `<span class="kidnote">(${escapeHTML(plural(descendants, "reply", "replies"))})</span>` : ""}
</div>
<div class="body">${node.deleted ? "<em>[deleted]</em>" : sanitizeHTML(node.text)}</div>
<div class="kids${depth >= INDENT_MAX_DEPTH ? " flat" : ""}"></div>`;

		const toggle = el.querySelector(".tg");
		toggle.onclick = () => {
			const collapsed = el.classList.toggle("collapsed");
			toggle.textContent = collapsed ? "[+]" : "[-]";
			toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
			toggle.title = collapsed ? "Expand this comment" : "Collapse this comment";
		};

		const reply = el.querySelector(".reply");
		if (reply) {
			reply.onclick = (event) => {
				event.preventDefault();
				openHNWindow(replyURL(node.id, storyId));
			};
		}

		const kids = el.querySelector(".kids");
		const children = node.children || [];

		if (children.length) {
			if (depth >= LAZY_DEPTH && descendants >= LAZY_MIN_DESCENDANTS) {
				const more = document.createElement("button");
				more.type = "button";
				more.className = "more";
				more.textContent =
					"show " + plural(descendants, "reply", "replies") + " ->";
				more.onclick = () => {
					more.remove();
					for (const child of children) {
						kids.appendChild(buildComment(child, depth + 1, storyId));
					}
				};
				kids.appendChild(more);
			} else {
				for (const child of children) {
					kids.appendChild(buildComment(child, depth + 1, storyId));
				}
			}
		}

		return el;
	}

	async function renderTopLevel(children, container, storyId) {
		for (let index = 0; index < children.length; index += RENDER_CHUNK) {
			const fragment = document.createDocumentFragment();

			for (const node of children.slice(index, index + RENDER_CHUNK)) {
				fragment.appendChild(buildComment(node, 0, storyId));
			}

			container.appendChild(fragment);

			if (index + RENDER_CHUNK < children.length) await nextFrame();
			if (!sidebarHost) return;
		}
	}

	async function renderThreads(threads, ui) {
		ui.body.innerHTML = "";

		const total = threads.reduce(
			(sum, thread) => sum + countTree(thread.children),
			0,
		);
		ui.setCount(
			threads.length > 1
				? threads.length + " submissions, " + plural(total, "comment")
				: plural(total, "comment"),
		);

		for (const thread of threads) {
			const section = document.createElement("div");
			section.className = "thread";
			ui.body.appendChild(section);

			const comments = document.createElement("div");
			comments.className = "kids flat";

			renderStoryHeader(thread.story, section, (collapse) => {
				for (const comment of comments.querySelectorAll(".c")) {
					comment.classList.toggle("collapsed", collapse);
					const toggle = comment.querySelector(":scope > .meta > .tg");
					if (toggle) {
						toggle.textContent = collapse ? "[+]" : "[-]";
						toggle.setAttribute("aria-expanded", collapse ? "false" : "true");
					}
				}
			});

			section.appendChild(comments);

			if (!thread.children.length) {
				const note = document.createElement("div");
				note.className = "note";
				note.textContent = "No comments on this submission yet.";
				section.appendChild(note);
				continue;
			}

			await renderTopLevel(thread.children, comments, thread.story.id);

			if (thread.truncated) {
				const note = document.createElement("div");
				note.className = "note";
				note.textContent =
					"Thread truncated at " +
					FALLBACK_COMMENT_CAP +
					" comments (index unavailable, fell back to per-comment fetching). Open on HN for the rest.";
				section.appendChild(note);
			}
		}
	}

	/* ------------------------------------------------------------------ *
	 * Opening
	 * ------------------------------------------------------------------ */

	async function openDiscussion(storyIds) {
		if (opening) return;
		opening = true;
		lastOpenedIds = storyIds.slice();

		let ui;
		try {
			ui = await createSidebar();
			ui.setStatus("Loading discussion...");

			const threads = (await mapLimit(storyIds, 3, fetchThread)).filter(Boolean);

			if (!sidebarHost) return;

			if (!threads.length) {
				ui.setError("Could not load that thread. Hacker News may be unreachable.");
				return;
			}

			threads.sort((a, b) => (b.story.time || 0) - (a.story.time || 0));
			await renderThreads(threads, ui);
		} catch (error) {
			debug("open failed", error);
			if (ui) ui.setError("Something went wrong loading the discussion.");
		} finally {
			opening = false;
		}
	}

	async function manualLookup() {
		const ui = await createSidebar();
		ui.setStatus("Looking for a Hacker News discussion...");

		const stories = await findStories(location.href, { useCache: false });

		if (!sidebarHost) return;

		if (!stories.length) {
			ui.setError("No Hacker News submission found for this URL.");
			return;
		}

		// openDiscussion recreates the shell, so there is no need to close first.
		await openDiscussion(stories.map((story) => story.id));
	}

	/* ------------------------------------------------------------------ *
	 * Hacker News click tracking
	 *
	 * A list rather than a single slot, so opening several stories in
	 * background tabs works instead of only the most recent one.
	 * ------------------------------------------------------------------ */

	function setupHNListener() {
		document.addEventListener(
			"click",
			async (event) => {
				try {
					const link = event.target.closest?.("a");
					if (!link || !link.href) return;
					if (!link.closest(".titleline")) return;

					const row = link.closest("tr.athing");
					if (!row || !row.id) return;

					const now = Date.now();
					const canonical = canonicalize(link.href);
					if (!canonical) return;

					const recent = (await store.get(KEY.recent, [])).filter(
						(entry) => now - entry.t < RECENT_TTL_MS,
					);

					const existing = recent.find((entry) => entry.c === canonical);
					if (existing) {
						if (!existing.ids.includes(row.id)) existing.ids.push(row.id);
						existing.t = now;
					} else {
						recent.push({ c: canonical, ids: [row.id], t: now });
					}

					await store.set(KEY.recent, recent.slice(-MAX_RECENT));
					debug("recorded click", row.id, canonical);
				} catch (error) {
					debug("click tracking failed", error);
				}
			},
			true,
		);
	}

	async function takeRecentIdsForThisPage() {
		const now = Date.now();
		const recent = await store.get(KEY.recent, []);
		const canonical = canonicalize(location.href);
		if (!canonical) return [];

		const fresh = recent.filter((entry) => now - entry.t < RECENT_TTL_MS);
		const mine = fresh.filter((entry) => entry.c === canonical);
		if (!mine.length) {
			if (fresh.length !== recent.length) await store.set(KEY.recent, fresh);
			return [];
		}

		await store.set(
			KEY.recent,
			fresh.filter((entry) => entry.c !== canonical),
		);

		return [...new Set(mine.flatMap((entry) => entry.ids))];
	}

	/* ------------------------------------------------------------------ *
	 * Menu commands
	 * ------------------------------------------------------------------ */

	async function saveSettings(patch) {
		settings = { ...settings, ...patch };
		await store.set(KEY.settings, settings);
	}

	function installMenu() {
		registerMenu("Show HN discussion for this page", () => {
			manualLookup().catch((error) => debug("manual lookup failed", error));
		});

		registerMenu(
			"Auto-detect: " + (settings.autoDetect ? "ON" : "OFF") + " (toggle)",
			async () => {
				await saveSettings({ autoDetect: !settings.autoDetect });
				alert(
					"Threadside auto-detect is now " +
						(settings.autoDetect ? "ON" : "OFF") +
						".\nReload the page for the menu label to update.",
				);
			},
		);

		registerMenu(
			"Auto-open sidebar: " + (settings.autoOpen ? "ON" : "OFF") + " (toggle)",
			async () => {
				await saveSettings({ autoOpen: !settings.autoOpen });
				alert(
					"Threadside will now " +
						(settings.autoOpen
							? "open the sidebar by itself when it finds a discussion."
							: "show a button instead of opening the sidebar.") +
						"\nReload the page for the menu label to update.",
				);
			},
		);

		const host = location.hostname.toLowerCase();
		const blocked = settings.blockedHosts.includes(host);

		registerMenu(
			(blocked ? "Unblock" : "Never look up") + " " + host,
			async () => {
				const list = new Set(settings.blockedHosts);
				if (blocked) list.delete(host);
				else list.add(host);
				await saveSettings({ blockedHosts: [...list] });
				alert(
					"Threadside will " +
						(blocked ? "now" : "no longer") +
						" look up pages on " +
						host +
						".",
				);
			},
		);

		registerMenu("Theme: " + settings.theme + " (cycle)", async () => {
			const order = ["auto", "light", "dark"];
			const next = order[(order.indexOf(settings.theme) + 1) % order.length];
			await saveSettings({ theme: next });
			alert("Threadside theme is now: " + next);
		});

		registerMenu("Clear cached lookups", async () => {
			await store.del(KEY.cache);
			alert("Threadside lookup cache cleared.");
		});
	}

	/* ------------------------------------------------------------------ *
	 * Keyboard shortcut
	 * ------------------------------------------------------------------ */

	function installShortcut() {
		if (!settings.shortcut) return;

		const parts = settings.shortcut.split("+").map((p) => p.trim().toLowerCase());
		const key = parts.pop();
		const needsAlt = parts.includes("alt");
		const needsShift = parts.includes("shift");
		const needsCtrl = parts.includes("ctrl") || parts.includes("control");
		const needsMeta = parts.includes("meta") || parts.includes("cmd");

		document.addEventListener("keydown", (event) => {
			if (event.altKey !== needsAlt) return;
			if (event.shiftKey !== needsShift) return;
			if (event.ctrlKey !== needsCtrl) return;
			if (event.metaKey !== needsMeta) return;
			if ((event.key || "").toLowerCase() !== key && event.code !== "Key" + key.toUpperCase()) {
				return;
			}

			event.preventDefault();

			if (sidebarHost) {
				closeSidebar();
				return;
			}
			manualLookup().catch((error) => debug("shortcut lookup failed", error));
		});
	}

	/* ------------------------------------------------------------------ *
	 * Single-page-app navigation
	 * ------------------------------------------------------------------ */

	function watchNavigation() {
		const check = () => {
			if (location.href === currentHref) return;
			currentHref = location.href;
			debug("navigated", currentHref);

			closeSidebar();
			removeFloatingButton();
			lastOpenedIds = null;

			detect().catch((error) => debug("detect failed", error));
		};

		window.addEventListener("popstate", () => setTimeout(check, 50));
		window.addEventListener("hashchange", () => setTimeout(check, 50));
		setInterval(check, 2000);
	}

	/* ------------------------------------------------------------------ *
	 * Detection
	 * ------------------------------------------------------------------ */

	async function detect() {
		// Arrived here by clicking a story on HN? Open that exact thread, with
		// no lookup request at all.
		const clickedIds = await takeRecentIdsForThisPage();
		if (clickedIds.length) {
			debug("opening from recorded click", clickedIds);
			await openDiscussion(clickedIds);
			return;
		}

		const blocked = autoDetectBlockedReason();
		if (blocked) {
			debug("auto-detect skipped:", blocked);
			return;
		}

		const stories = await findStories(location.href);
		if (!stories.length) return;

		const ids = stories.map((story) => story.id);

		// Always the button unless you asked for the sidebar to open itself.
		// isMobile() no longer decides this: a narrow window was never the only
		// reason to want a say in it.
		if (!settings.autoOpen || isMobile()) {
			const comments = stories.reduce((sum, s) => sum + (s.comments || 0), 0);
			showFloatingButton(
				comments ? "HN " + comments : "HN",
				stories.length > 1
					? stories.length + " Hacker News discussions for this page"
					: "Hacker News discussion, " + plural(comments, "comment"),
				ids,
				null,
				true,
			);
			return;
		}

		await openDiscussion(ids);
	}

	/* ------------------------------------------------------------------ *
	 * Boot
	 * ------------------------------------------------------------------ */

	async function main() {
		if (!claimDocument()) {
			debug("another instance already owns this document, standing down");
			return;
		}

		const stored = await store.get(KEY.settings, {});
		settings = { ...DEFAULTS, ...(stored || {}) };
		if (!Array.isArray(settings.blockedHosts)) settings.blockedHosts = [];

		installMenu();

		if (
			location.hostname === "news.ycombinator.com" ||
			location.hostname === "hn.algolia.com"
		) {
			setupHNListener();
			return;
		}

		installShortcut();
		watchNavigation();
		await detect();
	}

	main().catch((error) => debug("boot failed", error));
})();
