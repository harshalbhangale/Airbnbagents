// The host dashboard. Everything shown here comes from /api/state and is put
// on the page as text, never as HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of [].concat(children)) node.append(child);
    return node;
  };

  const REASONS = {
    capability_blocked: "Denied: that category is never rentable",
    capability_disabled: "Denied: you have switched this off",
    host_paused: "Denied: you had paused everything",
    no_permitted_fields: "Denied: asked only for fields you do not allow",
    rate_limited: "Denied: over your rate limit",
    undecryptable: "Rejected: could not be decrypted",
    malformed: "Rejected: badly formed request",
    expired: "Rejected: request was too old",
    replay: "Rejected: a repeat of an earlier request",
    unknown_capability: "Rejected: no such capability",
    invalid_input: "Rejected: input was not allowed",
    output_schema_violation: "Held back: the page returned something unexpected",
    output_scan_failed: "Held back: the result contained something sensitive",
    not_found: "Failed: nothing found",
    not_signed_in: "Failed: the rented account is signed out",
    timeout: "Failed: took too long",
    execution_failed: "Failed: could not complete",
  };

  let current = null;
  let lastCapabilities = "";
  let lastActivity = -1;
  let busy = false;

  const usd = (micro) => {
    const text = (micro / 1e6).toFixed(6).replace(/0{1,4}$/, "");
    return `$${text}`;
  };

  const showBanner = (text) => {
    $("banner").textContent = text || "";
    $("banner").hidden = !text;
  };

  async function post(path, body) {
    busy = true;
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "That change was not accepted.");
      showBanner("");
      return data;
    } catch (error) {
      showBanner(error.message);
      throw error;
    } finally {
      busy = false;
      await refresh(true);
    }
  }

  function renderStatus(s) {
    const pill = $("status-pill");
    let text = "Online";
    let kind = "ok";
    if (s.paused) [text, kind] = ["Paused", "warn"];
    else if (!s.signedIn) [text, kind] = ["Account signed out", "warn"];
    else if (!s.payoutAddress) [text, kind] = ["Add a payout address", "warn"];
    else if (s.marketplace.status !== "connected") [text, kind] = ["Not listed", ""];
    pill.textContent = text;
    pill.className = `pill ${kind}`;

    const pause = $("pause-button");
    pause.textContent = s.paused ? "Resume" : "Pause everything";
    pause.setAttribute("aria-pressed", String(s.paused));

    $("worker-id").textContent = `Worker ${s.workerKeyId}`;
    $("account-status").textContent = s.signedIn ? "Signed in. Agents can use the capabilities you allow below." : "Signed out. Tasks will fail until you sign in.";
    $("account-site").textContent = s.site;
    $("sign-in-form").hidden = s.signedIn || s.signInWindow;
    $("open-sign-in-button").hidden = s.signedIn || !s.signInWindow;

    const payout = $("payout-input");
    if (document.activeElement !== payout) payout.value = s.payoutAddress || "";

    $("earnings-total").textContent = usd(s.earnings.host);
    $("earnings-count").textContent = `${s.earnings.payments} paid task${s.earnings.payments === 1 ? "" : "s"}`;
    const market = { off: "Not connected to a marketplace", connecting: "Connecting to the marketplace…", connected: "Listed on the marketplace", disconnected: "Marketplace connection lost, retrying", refused: "The marketplace refused this worker" };
    $("marketplace-status").textContent = market[s.marketplace.status] || "";
  }

  const PAYMENT_STATES = { confirmed: "Confirmed onchain", reported: "Awaiting confirmation", failed: "Failed the onchain check" };
  let lastPayments = "";

  function renderRevenue(s) {
    $("revenue-today").textContent = usd(s.revenue.today);
    $("revenue-week").textContent = usd(s.revenue.last7Days);
    $("revenue-all").textContent = usd(s.earnings.host);
    const { confirmed, awaiting } = s.earnings;
    $("revenue-confirmation").textContent = s.earnings.payments
      ? `${usd(confirmed.host)} confirmed onchain` + (awaiting.payments ? `, ${usd(awaiting.host)} awaiting confirmation.` : ".")
      : "";
    const key = JSON.stringify(s.revenue.payments);
    if (key === lastPayments) return;
    lastPayments = key;
    $("payments-wrap").hidden = s.revenue.payments.length === 0;
    $("payments-empty").hidden = s.revenue.payments.length > 0;
    const rows = s.revenue.payments.map((payment) => {
      const link = el("td");
      // Only ever a block-explorer address built by the host app itself.
      if (payment.url && /^https:\/\/(sepolia\.)?basescan\.org\/tx\/0x[0-9a-f]{64}$/.test(payment.url)) {
        link.append(el("a", { href: payment.url, target: "_blank", rel: "noopener noreferrer", textContent: "View" }));
      } else link.textContent = "Not available";
      return el("tr", {}, [
        el("td", { className: "time", textContent: new Date(payment.at).toLocaleString() }),
        el("td", { textContent: usd(payment.amount) }),
        el("td", { className: `state-${payment.state}`, textContent: PAYMENT_STATES[payment.state] || payment.state }),
        link,
      ]);
    });
    $("payment-rows").replaceChildren(...rows);
  }

  function renderCapabilities(s) {
    const key = JSON.stringify(s.capabilities);
    if (key === lastCapabilities) return;
    lastCapabilities = key;
    const focusedId = document.activeElement && document.activeElement.id;
    const host = $("capabilities");
    host.replaceChildren();

    for (const cap of s.capabilities) {
      const enable = el("input", { type: "checkbox", id: `enable-${cap.id}`, checked: cap.enabled });
      enable.addEventListener("change", () => savePolicy(cap, { enabled: enable.checked }));

      const price = el("input", { id: `price-${cap.id}`, name: "price", inputMode: "decimal", autocomplete: "off", required: true, pattern: "\\d{1,5}(\\.\\d{1,6})?" });
      price.value = cap.priceMicroUsd === null ? "" : (cap.priceMicroUsd / 1e6).toFixed(6).replace(/0{1,4}$/, "");
      const priceForm = el("form", { className: "price-form" }, [el("label", {}, ["Price per task (USD)", price]), el("button", { type: "submit", className: "quiet", textContent: "Set price" })]);
      priceForm.addEventListener("submit", (event) => {
        event.preventDefault();
        post("/api/price", { capability: cap.id, priceUsd: price.value.trim() }).catch(() => {});
      });

      const fields = el("fieldset", { className: "fields" }, [el("legend", { textContent: "Fields an agent may receive" })]);
      for (const field of cap.fields) {
        const blocked = field.sensitivity === "blocked";
        const box = el("input", { type: "checkbox", id: `field-${cap.id}-${field.name}`, checked: field.allowed, disabled: blocked || !cap.enabled });
        box.addEventListener("change", () => {
          const allow = new Set(cap.fields.filter((f) => f.allowed).map((f) => f.name));
          if (box.checked) allow.add(field.name);
          else allow.delete(field.name);
          savePolicy(cap, { allowFields: [...allow] });
        });
        const label = el("label", { className: "check" }, [box, field.label]);
        if (blocked) label.append(el("span", { className: "tag", textContent: "Always blocked" }));
        else if (field.sensitivity === "sensitive") label.append(el("span", { className: "tag", textContent: "Sensitive" }));
        fields.append(label);
      }

      host.append(
        el("article", { className: "capability" }, [
          el("div", { className: "capability-head" }, [
            el("div", {}, [
              el("label", { className: "check" }, [enable, el("h3", { textContent: cap.title })]),
              el("p", { className: "muted small", textContent: cap.description }),
            ]),
            priceForm,
          ]),
          fields,
        ]),
      );
    }
    if (focusedId && $(focusedId)) $(focusedId).focus();
  }

  function savePolicy(cap, patch) {
    const allowFields = patch.allowFields || cap.fields.filter((f) => f.allowed).map((f) => f.name);
    const enabled = patch.enabled === undefined ? cap.enabled : patch.enabled;
    post("/api/policy", { capability: cap.id, enabled, allowFields }).catch(() => {});
  }

  function renderActivity(s) {
    const guard = s.guard;
    $("activity-summary").textContent =
      `${s.activityTotal} request${s.activityTotal === 1 ? "" : "s"} so far. ` +
      `The separate browser refused ${guard.blockedPath} attempt${guard.blockedPath === 1 ? "" : "s"} to load blocked pages and ${guard.offOrigin} to reach other sites. ` +
      (s.auditIntact ? "The log is intact." : "Warning: the log has been altered.");
    if (s.activityTotal === lastActivity) return;
    lastActivity = s.activityTotal;
    $("activity-empty").hidden = s.activity.length > 0;
    const rows = s.activity.map((entry) => {
      const ok = entry.status === "ok";
      const outcome = el("td", { className: ok ? "outcome-ok" : "outcome-no", textContent: ok ? "Completed" : REASONS[entry.reason] || entry.status });
      return el("tr", {}, [
        el("td", { className: "time", textContent: new Date(entry.at).toLocaleTimeString() }),
        el("td", {}, el("code", { textContent: entry.capability })),
        outcome,
        el("td", { textContent: entry.fieldsReturned.length ? entry.fieldsReturned.join(", ") : "Nothing" }),
      ]);
    });
    $("activity-rows").replaceChildren(...rows);
  }

  async function refresh(force) {
    if (busy && !force) return;
    try {
      const response = await fetch("/api/state");
      if (!response.ok) throw new Error("state");
      current = await response.json();
      renderStatus(current);
      renderRevenue(current);
      renderCapabilities(current);
      renderActivity(current);
    } catch {
      $("status-pill").textContent = "Host app not reachable";
      $("status-pill").className = "pill warn";
    }
  }

  $("pause-button").addEventListener("click", () => current && post("/api/pause", { paused: !current.paused }).catch(() => {}));
  $("recheck-button").addEventListener("click", () => post("/api/recheck-sign-in", {}).catch(() => {}));
  $("open-sign-in-button").addEventListener("click", () => post("/api/open-sign-in", {}).catch(() => {}));
  $("payout-form").addEventListener("submit", (event) => {
    event.preventDefault();
    post("/api/payout", { address: $("payout-input").value.trim() }).catch(() => {});
  });
  $("sign-in-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    post("/api/sign-in", { email: form.email.value, password: form.password.value })
      .then((result) => {
        form.password.value = "";
        if (!result.signedIn) showBanner("That email and password were not accepted by the site.");
      })
      .catch(() => {});
  });

  refresh(true);
  setInterval(() => refresh(false), 2000);
})();
