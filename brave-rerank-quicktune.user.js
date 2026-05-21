// ==UserScript==
// @name         Brave Rerank Quick Tune (Goggle Mode)
// @namespace    master-rerank
// @version      1.2
// @description  Adds boost/discard buttons to Brave Search results even when a Goggle is active. Clicks POST to /settings just like the native Quick Tune UI.
// @match        https://search.brave.com/goggles?q=*
// @match        https://search.brave.com/search?q=*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // SVG icons -- taken straight from the native Quick Tune markup
  // ---------------------------------------------------------------------------

  const BOOST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>`;

  const DISCARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>`;

  // ---------------------------------------------------------------------------
  // Stylesheet
  // ---------------------------------------------------------------------------

  const style = document.createElement("style");
  style.textContent = `
    .rr-controls {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: 8px;
      vertical-align: middle;
    }
    .rr-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--color-text-tertiary, #888);
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 0.15s, background 0.15s, color 0.15s;
    }
    .rr-btn:hover {
      opacity: 1;
      background: var(--color-bg-tertiary, rgba(128,128,128,0.15));
    }
    .rr-btn.rr-boost:hover  { color: #22c55e; }
    .rr-btn.rr-discard:hover { color: #ef4444; }

    .rr-btn.rr-done {
      opacity: 1;
    }
    .rr-btn.rr-done.rr-boost   { color: #22c55e; }
    .rr-btn.rr-done.rr-discard { color: #ef4444; }

    .rr-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 10px 18px;
      border-radius: 8px;
      font: 13px/1.4 system-ui, sans-serif;
      color: #fff;
      z-index: 99999;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.25s, transform 0.25s;
      pointer-events: none;
    }
    .rr-toast.rr-show {
      opacity: 1;
      transform: translateY(0);
    }
    .rr-toast.rr-boost-toast   { background: #16a34a; }
    .rr-toast.rr-discard-toast { background: #dc2626; }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------------
  // Toast notification
  // ---------------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = null;

  function toast(message, type) {
    if (toastEl) toastEl.remove();
    toastEl = document.createElement("div");
    toastEl.className = `rr-toast rr-${type}-toast`;
    toastEl.textContent = message;
    document.body.appendChild(toastEl);
    requestAnimationFrame(() => toastEl.classList.add("rr-show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("rr-show");
      setTimeout(() => toastEl?.remove(), 300);
    }, 2200);
  }

  // ---------------------------------------------------------------------------
  // POST to /settings -- same mechanism the native Quick Tune forms use
  // ---------------------------------------------------------------------------

  async function postSetting(action, domain, type) {
    const body = new URLSearchParams();
    body.set("name", action);
    body.set("value", domain);
    if (type) body.set("type", type);  // needed for "quick-goggles-remove"

    try {
      const res = await fetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        credentials: "same-origin",
        redirect: "manual",
      });
      return res.status < 400 || res.type === "opaqueredirect";
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Extract hostname from a URL string, stripping "www."
  // ---------------------------------------------------------------------------

  function extractDomain(href) {
    try {
      const u = new URL(href);
      return u.hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Read goggles_boost / goggles_discard cookies to restore button state
  // ---------------------------------------------------------------------------

  function parseCookieDomains(cookieName) {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${cookieName}=([^;]*)`)
    );
    if (!match) return new Set();
    const decoded = decodeURIComponent(match[1]);
    return new Set(decoded.split("|").map((d) => d.trim()).filter(Boolean));
  }

  const boostedDomains = parseCookieDomains("goggles_boost");
  const discardedDomains = parseCookieDomains("goggles_discard");

  // Check whether a domain matches any entry in a set.  Handles the case where
  // the cookie stores "wikipedia.org" but the result domain is
  // "en.wikipedia.org", or vice versa.
  function domainMatchesSet(domain, domainSet) {
    if (domainSet.has(domain)) return true;
    for (const entry of domainSet) {
      if (domain.endsWith("." + entry) || entry.endsWith("." + domain)) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Inject controls into a result element
  // ---------------------------------------------------------------------------

  function injectControls(resultEl, domain) {
    if (resultEl.querySelector(".rr-controls")) return; // already done

    const wrapper = document.createElement("span");
    wrapper.className = "rr-controls";

    // Check if this domain is already in a cookie list. The cookies store
    // exact values from previous Quick Tune clicks, which may be subdomains
    // (e.g. "en.wikipedia.org") or bare domains ("wikipedia.org"). We check
    // whether the result domain ends with any stored entry, or vice versa.
    const isBoosted = domainMatchesSet(domain, boostedDomains);
    const isDiscarded = domainMatchesSet(domain, discardedDomains);

    const boostBtn = document.createElement("button");
    boostBtn.className = "rr-btn rr-boost" + (isBoosted ? " rr-done" : "");
    boostBtn.title = `Raise ${domain}`;
    boostBtn.innerHTML = BOOST_SVG;

    const discardBtn = document.createElement("button");
    discardBtn.className = "rr-btn rr-discard" + (isDiscarded ? " rr-done" : "");
    discardBtn.title = `Discard ${domain}`;
    discardBtn.innerHTML = DISCARD_SVG;

    boostBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasActive = boostBtn.classList.contains("rr-done");

      if (wasActive) {
        // Remove boost
        const ok = await postSetting("quick-goggles-remove", domain, "boost");
        if (ok) {
          boostBtn.classList.remove("rr-done");
          boostedDomains.delete(domain);
          toast(`Removed raise: ${domain}`, "discard");
        }
      } else {
        // Add boost
        const ok = await postSetting("quick-goggles-boost", domain);
        if (ok) {
          boostBtn.classList.add("rr-done");
          discardBtn.classList.remove("rr-done");
          boostedDomains.add(domain);
          discardedDomains.delete(domain);
          toast(`Raised: ${domain}`, "boost");
        }
      }
    });

    discardBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasActive = discardBtn.classList.contains("rr-done");

      if (wasActive) {
        // Remove discard
        const ok = await postSetting("quick-goggles-remove", domain, "discard");
        if (ok) {
          discardBtn.classList.remove("rr-done");
          discardedDomains.delete(domain);
          toast(`Removed discard: ${domain}`, "boost");
        }
      } else {
        // Add discard
        const ok = await postSetting("quick-goggles-discard", domain);
        if (ok) {
          discardBtn.classList.add("rr-done");
          boostBtn.classList.remove("rr-done");
          discardedDomains.add(domain);
          boostedDomains.delete(domain);
          toast(`Discarded: ${domain}`, "discard");
        }
      }
    });

    wrapper.appendChild(boostBtn);
    wrapper.appendChild(discardBtn);

    // Find best insertion point: the URL/cite line of the snippet, or fall back
    // to the first child.
    const cite = resultEl.querySelector("cite, .url, [data-testid='url']");
    if (cite) {
      cite.parentElement.appendChild(wrapper);
    } else {
      resultEl.prepend(wrapper);
    }
  }

  // ---------------------------------------------------------------------------
  // Main: find all web results and inject controls
  // ---------------------------------------------------------------------------

  function processResults() {
    // Brave Search uses several possible selectors for web results.
    // We look for the most common container patterns.
    const selectors = [
      "#results .snippet",                 // standard web snippets
      "#results .fdb",                     // featured / deep-blue results
      "#results [data-type='web']",        // data-attribute variant
      "#results .card",                    // card-style results
      "#results .result",                  // generic result
    ];

    const seen = new Set();

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);

        // Find the outbound link
        const link = el.querySelector("a[href^='http']");
        if (!link) continue;

        const domain = extractDomain(link.href);
        if (!domain) continue;

        // Skip internal brave.com links
        if (domain.endsWith("brave.com") || domain.endsWith("brave.app")) continue;

        injectControls(el, domain);
      }
    }
  }

  // Run once on load, then observe for dynamically appended results.
  processResults();

  const observer = new MutationObserver(() => processResults());
  observer.observe(document.getElementById("results") || document.body, {
    childList: true,
    subtree: true,
  });
})();
