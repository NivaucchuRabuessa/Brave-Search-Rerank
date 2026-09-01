// ==UserScript==
// @name         Brave Rerank Quick Tune (Goggle Mode)
// @namespace    master-rerank
// @version      3.0
// @description  Adds conflict-safe boost/downrank/discard controls to Brave Search results and exports canonical Goggle instructions.
// @match        https://search.brave.com/goggles?q=*
// @match        https://search.brave.com/search?q=*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // localStorage key for accumulated instruction lines
  // ---------------------------------------------------------------------------

  const STORAGE_KEY = "rr_pending_instructions";
  const MAXIMUM_DOWNRANK_STRENGTH = 10;
  const ACTION_OPTION_PATTERN =
    /^(?:boost|downrank)(?:=(?:[1-9]|10))?$|^discard$/;
  const WHOLE_TLD_DISCARD_PATTERN =
    /^(\|https:\/\/\*\.[a-z0-9.-]+\^)\$discard$/i;

  function wholeTldDownrankFallback(instruction) {
    const match = WHOLE_TLD_DISCARD_PATTERN.exec(instruction);
    if (!match) return null;
    return `${match[1]}$downrank=${MAXIMUM_DOWNRANK_STRENGTH}`;
  }

  function instructionTargetKey(instruction) {
    const dollarIndex = instruction.indexOf("$");
    if (dollarIndex < 0) return null;

    const urlPattern = instruction.slice(0, dollarIndex);
    const options = instruction.slice(dollarIndex + 1).split(",");
    const actionOptions = options.filter((option) =>
      ACTION_OPTION_PATTERN.test(option)
    );
    if (actionOptions.length !== 1) return null;

    const targetOptions = options
      .filter((option) => !ACTION_OPTION_PATTERN.test(option))
      .sort();
    return `${urlPattern}$${targetOptions.join(",")}`;
  }

  function canonicalizePendingInstructions(untrustedInstructions) {
    const canonicalInstructions = [];
    const knownInstructions = new Set();

    for (const untrustedInstruction of untrustedInstructions) {
      if (typeof untrustedInstruction !== "string") continue;
      const instruction = untrustedInstruction.trim();
      if (!instruction) continue;
      if (!knownInstructions.has(instruction)) {
        canonicalInstructions.push(instruction);
        knownInstructions.add(instruction);
      }
    }

    // A whole-TLD discard keeps the TLD blocked by default. Its paired
    // maximum downrank becomes the fallback when the generator must suspend
    // that discard to honor an explicit boost within the TLD.
    for (const instruction of [...canonicalInstructions]) {
      const fallback = wholeTldDownrankFallback(instruction);
      if (fallback && !knownInstructions.has(fallback)) {
        canonicalInstructions.push(fallback);
        knownInstructions.add(fallback);
      }
    }

    return canonicalInstructions;
  }

  function loadPendingInstructions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsedInstructions = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsedInstructions)) return [];

      const canonicalInstructions = canonicalizePendingInstructions(
        parsedInstructions
      );
      const canonicalJson = JSON.stringify(canonicalInstructions);
      if (canonicalJson !== raw) {
        localStorage.setItem(STORAGE_KEY, canonicalJson);
      }
      return canonicalInstructions;
    } catch {
      return [];
    }
  }

  function savePendingInstructions(instructions) {
    const canonicalInstructions = canonicalizePendingInstructions(instructions);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(canonicalInstructions));
    updateBadge();
  }

  function pendingInstructionsWithReplacement(
    existingInstructions,
    newInstructions
  ) {
    const canonicalNewInstructions = canonicalizePendingInstructions(
      newInstructions
    );
    const newTargetKeys = new Set(
      canonicalNewInstructions
        .map(instructionTargetKey)
        .filter((targetKey) => targetKey !== null)
    );
    const retainedInstructions = canonicalizePendingInstructions(
      existingInstructions
    ).filter((instruction) => {
      const targetKey = instructionTargetKey(instruction);
      if (targetKey === null) {
        return !canonicalNewInstructions.includes(instruction);
      }
      return !newTargetKeys.has(targetKey);
    });
    return canonicalizePendingInstructions([
      ...retainedInstructions,
      ...canonicalNewInstructions,
    ]);
  }

  function replaceInstructionsForTarget(newInstructions) {
    savePendingInstructions(
      pendingInstructionsWithReplacement(
        loadPendingInstructions(),
        newInstructions
      )
    );
  }

  // ---------------------------------------------------------------------------
  // SVG icons
  // ---------------------------------------------------------------------------

  const TUNE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>`;

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
    .rr-btn.rr-tune:hover { color: #a78bfa; }

    /* ---- Toast ---- */
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
    .rr-toast.rr-downrank-toast { background: #d97706; }

    /* ---- Floating badge ---- */
    .rr-badge {
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 99980;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 10px;
      background: var(--color-bg-primary, #1e1e2e);
      border: 1px solid var(--color-border-primary, #333);
      box-shadow: 0 4px 20px rgba(0,0,0,0.35);
      font: 12px/1.4 system-ui, sans-serif;
      color: var(--color-text-secondary, #ccc);
      cursor: pointer;
      transition: background 0.15s;
    }
    .rr-badge:hover {
      background: var(--color-bg-tertiary, rgba(128,128,128,0.15));
    }
    .rr-badge-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      border-radius: 10px;
      background: #a78bfa;
      color: #fff;
      font-weight: 700;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .rr-badge.rr-badge-empty {
      opacity: 0.4;
    }

    /* ---- Export panel ---- */
    .rr-export-overlay {
      position: fixed;
      inset: 0;
      z-index: 99984;
    }
    .rr-export-panel {
      position: fixed;
      bottom: 60px;
      left: 20px;
      z-index: 99985;
      background: var(--color-bg-primary, #1e1e2e);
      border: 1px solid var(--color-border-primary, #333);
      border-radius: 10px;
      padding: 14px 16px;
      min-width: 340px;
      max-width: 520px;
      max-height: 60vh;
      box-shadow: 0 8px 32px rgba(0,0,0,0.45);
      font: 13px/1.5 system-ui, sans-serif;
      color: var(--color-text-primary, #e0e0e0);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .rr-export-panel h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    .rr-export-panel textarea {
      width: 100%;
      min-height: 120px;
      max-height: 40vh;
      padding: 8px;
      border: 1px solid var(--color-border-primary, #444);
      border-radius: 6px;
      background: var(--color-bg-tertiary, #111);
      color: var(--color-text-primary, #ddd);
      font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
      font-size: 11px;
      resize: vertical;
      box-sizing: border-box;
    }
    .rr-export-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .rr-export-actions button {
      padding: 6px 14px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .rr-export-actions .rr-copy-btn {
      background: #a78bfa;
      color: #fff;
    }
    .rr-export-actions .rr-copy-btn:hover {
      background: #8b5cf6;
    }
    .rr-export-actions .rr-download-btn {
      background: #22c55e;
      color: #fff;
    }
    .rr-export-actions .rr-download-btn:hover {
      background: #16a34a;
    }
    .rr-export-actions .rr-clear-btn {
      background: #ef4444;
      color: #fff;
    }
    .rr-export-actions .rr-clear-btn:hover {
      background: #dc2626;
    }
    .rr-export-actions .rr-close-export-btn {
      background: var(--color-bg-tertiary, rgba(128,128,128,0.15));
      color: var(--color-text-secondary, #ccc);
    }

    /* ---- Popup panel (tune dialog) ---- */
    .rr-popup-overlay {
      position: fixed;
      inset: 0;
      z-index: 99990;
    }
    .rr-popup {
      position: fixed;
      z-index: 99991;
      background: var(--color-bg-primary, #1e1e2e);
      border: 1px solid var(--color-border-primary, #333);
      border-radius: 10px;
      padding: 14px 16px;
      min-width: 310px;
      max-width: 420px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.45);
      font: 13px/1.5 system-ui, -apple-system, sans-serif;
      color: var(--color-text-primary, #e0e0e0);
    }
    .rr-popup h3 {
      margin: 0 0 10px;
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-primary, #fff);
    }
    .rr-popup .rr-url-preview {
      margin: 0 0 12px;
      padding: 6px 8px;
      background: var(--color-bg-tertiary, rgba(128,128,128,0.1));
      border-radius: 6px;
      font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
      font-size: 11px;
      word-break: break-all;
      color: var(--color-text-secondary, #aaa);
      max-height: 40px;
      overflow: hidden;
    }

    .rr-popup fieldset {
      border: none;
      margin: 0 0 10px;
      padding: 0;
    }
    .rr-popup legend {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--color-text-tertiary, #888);
      margin-bottom: 6px;
    }

    .rr-radio-group {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .rr-radio-group label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      background: var(--color-bg-tertiary, rgba(128,128,128,0.1));
      border: 1px solid transparent;
      transition: background 0.15s, border-color 0.15s;
    }
    .rr-radio-group label:hover {
      background: var(--color-bg-tertiary, rgba(128,128,128,0.2));
    }
    .rr-radio-group input[type="radio"] {
      display: none;
    }
    .rr-radio-group input[type="radio"]:checked + span {
      font-weight: 600;
    }
    .rr-radio-group label:has(input:checked) {
      border-color: #a78bfa;
      background: rgba(167,139,250,0.12);
    }
    .rr-radio-group label.rr-action-boost:has(input:checked) {
      border-color: #22c55e;
      background: rgba(34,197,94,0.12);
    }
    .rr-radio-group label.rr-action-downrank:has(input:checked) {
      border-color: #f59e0b;
      background: rgba(245,158,11,0.12);
    }
    .rr-radio-group label.rr-action-discard:has(input:checked) {
      border-color: #ef4444;
      background: rgba(239,68,68,0.12);
    }

    .rr-strength-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .rr-strength-row input[type="range"] {
      flex: 1;
      accent-color: #a78bfa;
    }
    .rr-strength-row .rr-strength-value {
      min-width: 20px;
      text-align: center;
      font-weight: 600;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }

    .rr-target-sliders {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
    }
    .rr-target-control {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 5px;
    }
    .rr-target-control input[type="range"] {
      width: 100%;
      margin: 0;
      accent-color: #a78bfa;
    }
    .rr-target-value {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
      font-size: 11px;
      color: var(--color-text-secondary, #ccc);
      text-align: center;
    }

    .rr-target-preview {
      margin: 8px 0 12px;
      padding: 6px 8px;
      background: var(--color-bg-tertiary, rgba(128,128,128,0.1));
      border-radius: 6px;
      font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
      font-size: 11px;
      word-break: break-all;
      white-space: pre-wrap;
      color: #a78bfa;
    }
    .rr-fallback-note {
      margin: -6px 0 12px;
      color: #f59e0b;
      font-size: 11px;
      line-height: 1.4;
    }

    .rr-popup-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .rr-popup-actions button {
      padding: 6px 16px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }
    .rr-popup-actions .rr-cancel-btn {
      background: var(--color-bg-tertiary, rgba(128,128,128,0.15));
      color: var(--color-text-secondary, #ccc);
    }
    .rr-popup-actions .rr-cancel-btn:hover {
      background: rgba(128,128,128,0.3);
    }
    .rr-popup-actions .rr-apply-btn {
      background: #a78bfa;
      color: #fff;
    }
    .rr-popup-actions .rr-apply-btn:hover {
      background: #8b5cf6;
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------------
  // Toast notification
  // ---------------------------------------------------------------------------

  let toastElement = null;
  let toastTimer = null;

  function toast(message, type) {
    if (toastElement) toastElement.remove();
    toastElement = document.createElement("div");
    toastElement.className = `rr-toast rr-${type}-toast`;
    toastElement.textContent = message;
    document.body.appendChild(toastElement);
    requestAnimationFrame(() => toastElement.classList.add("rr-show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastElement.classList.remove("rr-show");
      setTimeout(() => toastElement?.remove(), 300);
    }, 2800);
  }

  // ---------------------------------------------------------------------------
  // URL decomposition helpers
  // ---------------------------------------------------------------------------

  function decomposeUrl(href) {
    try {
      const urlObject = new URL(href);
      const hostname = urlObject.hostname.replace(/^www\./, "");
      const parts = hostname.split(".");
      const twoPartSuffixes = [
        "co.uk", "co.jp", "co.kr", "co.in", "com.au", "com.br",
        "com.mx", "com.cn", "com.tw", "com.hk", "com.sg", "com.tr",
        "com.ua", "com.de", "org.uk", "net.au", "ac.uk", "ac.in",
        "ac.jp", "gov.uk", "gov.in", "edu.in", "edu.au",
      ];
      let effectiveTld = parts.slice(-1).join(".");
      if (parts.length >= 3) {
        const candidateCcTld = parts.slice(-2).join(".");
        if (twoPartSuffixes.includes(candidateCcTld)) {
          effectiveTld = candidateCcTld;
        }
      }

      const tldParts = effectiveTld.split(".");
      const domainParts = parts.slice(-(tldParts.length + 1));
      const domain = domainParts.join(".");

      const subdomain = hostname !== domain ? hostname : null;
      const path = urlObject.pathname;

      return { hostname, tld: effectiveTld, domain, subdomain, path, full: href };
    } catch {
      return null;
    }
  }

  function buildInstruction(action, strength, hostTarget, urlParts, pathTarget) {
    let actionFragment;
    if (action === "discard") {
      actionFragment = "$discard";
    } else {
      actionFragment = `$${action}=${strength}`;
    }

    const pathPattern = pathTarget?.pattern || "";

    if (hostTarget.level === "tld") {
      const hostPattern = `|https://*.${urlParts.tld}`;
      if (!pathPattern) return `${hostPattern}^${actionFragment}`;
      return `${hostPattern}${pathPattern}${actionFragment}`;
    }

    if (pathPattern) {
      return `${pathPattern}${actionFragment},site=${hostTarget.site}`;
    }

    return `${actionFragment},site=${hostTarget.site}`;
  }

  function buildInstructions(action, strength, hostTarget, urlParts, pathTarget) {
    const primaryInstruction = buildInstruction(
      action,
      strength,
      hostTarget,
      urlParts,
      pathTarget
    );
    const downrankFallback = wholeTldDownrankFallback(primaryInstruction);
    return downrankFallback
      ? [primaryInstruction, downrankFallback]
      : [primaryInstruction];
  }

  function buildHostOptions(urlParts) {
    const options = [];
    if (urlParts.subdomain) {
      options.push({
        level: "subdomain",
        label: urlParts.subdomain,
        site: urlParts.subdomain,
      });
    }
    options.push({
      level: "domain",
      label: urlParts.domain,
      site: urlParts.domain,
    });
    options.push({ level: "tld", label: `.${urlParts.tld}` });
    return options;
  }

  function buildPathOptions(urlParts) {
    const options = [{ label: "No path", pattern: "" }];
    const pathSegments = urlParts.path.split("/").filter(Boolean);

    for (let index = 0; index < pathSegments.length; index += 1) {
      const isLastSegment = index === pathSegments.length - 1;
      const trailingSlash =
        (index === 0 && !isLastSegment) ||
        (isLastSegment && urlParts.path.endsWith("/"))
          ? "/"
          : "";
      const path = `/${pathSegments.slice(0, index + 1).join("/")}${trailingSlash}`;
      options.push({ label: path, pattern: path });
    }

    return options;
  }

  // ---------------------------------------------------------------------------
  // Floating badge + export panel
  // ---------------------------------------------------------------------------

  const badge = document.createElement("div");
  badge.className = "rr-badge";
  badge.innerHTML = `<span class="rr-badge-count">0</span> pending`;
  document.body.appendChild(badge);

  function updateBadge() {
    const count = loadPendingInstructions().length;
    const countSpan = badge.querySelector(".rr-badge-count");
    countSpan.textContent = count;
    badge.classList.toggle("rr-badge-empty", count === 0);
  }
  updateBadge();

  let exportPanelOpen = false;

  function closeExportPanel() {
    const overlay = document.querySelector(".rr-export-overlay");
    const panel = document.querySelector(".rr-export-panel");
    if (overlay) overlay.remove();
    if (panel) panel.remove();
    exportPanelOpen = false;
  }

  function openExportPanel() {
    if (exportPanelOpen) {
      closeExportPanel();
      return;
    }

    const instructions = loadPendingInstructions();

    const overlay = document.createElement("div");
    overlay.className = "rr-export-overlay";
    overlay.addEventListener("click", closeExportPanel);

    const panel = document.createElement("div");
    panel.className = "rr-export-panel";

    const heading = document.createElement("h3");
    heading.textContent = `Pending instructions (${instructions.length})`;
    panel.appendChild(heading);

    const textarea = document.createElement("textarea");
    textarea.value = instructions.join("\n");
    textarea.readOnly = true;
    panel.appendChild(textarea);

    const actionsRow = document.createElement("div");
    actionsRow.className = "rr-export-actions";

    const copyButton = document.createElement("button");
    copyButton.className = "rr-copy-btn";
    copyButton.textContent = "Copy all";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        toast("Copied to clipboard", "boost");
      } catch {
        textarea.select();
        document.execCommand("copy");
        toast("Copied to clipboard", "boost");
      }
    });

    const downloadButton = document.createElement("button");
    downloadButton.className = "rr-download-btn";
    downloadButton.textContent = "Download .txt";
    downloadButton.addEventListener("click", () => {
      const blob = new Blob([textarea.value + "\n"], { type: "text/plain" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = "pending_instructions.txt";
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      toast("Downloaded pending_instructions.txt", "boost");
    });

    const clearButton = document.createElement("button");
    clearButton.className = "rr-clear-btn";
    clearButton.textContent = "Clear all";
    clearButton.addEventListener("click", () => {
      savePendingInstructions([]);
      textarea.value = "";
      heading.textContent = "Pending instructions (0)";
      toast("Cleared all pending instructions", "discard");
    });

    const closeButton = document.createElement("button");
    closeButton.className = "rr-close-export-btn";
    closeButton.textContent = "Close";
    closeButton.addEventListener("click", closeExportPanel);

    actionsRow.appendChild(copyButton);
    actionsRow.appendChild(downloadButton);
    actionsRow.appendChild(clearButton);
    actionsRow.appendChild(closeButton);
    panel.appendChild(actionsRow);

    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    exportPanelOpen = true;
  }

  badge.addEventListener("click", openExportPanel);

  // ---------------------------------------------------------------------------
  // Popup: prompt for action, strength, and targeting level
  // ---------------------------------------------------------------------------

  let activePopup = null;

  function closePopup() {
    if (activePopup) {
      activePopup.overlay.remove();
      activePopup.panel.remove();
      activePopup = null;
    }
  }

  function openPopup(anchorElement, urlParts) {
    closePopup();

    const overlay = document.createElement("div");
    overlay.className = "rr-popup-overlay";
    overlay.addEventListener("click", closePopup);

    const panel = document.createElement("div");
    panel.className = "rr-popup";

    const anchorRect = anchorElement.getBoundingClientRect();
    panel.style.top = `${anchorRect.bottom + 6}px`;
    panel.style.left = `${Math.max(8, anchorRect.left - 120)}px`;

    // --- Header ---
    const heading = document.createElement("h3");
    heading.textContent = "Quick Tune";
    panel.appendChild(heading);

    // --- URL preview ---
    const urlPreview = document.createElement("div");
    urlPreview.className = "rr-url-preview";
    urlPreview.textContent = urlParts.full;
    panel.appendChild(urlPreview);

    // --- Action selection ---
    const actionFieldset = document.createElement("fieldset");
    const actionLegend = document.createElement("legend");
    actionLegend.textContent = "Action";
    actionFieldset.appendChild(actionLegend);

    const actionGroup = document.createElement("div");
    actionGroup.className = "rr-radio-group";

    const actions = [
      { value: "boost", label: "Boost", cssClass: "rr-action-boost" },
      { value: "downrank", label: "Downrank", cssClass: "rr-action-downrank" },
      { value: "discard", label: "Discard", cssClass: "rr-action-discard" },
    ];

    for (const actionOption of actions) {
      const label = document.createElement("label");
      label.className = actionOption.cssClass;
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "rr-action";
      radio.value = actionOption.value;
      if (actionOption.value === "boost") radio.checked = true;
      const span = document.createElement("span");
      span.textContent = actionOption.label;
      label.appendChild(radio);
      label.appendChild(span);
      actionGroup.appendChild(label);
      radio.addEventListener("change", updatePreview);
    }
    actionFieldset.appendChild(actionGroup);
    panel.appendChild(actionFieldset);

    // --- Strength slider ---
    const strengthFieldset = document.createElement("fieldset");
    strengthFieldset.className = "rr-strength-fieldset";
    const strengthLegend = document.createElement("legend");
    strengthLegend.textContent = "Strength";
    strengthFieldset.appendChild(strengthLegend);

    const strengthRow = document.createElement("div");
    strengthRow.className = "rr-strength-row";
    const strengthSlider = document.createElement("input");
    strengthSlider.type = "range";
    strengthSlider.min = "1";
    strengthSlider.max = "10";
    strengthSlider.value = "3";
    const strengthLabel = document.createElement("span");
    strengthLabel.className = "rr-strength-value";
    strengthLabel.textContent = "3";
    strengthSlider.addEventListener("input", () => {
      strengthLabel.textContent = strengthSlider.value;
      updatePreview();
    });
    strengthRow.appendChild(strengthSlider);
    strengthRow.appendChild(strengthLabel);
    strengthFieldset.appendChild(strengthRow);
    panel.appendChild(strengthFieldset);

    // --- Level selection ---
    const levelFieldset = document.createElement("fieldset");
    const levelLegend = document.createElement("legend");
    levelLegend.textContent = "Target level";
    levelFieldset.appendChild(levelLegend);

    const hostOptions = buildHostOptions(urlParts);
    const pathOptions = buildPathOptions(urlParts);
    const targetSliders = document.createElement("div");
    targetSliders.className = "rr-target-sliders";

    function createTargetControl(options, label, initialValue) {
      const control = document.createElement("div");
      control.className = "rr-target-control";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = String(options.length - 1);
      slider.step = "1";
      slider.value = String(initialValue);
      slider.setAttribute("aria-label", label);
      slider.addEventListener("input", updatePreview);
      const value = document.createElement("span");
      value.className = "rr-target-value";
      control.appendChild(slider);
      control.appendChild(value);
      targetSliders.appendChild(control);
      return { slider, value };
    }

    const hostControl = createTargetControl(hostOptions, "Host specificity", 0);
    const pathControl = createTargetControl(pathOptions, "Path specificity", 0);
    levelFieldset.appendChild(targetSliders);
    panel.appendChild(levelFieldset);

    // --- Instruction preview ---
    const previewBox = document.createElement("div");
    previewBox.className = "rr-target-preview";
    panel.appendChild(previewBox);

    const fallbackNote = document.createElement("div");
    fallbackNote.className = "rr-fallback-note";
    fallbackNote.textContent =
      "Whole-TLD discard: a maximum downrank fallback is saved with it.";
    fallbackNote.hidden = true;
    panel.appendChild(fallbackNote);

    function getSelectedRadio(name) {
      return panel.querySelector(`input[name="${name}"]:checked`)?.value;
    }

    function updatePreview() {
      const selectedAction = getSelectedRadio("rr-action");
      const selectedStrength = parseInt(strengthSlider.value, 10);
      const selectedHost = hostOptions[parseInt(hostControl.slider.value, 10)];
      const selectedPath = pathOptions[parseInt(pathControl.slider.value, 10)];

      strengthFieldset.style.display =
        selectedAction === "discard" ? "none" : "";
      hostControl.value.textContent = selectedHost.label;
      hostControl.value.title = selectedHost.label;
      pathControl.value.textContent = selectedPath.label;
      pathControl.value.title = selectedPath.label;

      const instructions = buildInstructions(
        selectedAction,
        selectedStrength,
        selectedHost,
        urlParts,
        selectedPath
      );
      previewBox.textContent = instructions.join("\n");
      fallbackNote.hidden = instructions.length === 1;
    }

    updatePreview();

    // --- Action buttons ---
    const actionsRow = document.createElement("div");
    actionsRow.className = "rr-popup-actions";

    const cancelButton = document.createElement("button");
    cancelButton.className = "rr-cancel-btn";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", closePopup);

    const applyButton = document.createElement("button");
    applyButton.className = "rr-apply-btn";
    applyButton.textContent = "Apply";
    applyButton.addEventListener("click", () => {
      const selectedAction = getSelectedRadio("rr-action");
      const selectedStrength = parseInt(strengthSlider.value, 10);
      const selectedHost = hostOptions[parseInt(hostControl.slider.value, 10)];
      const selectedPath = pathOptions[parseInt(pathControl.slider.value, 10)];
      const instructions = buildInstructions(
        selectedAction,
        selectedStrength,
        selectedHost,
        urlParts,
        selectedPath
      );

      // Replace every pending action for this exact target atomically. A
      // whole-TLD discard includes its maximum-downrank fallback.
      replaceInstructionsForTarget(instructions);

      toast(`Saved: ${instructions.join(" + ")}`, selectedAction);
      closePopup();
    });

    actionsRow.appendChild(cancelButton);
    actionsRow.appendChild(applyButton);
    panel.appendChild(actionsRow);

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      if (panelRect.right > window.innerWidth - 8) {
        panel.style.left = `${window.innerWidth - panelRect.width - 8}px`;
      }
      if (panelRect.bottom > window.innerHeight - 8) {
        panel.style.top = `${anchorRect.top - panelRect.height - 6}px`;
      }
    });

    activePopup = { overlay, panel };
  }

  // ---------------------------------------------------------------------------
  // Inject controls into a result element
  // ---------------------------------------------------------------------------

  function injectControls(resultElement, href) {
    if (resultElement.querySelector(".rr-controls")) return;

    const urlParts = decomposeUrl(href);
    if (!urlParts) return;

    const wrapper = document.createElement("span");
    wrapper.className = "rr-controls";

    // Tune button that opens the popup
    const tuneButton = document.createElement("button");
    tuneButton.className = "rr-btn rr-tune";
    tuneButton.title = `Tune ranking for ${urlParts.hostname}`;
    tuneButton.innerHTML = TUNE_SVG;
    tuneButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPopup(tuneButton, urlParts);
    });
    wrapper.appendChild(tuneButton);

    const cite = resultElement.querySelector("cite, .url, [data-testid='url']");
    if (cite) {
      cite.parentElement.appendChild(wrapper);
    } else {
      resultElement.prepend(wrapper);
    }
  }

  // ---------------------------------------------------------------------------
  // Main: find all web results and inject controls
  // ---------------------------------------------------------------------------

  function processResults() {
    const selectors = [
      // Brave SERP v3 renders ordinary web results inside #mixed-main and no
      // longer wraps them in either #results or a <main> element.
      "#mixed-main .snippet[data-type='web']",
      "#results .snippet",
      "#results .fdb",
      "#results [data-type='web']",
      "#results .card",
      "#results .result",
      "main .snippet",
    ];

    const seen = new Set();

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);

        // Restrict the legacy fallback selector to ordinary result cards so
        // clusters remain clean.
        if (
          selector === "main .snippet" &&
          !element.querySelector(":scope > .result-wrapper")
        )
          continue;

        const link = element.querySelector(
          ":scope > .result-wrapper > .result-content > a[href^='http'], " +
            "a[href^='http']"
        );
        if (!link) continue;

        const hostname = (() => {
          try {
            return new URL(link.href).hostname;
          } catch {
            return null;
          }
        })();
        if (!hostname) continue;
        if (hostname.endsWith("brave.com") || hostname.endsWith("brave.app"))
          continue;

        injectControls(element, link.href);
      }
    }
  }

  processResults();

  const observer = new MutationObserver(() => processResults());
  observer.observe(document.getElementById("results") || document.body, {
    childList: true,
    subtree: true,
  });
})();
