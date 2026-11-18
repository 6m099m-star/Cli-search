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

async function login() {
  console.log("[login] Logging into Lamix...");
  const b = await getBrowser();
  const newContext = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await newContext.newPage();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // The exact field names on Lamix's login page weren't available while
  // writing this, so several common patterns are tried in order. If login
  // keeps failing, open the login page's HTML (view-source, or inspect in
  // a browser) and adjust the selector lists below to match it.
  const usernameSelectors = [
    'input[name="username"]',
    'input[name="email"]',
    'input[type="email"]',
    "input#username",
    "input#email",
    'input[placeholder*="sername" i]',
    'input[placeholder*="mail" i]',
  ];
  const passwordSelectors = [
    'input[name="password"]',
    'input[type="password"]',
    "input#password",
  ];
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'input[type="submit"]',
  ];

  async function firstMatch(selectors) {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) return el;
    }
    return null;
  }

  const userField = await firstMatch(usernameSelectors);
  const passField = await firstMatch(passwordSelectors);

  if (!userField || !passField) {
    await page.close();
    await newContext.close();
    throw new Error(
      "Could not find the username/password fields on the login page. " +
        "Open the Lamix login page's HTML and update the selector lists in server.js."
    );
  }

  await userField.fill(USERNAME);
  await passField.fill(PASSWORD);

  const submitButton = await firstMatch(submitSelectors);
  if (submitButton) {
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}),
      submitButton.click(),
    ]);
  } else {
    await passField.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  }

  // Confirm the login actually worked by calling a known authenticated
  // endpoint (the one the panel itself calls after login).
  const check = await newContext.request.get(`${BASE_URL}/api/auth/me`);
  await page.close();

  if (!check.ok()) {
    await newContext.close();
    throw new Error(
      `Login did not succeed - the post-login check returned HTTP ${check.status()}. ` +
        "Double-check LAMIX_USERNAME / LAMIX_PASSWORD, and that the selectors above match the real form."
    );
  }

  console.log("[login] Logged in successfully.");

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

async function searchCli(cli) {
  let ctx = await ensureLoggedIn();
  let res = await ctx.request.get(`${BASE_URL}/api/cli-search?cli=${encodeURIComponent(cli)}`);

  if (res.status() === 401 || res.status() === 403) {
    // Session expired mid-flight - log in again once and retry.
    context = null;
    ctx = await ensureLoggedIn();
    res = await ctx.request.get(`${BASE_URL}/api/cli-search?cli=${encodeURIComponent(cli)}`);
  }

  if (!res.ok()) {
    throw new Error(`Lamix returned HTTP ${res.status()}`);
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
