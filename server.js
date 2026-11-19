// Small always-on server for Railway.
//
// What it does:
//  1. Uses a real (headless) browser to log into panel.lamix.org with your
//     admin username/password, exactly like a person typing them in.
//  2. Keeps that logged-in browser session alive in memory.
//  3. Exposes one endpoint, /cli-search?cli=..., that uses the logged-in
//     session to call Lamix's own /api/cli-search endpoint and returns the
//     JSON straight through.
//  4. If Lamix says the session is no longer valid (401/403), it logs in
//     again automatically and retries once - no human needs to touch a
//     cookie.
//
// Required environment variables (set these in Railway's "Variables" tab,
// never in this file):
//   LAMIX_USERNAME   - your admin username/email
//   LAMIX_PASSWORD   - your admin password
//   API_SECRET       - a random string you make up yourself. Your Netlify
//                       function must send this same value in the
//                       "x-api-key" header, or requests are rejected.
//
// Optional:
//   LAMIX_BASE_URL   - defaults to https://panel.lamix.org
//   LAMIX_LOGIN_URL  - defaults to <LAMIX_BASE_URL>/login
//   PORT             - Railway sets this automatically

const express = require("express");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.LAMIX_BASE_URL || "https://panel.lamix.org").replace(/\/$/, "");
const LOGIN_URL = process.env.LAMIX_LOGIN_URL || `${BASE_URL}/login`;
const USERNAME = process.env.LAMIX_USERNAME;
const PASSWORD = process.env.LAMIX_PASSWORD;
const API_SECRET = process.env.API_SECRET;

if (!USERNAME || !PASSWORD) {
  console.error("[startup] Missing LAMIX_USERNAME or LAMIX_PASSWORD env vars.");
}
if (!API_SECRET) {
  console.error(
    "[startup] Missing API_SECRET env var. Requests will be rejected until you set one."
  );
}

// ---- Cost-saving settings (all optional env vars) -------------------------
// Railway bills RAM by the hour, and a headless Chromium needs a few hundred
// MB. So the browser is only kept alive while it is being used and is closed
// after BROWSER_IDLE_MS of silence. The login cookies are kept in memory, so
// the next request re-opens the browser WITHOUT logging in again.
const IDLE_MS = Number(process.env.BROWSER_IDLE_MS || 45000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30000); // 0 = off
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT || 2));

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let browser = null;
let browserPromise = null;
let context = null;
let storageState = null; // saved cookies/localStorage from the last good login
let loginPromise = null; // acts as a lock so concurrent requests don't log in twice
let activeJobs = 0;
let idleTimer = null;

async function getBrowser() {
  if (browser) return browser;
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--mute-audio",
          "--js-flags=--max-old-space-size=192",
        ],
      })
      .then((b) => {
        browser = b;
        b.on("disconnected", () => {
          if (browser === b) {
            browser = null;
            context = null;
          }
        });
        return b;
      })
      .finally(() => {
        browserPromise = null;
      });
  }
  return browserPromise;
}

// New context that skips images/fonts/media: the results table is plain text,
// so downloading these only wastes CPU, memory and bandwidth.
async function makeContext(state) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: USER_AGENT,
    ...(state ? { storageState: state } : {}),
  });
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "font" || t === "media") return route.abort();
    return route.continue();
  });
  return ctx;
}

async function closeBrowser() {
  const c = context;
  const b = browser;
  context = null;
  browser = null;
  if (c) await c.close().catch(() => {});
  if (b) await b.close().catch(() => {});
  console.log("[browser] Closed (idle).");
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  if (IDLE_MS <= 0) return;
  idleTimer = setTimeout(() => {
    if (activeJobs === 0 && (browser || context)) closeBrowser();
  }, IDLE_MS);
}

// Short description of the current page, used in error messages so a failed
// login can be diagnosed without opening the site by hand.
async function describePage(page) {
  try {
    const info = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"))
        .slice(0, 5)
        .map((e) => [e.type || "text", e.name, e.id].filter(Boolean).join("/"));
      const text = (document.body && document.body.innerText) || "";
      return {
        title: document.title,
        inputs,
        text: text.replace(/\s+/g, " ").trim().slice(0, 90),
      };
    });
    const path = new URL(page.url()).pathname;
    return `[page ${path} | title "${info.title.slice(0, 40)}" | inputs: ${
      info.inputs.join(", ") || "none"
    } | text: "${info.text}"]`;
  } catch (e) {
    return "[could not read page]";
  }
}

async function login() {
  console.log("[login] Logging in...");
  const newContext = await makeContext(null);
  const page = await newContext.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // The login form may be drawn by JavaScript after the page loads, so
    // wait for the password box to actually appear before looking for fields.
    const passField = page.locator('input[type="password"]:visible').first();
    try {
      await passField.waitFor({ state: "visible", timeout: 20000 });
    } catch (e) {
      throw new Error("Login form did not appear. " + (await describePage(page)));
    }

    // Username box: try known names first, then fall back to the first
    // visible text-like input on the page.
    const userSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[name="login"]',
      'input[type="email"]',
      "input#username",
      "input#email",
      'input[placeholder*="sername" i]',
      'input[placeholder*="mail" i]',
      'input[placeholder*="ogin" i]',
      'input[type="text"]',
      "input:not([type])",
    ];
    let userField = null;
    for (const sel of userSelectors) {
      const el = page.locator(`${sel}:visible`).first();
      if ((await el.count()) > 0) {
        userField = el;
        break;
      }
    }
    if (!userField) {
      throw new Error("Username field not found. " + (await describePage(page)));
    }

    await userField.fill(USERNAME);
    await passField.fill(PASSWORD);

    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'input[type="submit"]',
      "button:visible",
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      const el = page.locator(`${sel}:visible`).first();
      if ((await el.count()) > 0) {
        await el.click();
        submitted = true;
        break;
      }
    }
    if (!submitted) await passField.press("Enter");

    // Success = the password box goes away (we left the login page).
    await passField.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const stillThere = (await page.locator('input[type="password"]:visible').count()) > 0;
    if (stillThere) {
      throw new Error(
        "Login did not succeed - still on the login page. Check LAMIX_USERNAME / LAMIX_PASSWORD. " +
          (await describePage(page))
      );
    }
  } catch (err) {
    await page.close().catch(() => {});
    await newContext.close().catch(() => {});
    throw err;
  }

  await page.close().catch(() => {});
  console.log("[login] Logged in successfully.");

  storageState = await newContext.storageState().catch(() => null);
  if (context) {
    await context.close().catch(() => {});
  }
  context = newContext;
  return newContext;
}

async function ensureLoggedIn() {
  if (context) return context;
  if (!loginPromise) {
    loginPromise = (async () => {
      // Re-open from saved cookies if we have them (cheap), else log in.
      if (storageState) {
        context = await makeContext(storageState);
        return context;
      }
      return login();
    })().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

async function dropSession() {
  const c = context;
  context = null;
  storageState = null;
  if (c) await c.close().catch(() => {});
}

const CLI_SEARCH_PATH = process.env.LAMIX_CLI_SEARCH_PATH || "/cli-search";

// Drives the real "CLI search" page the same way a logged-in admin would:
// open it, type the sender into the search box, click Search, then read
// the rendered results table. This uses the page's own scripts to make
// whatever signed request it needs - we never build that request ourselves.
async function searchViaPage(ctx, cli) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}${CLI_SEARCH_PATH}`, { waitUntil: "domcontentloaded", timeout: 30000 });

    if ((await page.locator('input[type="password"]:visible').count()) > 0) {
      throw new Error("SESSION_EXPIRED");
    }

    // Give client-side rendered forms a moment to finish drawing.
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);

    let input = page.getByLabel(/sender/i).first();
    if ((await input.count()) === 0) {
      input = page
        .locator(
          'input[type="text"]:visible, input[type="search"]:visible, ' +
            'input[type="email"]:visible, input[type="tel"]:visible, input:not([type]):visible'
        )
        .first();
    }
    if ((await input.count()) === 0) {
      // Last resort: any visible input at all (excluding obviously wrong kinds).
      input = page
        .locator(
          'input:visible:not([type="password"]):not([type="checkbox"]):not([type="radio"])' +
            ':not([type="hidden"]):not([type="submit"]):not([type="button"])'
        )
        .first();
    }
    if ((await input.count()) === 0) {
      throw new Error("Could not find the sender search box. " + (await describePage(page)));
    }
    await input.fill(cli);

    const btn = page.getByRole("button", { name: /search/i }).first();
    if ((await btn.count()) > 0) {
      await btn.click();
    } else {
      await input.press("Enter");
    }

    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);

    if ((await page.locator('input[type="password"]:visible').count()) > 0) {
      throw new Error("SESSION_EXPIRED");
    }

    const result = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      for (const t of tables) {
        const headRow = t.querySelector("thead") || t.rows[0];
        const headText = headRow ? headRow.innerText : "";
        if (!/range/i.test(headText)) continue;
        const bodyRows = t.querySelectorAll("tbody tr").length
          ? Array.from(t.querySelectorAll("tbody tr"))
          : Array.from(t.rows).slice(1);
        return {
          rows: bodyRows
            .map((r) => {
              const cells = r.querySelectorAll("td");
              return {
                range: cells[0] ? cells[0].innerText.trim() : "",
                lastSeen: cells[1] ? cells[1].innerText.trim() : "",
              };
            })
            .filter((r) => r.range),
        };
      }
      const text = (document.body.innerText || "");
      if (/no (ranges|results|data|matches)/i.test(text)) return { rows: [] };
      return null;
    });

    if (result === null) {
      throw new Error("Could not find a results table on the CLI search page after searching.");
    }
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

async function searchCli(cli) {
  let ctx = await ensureLoggedIn();
  try {
    return await searchViaPage(ctx, cli);
  } catch (err) {
    if (err && err.message === "SESSION_EXPIRED") {
      await dropSession();
      ctx = await ensureLoggedIn();
      return await searchViaPage(ctx, cli);
    }
    throw err;
  }
}

// Limit how many pages run at once (each one costs RAM), and queue the rest.
const waiting = [];
async function withSlot(fn) {
  if (activeJobs >= MAX_CONCURRENT) {
    await new Promise((resolve) => waiting.push(resolve));
  } else {
    activeJobs++;
  }
  clearTimeout(idleTimer);
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // hand the slot straight to the next waiter
    else activeJobs--;
    if (activeJobs === 0) scheduleIdleClose();
  }
}

// Same sender asked again within CACHE_TTL_MS -> answer from memory, and
// identical simultaneous requests share one browser run.
const cache = new Map(); // cli -> { t, data }
const inflight = new Map(); // cli -> Promise

async function cachedSearch(cli) {
  const hit = cache.get(cli);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;
  if (inflight.has(cli)) return inflight.get(cli);
  const p = withSlot(() => searchCli(cli))
    .then((data) => {
      if (CACHE_TTL_MS > 0) {
        cache.set(cli, { t: Date.now(), data });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
      }
      return data;
    })
    .finally(() => inflight.delete(cli));
  inflight.set(cli, p);
  return p;
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/cli-search", async (req, res) => {
  if (API_SECRET) {
    if (req.header("x-api-key") !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const cli = String(req.query.cli || "").trim();
  if (!cli) {
    return res.status(400).json({ error: "Missing required query parameter: cli" });
  }

  try {
    const data = await cachedSearch(cli);
    res.json(data);
  } catch (err) {
    console.error("[cli-search]", err);
    res
      .status(502)
      .json({ error: "Failed to fetch from Lamix.", detail: String((err && err.message) || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Lamix proxy listening on port ${PORT}`);
});
