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

let browser = null;
let context = null;
let authHeader = null; // token the panel uses for its own API calls, if it uses one
let loginPromise = null; // acts as a lock so concurrent requests don't log in twice

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
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
  const b = await getBrowser();
  const newContext = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await newContext.newPage();
  let capturedAuth = null;

  // The panel may keep its session in a token (Authorization header) instead
  // of a cookie. Watch its own API calls and remember the header it uses.
  page.on("request", (r) => {
    try {
      if (!r.url().includes("/api/")) return;
      const h = r.headers();
      if (h["authorization"]) capturedAuth = h["authorization"];
    } catch (e) {}
  });

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

  if (!capturedAuth) {
    // Fallback: look for a token the page stored in the browser.
    const tok = await page
      .evaluate(() => {
        const pairs = [];
        for (const st of [window.localStorage, window.sessionStorage]) {
          for (let i = 0; i < st.length; i++) pairs.push([st.key(i), st.getItem(st.key(i)) || ""]);
        }
        for (const [, v] of pairs) {
          const m = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
          if (m) return m[0];
        }
        for (const [k, v] of pairs) {
          if (/token|auth|jwt/i.test(k) && v && v.length < 2000) {
            try {
              const j = JSON.parse(v);
              if (typeof j === "string") return j;
              if (j && (j.token || j.access_token)) return j.token || j.access_token;
            } catch (e) {
              return v;
            }
          }
        }
        return "";
      })
      .catch(() => "");
    if (tok) capturedAuth = "Bearer " + tok;
  }
  authHeader = capturedAuth;

  await page.close().catch(() => {});
  console.log("[login] Logged in successfully." + (authHeader ? " (token found)" : " (cookie session)"));

  if (context) {
    await context.close().catch(() => {});
  }
  context = newContext;
  return newContext;
}

async function ensureLoggedIn() {
  if (context) return context;
  if (!loginPromise) {
    loginPromise = login().finally(() => {
      loginPromise = null;
    });
  }
  return loginPromise;
}

function apiGet(ctx, cli) {
  const headers = authHeader ? { authorization: authHeader } : {};
  return ctx.request.get(`${BASE_URL}/api/cli-search?cli=${encodeURIComponent(cli)}`, { headers });
}

async function searchCli(cli) {
  let ctx = await ensureLoggedIn();
  let res = await apiGet(ctx, cli);

  if (res.status() === 401 || res.status() === 403) {
    // Session expired mid-flight - log in again once and retry.
    context = null;
    ctx = await ensureLoggedIn();
    res = await apiGet(ctx, cli);
  }

  if (!res.ok()) {
    let body = "";
    try {
      body = (await res.text()).replace(/\s+/g, " ").slice(0, 120);
    } catch (e) {}
    throw new Error(
      `Lamix returned HTTP ${res.status()} (auth: ${authHeader ? "token" : "cookie only"}) ${body}`
    );
  }
  return res.json();
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
    const data = await searchCli(cli);
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
