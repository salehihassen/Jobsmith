// Exercise the real panel, injected runtimes, and backend response shapes.
// Workday credential blocking must remain separate from ordinary autofill.
const fs = require("fs");
const path = require("path");
const { loadDom, evalScript, report } = require("./helpers");

const panelHTML = fs.readFileSync(path.join(__dirname, "../src/sidepanel.html"), "utf8");
const formHTML = `<!doctype html><form id="auth">
  <label for="email">Email</label><input id="email" type="email" data-automation-id="email">
  <label for="password">Password</label><input id="password" type="password" data-automation-id="password">
  <button type="button" data-automation-id="signInSubmitButton">Sign in</button>
</form>`;

async function arm(url) {
  const page = loadDom(formHTML, { url });
  const panel = loadDom(panelHTML);
  const w = panel.window;
  const tab = { id: 1, url, active: true };
  const calls = [];
  const injected = [];
  const saved = { autoScan: false, autoFill: false, backendUrl: "http://localhost:8888", token: "demo" };
  w.Response = Response;
  w.chrome = {
    runtime: { lastError: null },
    tabs: {
      query: (_, cb) => cb([tab]),
      get: (_, cb) => cb(tab),
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = Object.fromEntries(keys.map(k => [k, saved[k]]));
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: async patch => Object.assign(saved, patch),
      },
    },
    scripting: {
      executeScript: async ({ files, args }) => {
        let result;
        if (files) {
          for (const file of files) { injected.push(file); result = evalScript(page.window, file); }
        } else {
          result = await page.window[args[0]](...args[1]);
        }
        return [{ frameId: 0, result }];
      },
    },
  };
  w.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push(route);
    let payload = {};
    if (route === "/api/ext/workday_credentials") {
      payload = { configured: true, email: "workday@example.com", password: "dummy-password" };
    } else if (route === "/api/ext/workday_account") {
      payload = { found: false };
    } else if (route === "/api/ext/scan") {
      const body = JSON.parse(init.body);
      const fields = body.fields.map(f => ({
        field_id: f.field_id, value: f.field_type === "email" ? "applicant@example.com" : "",
        action: f.field_type === "email" ? "fill" : "skip", confidence: 1, source: "profile",
      }));
      payload = { fields, count: fields.length };
    }
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
  evalScript(w, "common/storage.js");
  evalScript(w, "common/api.js");
  evalScript(w, "sidepanel.js");
  // Let init's connection and manual-mode card refresh finish.
  await new Promise(resolve => w.setTimeout(resolve, 0));
  return {
    w, page: page.window, calls, injected, tab,
    close: () => { w.close(); page.window.close(); },
  };
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
    const h = await arm(url);
    const notice = h.w.document.getElementById("workdayBlocked");
    checks.push([`blocked notice visible on ${url}`, notice && !notice.hidden && /Workday sign-in blocked/.test(notice.textContent)]);
    checks.push([`blocked notice explains the reason on ${url}`, notice && (url.startsWith("http:")
      ? /requires HTTPS/.test(notice.textContent) : /not a trusted Workday domain/.test(notice.textContent))]);
    checks.push([`auth card absent on ${url}`, h.w.document.getElementById("workdayCard").hidden]);
    await h.w.doWorkdayAuth();
    checks.push([`no Workday credentials fetched or injected on ${url}`,
      !h.calls.includes("/api/ext/workday_credentials") && !h.injected.includes("common/workday_auth.js") &&
      h.page.document.getElementById("password").value === ""]);
    await h.w.doScan();
    checks.push([`notice survives Scan on ${url}`, notice && !notice.hidden]);
    h.tab.url = "https://jobs.example.com/apply";
    await h.w.refreshWorkdayCard();
    checks.push([`notice clears when leaving ${url}`, notice && notice.hidden]);
    h.close();
  }

  {
    const h = await arm("https://acme.wd5.myworkdayjobs.com/login");
    h.tab.url = "https://notmyworkdayjobs.com/login";
    await h.w.doWorkdayAuth();
    checks.push(["navigation to a lookalike blocks a previously available sign-in",
      !h.w.document.getElementById("workdayBlocked").hidden &&
      h.w.document.getElementById("workdayCard").hidden &&
      h.page.document.getElementById("password").value === ""]);
    h.close();
  }

  for (const url of [
    "https://company-a.wd5.myworkdayjobs.com/login",
    "https://company-b.wd1.myworkdaysite.com/login",
  ]) {
    const h = await arm(url);
    const doc = h.w.document;
    checks.push([`valid tenant auth available on ${url}`, !doc.getElementById("workdayCard").hidden && !doc.getElementById("workdayAuthBtn").disabled]);
    checks.push([`no blocked notice on ${url}`, doc.getElementById("workdayBlocked")?.hidden === true]);
    let submitted;
    h.page.document.querySelector("button").onclick = () => {
      submitted = [h.page.document.getElementById("email").value, h.page.document.getElementById("password").value];
      h.page.document.getElementById("auth").remove();
    };
    await h.w.doWorkdayAuth();
    checks.push([`valid tenant fills and signs in on ${url}`, submitted?.[0] === "workday@example.com" && submitted?.[1] === "dummy-password"]);
    h.close();
  }

  {
    const h = await arm("https://boards.greenhouse.io/acme/jobs/123");
    const doc = h.w.document;
    for (const id of ["autoFillToggle", "autoScanToggle"]) {
      doc.getElementById(id).checked = true;
      doc.getElementById(id).dispatchEvent(new h.w.Event("change"));
      await new Promise(resolve => h.w.setTimeout(resolve, 0));
    }
    for (let i = 0; i < 50 && !/Filled 1/.test(doc.getElementById("status").textContent); i++) {
      await new Promise(resolve => h.w.setTimeout(resolve, 20));
    }
    checks.push(["Auto-scan + Auto-fill still fill an ordinary ATS form",
      h.page.document.getElementById("email").value === "applicant@example.com" &&
      /Filled 1/.test(doc.getElementById("status").textContent) &&
      doc.getElementById("workdayBlocked").hidden]);
    h.close();
  }

  for (const url of [
    "https://boards.greenhouse.io/acme/jobs/123",
    "https://jobs.lever.co/acme/123",
    "https://jobs.example.com/myworkdayjobs.com?next=myworkdaysite.com",
    "http://jobs.example.com/apply",
  ]) {
    const h = await arm(url);
    const doc = h.w.document;
    checks.push([`no Workday warning on ordinary site ${url}`, doc.getElementById("workdayBlocked")?.hidden === true]);
    checks.push([`ordinary autofill button stays enabled on ${url}`, !doc.getElementById("autofill").disabled]);
    await h.w.doAutofill();
    checks.push([`ordinary scan and autofill works on ${url}`,
      h.calls.includes("/api/ext/scan") && h.page.document.getElementById("email").value === "applicant@example.com" &&
      /Filled 1/.test(doc.getElementById("status").textContent)]);
    checks.push([`ordinary autofill does not fetch Workday credentials on ${url}`, !h.calls.includes("/api/ext/workday_credentials")]);
    h.close();
  }

  const failed = report(checks);
  if (failed) process.exitCode = 1;
  else console.log("\nWorkday panel and ordinary autofill: all checks passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
