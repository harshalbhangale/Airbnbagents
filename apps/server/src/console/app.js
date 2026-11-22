// The renter console. Everything from the server is put on the page as text.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of [].concat(children)) node.append(child);
    return node;
  };
  const usd = (micro) => `$${(Math.abs(micro) / 1e6).toFixed(6).replace(/0{1,4}$/, "")}`;
  const KEY = "agentbnb.apiKey";
  const PENDING = "agentbnb.pendingTopUp";
  const TOP_UP_ID = /^[A-Za-z0-9_]{8,260}$/;
  const pending = {
    get: () => { try { return localStorage.getItem(PENDING); } catch { return null; } },
    set: (value) => { try { localStorage.setItem(PENDING, value); } catch { /* confirmation then relies on the address */ } },
    clear: () => { try { localStorage.removeItem(PENDING); } catch { /* nothing stored */ } },
  };
  const stored = {
    get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
    set: (value) => { try { localStorage.setItem(KEY, value); } catch { /* stays for this page only */ } },
    clear: () => { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } },
  };
  let apiKey = stored.get();
  let pendingKey = null;

  const showBanner = (text) => {
    $("banner").textContent = text || "";
    $("banner").hidden = !text;
  };

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
    const response = await fetch(path, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "request failed"), { status: response.status, data });
    return data;
  }

  const EXPLORERS = { "eip155:84532": "https://sepolia.basescan.org/tx/", "eip155:8453": "https://basescan.org/tx/" };
  let network = null;

  async function loadWorkers() {
    const [{ workers }, health] = await Promise.all([api("/workers"), api("/health")]);
    network = health.network;
    const rows = [];
    for (const worker of workers) {
      for (const offer of worker.offers) {
        if (offer.kind !== "automation_session") continue;
        const capability = worker.capabilities.find((c) => c.id === offer.capability);
        const fields = capability ? capability.fields.filter((f) => f.available).map((f) => f.label).join(", ") : "";
        rows.push(
          el("tr", {}, [
            el("td", {}, el("code", { textContent: offer.capability })),
            el("td", { textContent: usd(offer.pricePerSession) }),
            el("td", { textContent: fields || "None" }),
            el("td", {}, el("code", { textContent: worker.workerKeyId })),
          ]),
        );
      }
    }
    $("worker-rows").replaceChildren(...rows);
    $("workers-empty").hidden = rows.length > 0;
    $("status-pill").textContent = `${workers.length} host${workers.length === 1 ? "" : "s"} online`;
    $("status-pill").className = `pill ${workers.length ? "ok" : ""}`;
  }

  function renderAccount(account) {
    $("signed-out").hidden = true;
    $("signed-in").hidden = false;
    $("history-section").hidden = false;
    $("account-id").textContent = `Account ${account.accountId}`;
    $("credit").textContent = usd(account.creditMicroUsd);
    $("top-up").hidden = !account.cardPayments;
    $("card-off").hidden = account.cardPayments;

    const { min, max } = account.topUpLimitsUsd;
    const buttons = [5, 10, 25, 50].filter((amount) => amount >= min && amount <= max).map((amount) => {
      const button = el("button", { type: "button", textContent: `Add $${amount}` });
      button.addEventListener("click", () => topUp(amount));
      return button;
    });
    $("top-up-buttons").replaceChildren(...buttons);

    const rows = account.history.map((entry) => {
      const link = el("td");
      const base = EXPLORERS[network];
      if (entry.transaction && base && /^0x[0-9a-f]{64}$/.test(entry.transaction)) {
        link.append(el("a", { href: `${base}${entry.transaction}`, target: "_blank", rel: "noopener noreferrer", textContent: "View" }));
      }
      return el("tr", {}, [
        el("td", { className: "time", textContent: new Date(entry.at).toLocaleString() }),
        el("td", { textContent: entry.kind === "topup" ? "Credit added by card" : `Task: ${entry.capability}` }),
        el("td", { className: entry.amount > 0 ? "amount-in" : "", textContent: `${entry.amount > 0 ? "+" : "−"}${usd(entry.amount)}` }),
        link,
      ]);
    });
    $("history-rows").replaceChildren(...rows);
    $("history-empty").hidden = rows.length > 0;
  }

  function renderSignedOut() {
    $("signed-out").hidden = false;
    $("signed-in").hidden = true;
    $("history-section").hidden = true;
  }

  async function loadAccount() {
    if (!apiKey) return renderSignedOut();
    try {
      renderAccount(await api("/account"));
    } catch (error) {
      if (error.status === 401) {
        apiKey = null;
        stored.clear();
        renderSignedOut();
        showBanner("That API key was not recognised.");
      }
    }
  }

  async function topUp(amountUsd) {
    try {
      const { checkoutUrl, topUpId } = await api("/account/topups", { method: "POST", body: { amountUsd } });
      // Remembered here because not every card processor hands the reference back when it returns the renter.
      pending.set(topUpId);
      location.assign(checkoutUrl);
    } catch {
      showBanner("The card payment page could not be opened. Try again in a moment.");
    }
  }

  /** After returning from the card page: ask whether the payment went through, a few times. */
  async function confirmTopUp(id) {
    showBanner("Checking your card payment…");
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const result = await api(`/account/topups/${encodeURIComponent(id)}`);
        if (result.status === "paid") {
          pending.clear();
          showBanner("");
          return loadAccount();
        }
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    showBanner("The card payment has not gone through yet. Reload this page to check again, or add credit again if you did not finish paying.");
  }

  $("create-button").addEventListener("click", async () => {
    try {
      const created = await api("/accounts", { method: "POST" });
      pendingKey = created.apiKey;
      $("new-key-value").textContent = created.apiKey;
      $("new-key").hidden = false;
      $("signed-out").hidden = true;
    } catch {
      showBanner("The account could not be created.");
    }
  });
  $("copy-key-button").addEventListener("click", () => navigator.clipboard && navigator.clipboard.writeText(pendingKey || "").catch(() => {}));
  $("saved-key-button").addEventListener("click", () => {
    apiKey = pendingKey;
    pendingKey = null;
    stored.set(apiKey);
    $("new-key-value").textContent = "";
    $("new-key").hidden = true;
    loadAccount();
  });
  $("key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    apiKey = $("key-input").value.trim();
    stored.set(apiKey);
    $("key-input").value = "";
    showBanner("");
    loadAccount();
  });
  $("sign-out-button").addEventListener("click", () => {
    apiKey = null;
    stored.clear();
    renderSignedOut();
  });

  const params = new URLSearchParams(location.search);
  const returning = params.get("topup");
  if (returning) history.replaceState(null, "", location.pathname);

  loadWorkers().catch(() => {
    $("status-pill").textContent = "Marketplace not reachable";
    $("status-pill").className = "pill warn";
  }).then(loadAccount).then(() => {
    // Coming back from the card page: use the reference in the address if there is one, else the one remembered here.
    const fromAddress = returning && returning !== "return" && TOP_UP_ID.test(returning) ? returning : null;
    const id = fromAddress || (returning ? pending.get() : null);
    if (id && apiKey && TOP_UP_ID.test(id)) return confirmTopUp(id);
  });
  setInterval(() => loadWorkers().catch(() => {}), 10000);
})();
