// Functional test of src/common/workday_auth.js in jsdom.
//
// Covers: state detection (signin / create / none), host gating, a successful
// fill+submit on a React-style controlled form (simulated by unmounting the
// form on submit), create-account with the email-verification interstitial,
// and the error-banner failure path.

const { loadDom, evalScript, report } = require("./helpers");
const fs = require("fs");
const path = require("path");

// Exercise the panel's credential gate as well as the injected runtime's gate.
const panelSource = fs.readFileSync(path.join(__dirname, "../src/sidepanel.js"), "utf8");
const panelGate = panelSource.match(/function workdayHostOf\(url\) \{[\s\S]*?\n\}/)[0];
const panelSuffixes = panelSource.match(/const WORKDAY_HOST_SUFFIX\w* = [^;]+;/)[0];

const WD_URL = "https://acme.wd5.myworkdayjobs.com/en-US/careers/login";

function signinHTML() {
  return `<!DOCTYPE html><html><body>
    <form id="auth">
      <input data-automation-id="email" type="email">
      <input data-automation-id="password" type="password">
      <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
    </form>
  </body></html>`;
}

function createHTML() {
  return `<!DOCTYPE html><html><body>
    <form id="auth">
      <input data-automation-id="email" type="email">
      <input data-automation-id="password" type="password">
      <input data-automation-id="verifyPassword" type="password">
      <input data-automation-id="createAccountCheckbox" type="checkbox">
      <button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>
    </form>
  </body></html>`;
}

function noAuthHTML() {
  return `<!DOCTYPE html><html><body><div>Just a job posting, no login.</div></body></html>`;
}

// Load workday_auth.js into a fresh jsdom at the given URL and return the window.
function armed(html, url) {
  const dom = loadDom(html, { url });
  evalScript(dom.window, "common/workday_auth.js");
  return dom.window;
}

async function main() {
  const checks = [];

  for (const url of [
    "https://notmyworkdayjobs.com/login",
    "https://notmyworkdaysite.com/login",
    "https://myworkdayjobs.com.evil.example/login",
    "http://acme.wd5.myworkdayjobs.com/login",
    "http://acme.wd1.myworkdaysite.com/login",
  ]) {
    const w = armed(signinHTML(), url);
    w.eval(panelSuffixes + "\n" + panelGate);
    let submitted = false;
    w.document.querySelector("button").addEventListener("click", () => {
      submitted = true;
      w.document.getElementById("auth").remove();
    });
    checks.push([`panel rejects ${url}`, w.workdayHostOf(url) === null]);
    checks.push([`runtime ignores ${url}`, w.__jobsmithWorkdayAuthState().state === "none"]);
    const out = await w.__jobsmithWorkdayAuth("audit@example.com", "dummy-password");
    checks.push([`credentials never filled/submitted on ${url}`,
      !out.ok && !submitted && w.document.querySelector("input[type='password']").value === ""]);
    w.close();
  }

  for (const url of [WD_URL, "https://acme.wd1.myworkdaysite.com/login"]) {
    const w = armed(signinHTML(), url);
    w.eval(panelSuffixes + "\n" + panelGate);
    checks.push([`panel accepts ${url}`, w.workdayHostOf(url) === new URL(url).hostname]);
    checks.push([`runtime accepts ${url}`, w.__jobsmithWorkdayAuthState().state === "signin"]);
    w.close();
  }

  // --- State detection --------------------------------------------------
  {
    const w = armed(signinHTML(), WD_URL);
    const s = w.__jobsmithWorkdayAuthState();
    checks.push(["signin form → state 'signin'", s.state === "signin"]);
    checks.push(["signin form → tenantHost reported", s.tenantHost === "acme.wd5.myworkdayjobs.com"]);
  }
  {
    const w = armed(createHTML(), WD_URL);
    const s = w.__jobsmithWorkdayAuthState();
    checks.push(["create form (verifyPassword) → state 'create'", s.state === "create"]);
  }
  {
    const w = armed(noAuthHTML(), WD_URL);
    checks.push(["no auth form → state 'none'", w.__jobsmithWorkdayAuthState().state === "none"]);
  }
  {
    // Host gating: a Workday-looking form on a non-Workday host is ignored.
    const w = armed(signinHTML(), "https://example.com/login");
    checks.push(["non-Workday host → state 'none'", w.__jobsmithWorkdayAuthState().state === "none"]);
    const out = await w.__jobsmithWorkdayAuth("a@b.com", "pw");
    checks.push(["non-Workday host → auth refuses", out.ok === false && /not a workday host/i.test(out.message)]);
  }

  // --- Successful sign-in (form unmounts on submit) ---------------------
  {
    const w = armed(signinHTML(), WD_URL);
    const doc = w.document;
    let filledEmail = null, filledPw = null;
    doc.querySelector("[data-automation-id='signInSubmitButton']").addEventListener("click", () => {
      // Capture what was filled, then simulate navigating past the auth wall.
      filledEmail = doc.querySelector("[data-automation-id='email']").value;
      filledPw = doc.querySelector("[data-automation-id='password']").value;
      doc.getElementById("auth").remove();
    });
    const out = await w.__jobsmithWorkdayAuth("me@example.com", "s3cret");
    checks.push(["sign-in success → ok", out.ok === true]);
    checks.push(["sign-in success → action 'signed_in'", out.action === "signed_in"]);
    checks.push(["sign-in filled email + password before submit",
      filledEmail === "me@example.com" && filledPw === "s3cret"]);
  }

  // --- Successful create + email-verification interstitial --------------
  {
    const w = armed(createHTML(), WD_URL);
    const doc = w.document;
    let verifyFilled = null, legalChecked = null;
    doc.querySelector("[data-automation-id='createAccountSubmitButton']").addEventListener("click", () => {
      verifyFilled = doc.querySelector("[data-automation-id='verifyPassword']").value;
      legalChecked = doc.querySelector("[data-automation-id='createAccountCheckbox']").checked;
      doc.getElementById("auth").remove();
      const v = doc.createElement("div");
      v.setAttribute("data-automation-id", "verifyEmailPage");
      v.textContent = "Verify your email to finish creating your account.";
      doc.body.appendChild(v);
    });
    const out = await w.__jobsmithWorkdayAuth("me@example.com", "s3cret");
    checks.push(["create success → ok", out.ok === true]);
    checks.push(["create success → action 'account_created'", out.action === "account_created"]);
    checks.push(["create success → pending flagged from verify screen", out.pending === true]);
    checks.push(["create fills verifyPassword + checks the legal box",
      verifyFilled === "s3cret" && legalChecked === true]);
  }

  // --- Error-banner failure path ----------------------------------------
  {
    const w = armed(signinHTML(), WD_URL);
    const doc = w.document;
    doc.querySelector("[data-automation-id='signInSubmitButton']").addEventListener("click", () => {
      const err = doc.createElement("div");
      err.setAttribute("data-automation-id", "errorMessage");
      err.textContent = "Invalid email or password.";
      doc.body.appendChild(err);
    });
    const out = await w.__jobsmithWorkdayAuth("me@example.com", "wrong");
    checks.push(["error banner → ok false", out.ok === false]);
    checks.push(["error banner → action 'error'", out.action === "error"]);
    checks.push(["error banner → message surfaced", /invalid email or password/i.test(out.message || "")]);
  }

  const fail = report(checks);
  if (fail) { console.log(`\nworkday_auth.js: ${fail} check(s) failed`); process.exit(1); }
  console.log("\nworkday_auth.js: all checks passed");
}

main();
