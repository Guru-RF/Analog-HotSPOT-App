"use strict";

/**
 * HotSpot — Settings window
 *
 * Standalone child window that owns the full settings form. Loads via IPC,
 * saves via IPC (the main process broadcasts settings:changed to the main
 * window so it re-applies live). Also drives address → coordinates lookup
 * via OpenStreetMap Nominatim (request goes through the main process so the
 * required User-Agent header can be set).
 */

const DEFAULT_HOME_RADIUS_KM = 150;

const $ = (id) => document.getElementById(id);

const els = {
  status: $("sp-status"),
  themeToggle: $("themeToggle"),
  appTitle: $("input-app-title"),
  historyLimit: $("history-limit"),
  reflectorDomain: $("input-reflector-domain"),
  reflectorProbeResult: $("reflector-probe-result"),
  wss: $("wssToggle"),
  tgAuto: $("tgAutoUpdateToggle"),
  street: $("input-home-street"),
  number: $("input-home-number"),
  zip: $("input-home-zip"),
  city: $("input-home-city"),
  country: $("input-home-country"),
  geoResult: $("geo-lookup-result"),
  lat: $("input-home-lat"),
  lng: $("input-home-lng"),
  radius: $("input-home-radius"),
  tgInfo: $("input-tg-info"),
};

// Local copy of the settings as loaded from disk, used as the merge base on
// save so partial updates don't drop unrelated keys.
let currentSettings = null;
// Set on any change to any form input; consulted on Cancel / window-close to
// prompt before discarding edits.
let dirty = false;
let suppressDirty = false; // true while populate()/loadDefaults() is running

function escapeText(s) {
  return String(s ?? "")
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
function isSafeHostname(s) {
  if (typeof s !== "string") return false;
  const t = s.trim().toLowerCase();
  if (!t || t.length > 253) return false;
  return HOSTNAME_RE.test(t);
}

// Live preview of theme — persisted to settings.json on Save.
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  els.themeToggle.checked = dark;
}

function setStatus(text, cls) {
  els.status.textContent = text || "";
  els.status.className = "sp-hint " + (cls || "");
}

function markDirty() { if (!suppressDirty) dirty = true; }

function normalizeReflectorHost(input) {
  let h = String(input || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("wss://"))   h = h.slice(6);
  if (h.startsWith("ws://"))    h = h.slice(5);
  if (h.startsWith("https://")) h = h.slice(8);
  if (h.startsWith("http://"))  h = h.slice(7);
  const slash = h.indexOf("/");
  if (slash >= 0) h = h.slice(0, slash);
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  if (!h) return "";
  if (h.startsWith("reflector.")) return h;
  return `reflector.${h}`;
}

function portalTalkgroupsUrlFor(domain) {
  let h = String(domain || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("wss://"))   h = h.slice(6);
  if (h.startsWith("ws://"))    h = h.slice(5);
  if (h.startsWith("https://")) h = h.slice(8);
  if (h.startsWith("http://"))  h = h.slice(7);
  const slash = h.indexOf("/");
  if (slash >= 0) h = h.slice(0, slash);
  if (h.startsWith("portal.")) return `https://${h}/talkgroups.json`;
  if (h.startsWith("reflector.")) h = h.slice("reflector.".length);
  return `https://portal.${h}/talkgroups.json`;
}

function buildAddressQuery() {
  const parts = [];
  const street = els.street.value.trim();
  const number = els.number.value.trim();
  if (street || number) parts.push([street, number].filter(Boolean).join(" "));
  const zip = els.zip.value.trim();
  const city = els.city.value.trim();
  if (zip || city) parts.push([zip, city].filter(Boolean).join(" "));
  const country = els.country.value.trim();
  if (country) parts.push(country);
  return parts.join(", ");
}

// Debounce so a held-down Lookup key / accidental double-click doesn't spam
// Nominatim's 1 req/s policy. The main process also rate-limits to 1500 ms.
let lookupInFlight = false;
let lastLookupAt = 0;
async function doGeoLookup() {
  if (lookupInFlight) return;
  const wait = Math.max(0, 1500 - (Date.now() - lastLookupAt));
  if (wait > 0) {
    els.geoResult.textContent = `Please wait ${Math.ceil(wait / 1000)} s before retrying.`;
    els.geoResult.className = "settings-hint bad";
    return;
  }
  const query = buildAddressQuery();
  if (!query) {
    els.geoResult.textContent = "Enter at least a city to look up.";
    els.geoResult.className = "settings-hint bad";
    return;
  }
  lookupInFlight = true;
  lastLookupAt = Date.now();
  els.geoResult.innerHTML = `Looking up <strong>${escapeText(query)}</strong>…`;
  els.geoResult.className = "settings-hint";
  try {
    const res = await window.api.geoLookup(query);
    if (!res) {
      els.geoResult.textContent = "No match. Try simplifying the address (street + city + country).";
      els.geoResult.className = "settings-hint bad";
      return;
    }
    els.lat.value = res.lat.toFixed(6);
    els.lng.value = res.lon.toFixed(6);
    markDirty();
    const dn = res.displayName || "";
    if (dn) {
      els.geoResult.innerHTML = `✓ ${escapeText(dn)}`;
    } else {
      els.geoResult.textContent = `✓ ${res.lat.toFixed(5)}, ${res.lon.toFixed(5)}`;
    }
    els.geoResult.className = "settings-hint ok";
  } catch (e) {
    els.geoResult.textContent = `Lookup failed: ${e.message || e}`;
    els.geoResult.className = "settings-hint bad";
  } finally {
    lookupInFlight = false;
  }
}

// WS-handshake probe done from this window (CORS isn't a constraint for WS).
async function probeReflectorWss(domain) {
  const host = normalizeReflectorHost(domain);
  if (!host || !isSafeHostname(host)) return false;
  return await new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        if (ws) {
          ws.onopen = ws.onerror = ws.onclose = null;
          ws.close();
        }
      } catch (_) {}
      resolve(ok);
    };
    try { ws = new WebSocket(`wss://${host}/`); } catch (_) { return resolve(false); }
    ws.onopen  = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
    setTimeout(() => finish(false), 4000);
  });
}

async function fetchTalkgroupsFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
  } catch { return null; }
  const ac = new AbortController();
  const tmo = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) return null;
    const json = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(json)) {
      if (count >= 500) break;
      const key = String(k).trim().slice(0, 32);
      const val = String(v ?? "").slice(0, 128);
      if (key) { out[key] = val; count += 1; }
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
  finally { clearTimeout(tmo); }
}

async function reflectorProbe() {
  const domain = els.reflectorDomain.value.trim();
  if (!domain) {
    els.reflectorProbeResult.textContent = "Enter a domain first.";
    els.reflectorProbeResult.className = "settings-hint bad";
    return;
  }
  if (!isSafeHostname(domain.replace(/^reflector\./i, "").replace(/^portal\./i, ""))) {
    els.reflectorProbeResult.textContent = "Domain doesn't look like a hostname.";
    els.reflectorProbeResult.className = "settings-hint bad";
    return;
  }
  els.reflectorProbeResult.textContent = "Probing…";
  els.reflectorProbeResult.className = "settings-hint";
  const wssOk = await probeReflectorWss(domain);
  const tg = await fetchTalkgroupsFromUrl(portalTalkgroupsUrlFor(domain));
  els.reflectorProbeResult.textContent =
    `${wssOk ? "✓ WSS" : "✗ WSS"}   ${tg ? `✓ talkgroups (${Object.keys(tg).length})` : "✗ talkgroups"}`;
  els.reflectorProbeResult.className = "settings-hint " + (wssOk && tg ? "ok" : "bad");
}

function populate(cfg) {
  suppressDirty = true;
  try {
    currentSettings = cfg;
    applyTheme(cfg.theme !== "light");
    els.appTitle.value = cfg.title || "";
    els.historyLimit.value = String(cfg.historyLimit || 50);
    els.reflectorDomain.value = cfg.reflectorDomain || "";
    els.wss.checked = cfg.wssEnabled !== false;
    els.tgAuto.checked = !!cfg.tgAutoUpdate;
    els.street.value = cfg.homeStreet || "";
    els.number.value = cfg.homeNumber || "";
    els.zip.value = cfg.homeZip || "";
    els.city.value = cfg.homeCity || "";
    els.country.value = cfg.homeCountry || "";
    els.lat.value = cfg.homeLat != null ? String(cfg.homeLat) : "";
    els.lng.value = cfg.homeLng != null ? String(cfg.homeLng) : "";
    els.radius.value = cfg.homeRadiusKm != null ? String(cfg.homeRadiusKm) : String(DEFAULT_HOME_RADIUS_KM);
    els.tgInfo.value =
      cfg.talkgroupInfo && Object.keys(cfg.talkgroupInfo).length
        ? JSON.stringify(cfg.talkgroupInfo, null, 2)
        : "";
  } finally {
    suppressDirty = false;
    dirty = false;
  }
}

async function loadDefaults() {
  const d = await window.api.getDefaults();
  populate(d);
  // Loading defaults IS a change vs disk — mark dirty so Cancel prompts.
  dirty = true;
}

async function save() {
  setStatus("");
  const title = (els.appTitle.value || "").trim().slice(0, 64) || "HotSpot";
  const limit = Number(els.historyLimit.value) || 50;
  const theme = els.themeToggle.checked ? "dark" : "light";

  let talkgroupInfo = {};
  try {
    const raw = (els.tgInfo.value || "").trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setStatus("Talkgroups JSON must be an object of {tg: label} pairs.", "bad");
        return;
      }
      talkgroupInfo = parsed;
    }
  } catch {
    setStatus("Talkgroups JSON is not valid.", "bad");
    return;
  }

  const reflectorDomain = els.reflectorDomain.value.trim();
  if (reflectorDomain && !isSafeHostname(reflectorDomain.replace(/^reflector\./i, "").replace(/^portal\./i, ""))) {
    setStatus("Reflector domain doesn't look like a hostname.", "bad");
    return;
  }
  const wssEnabled = !!els.wss.checked;
  const tgAutoUpdate = !!els.tgAuto.checked;
  const tgUpdateUrl = reflectorDomain ? portalTalkgroupsUrlFor(reflectorDomain) : "";

  const latStr = els.lat.value.trim();
  const lngStr = els.lng.value.trim();
  const homeLat = latStr ? Number(latStr) : null;
  const homeLng = lngStr ? Number(lngStr) : null;
  if (homeLat != null && (!Number.isFinite(homeLat) || homeLat < -90 || homeLat > 90)) {
    setStatus("Latitude must be a number between -90 and 90.", "bad");
    return;
  }
  if (homeLng != null && (!Number.isFinite(homeLng) || homeLng < -180 || homeLng > 180)) {
    setStatus("Longitude must be a number between -180 and 180.", "bad");
    return;
  }
  let homeRadiusKm = Number(els.radius.value);
  if (!Number.isFinite(homeRadiusKm) || homeRadiusKm < 1) homeRadiusKm = DEFAULT_HOME_RADIUS_KM;
  if (homeRadiusKm > 5000) homeRadiusKm = 5000;

  const partial = {
    theme, historyLimit: limit,
    title, talkgroupInfo,
    reflectorDomain, wssEnabled, tgAutoUpdate, tgUpdateUrl,
    homeStreet:  els.street.value.trim().slice(0, 128),
    homeNumber:  els.number.value.trim().slice(0, 32),
    homeZip:     els.zip.value.trim().slice(0, 32),
    homeCity:    els.city.value.trim().slice(0, 128),
    homeCountry: els.country.value.trim().slice(0, 64),
    homeLat: Number.isFinite(homeLat) ? homeLat : null,
    homeLng: Number.isFinite(homeLng) ? homeLng : null,
    homeRadiusKm,
  };

  try {
    await window.api.saveSettings(partial);
  } catch (e) {
    setStatus("Save failed: " + (e.message || e), "bad");
    return;
  }
  dirty = false;
  window.api.closeSettingsWindow();
}

function tryClose() {
  if (dirty && !confirm("Discard unsaved changes?")) return;
  dirty = false;
  window.api.closeSettingsWindow();
}

function wire() {
  $("btn-cancel")?.addEventListener("click", tryClose);
  $("btn-save")?.addEventListener("click", save);
  $("btn-restore-defaults")?.addEventListener("click", loadDefaults);
  $("btn-clear-history")?.addEventListener("click", () => {
    if (!confirm("Clear the talker history?")) return;
    try { localStorage.removeItem("ahs-app-talker-history-v1"); } catch {}
    setStatus("History cleared (effective on next launch of the main window).", "ok");
  });
  $("btn-clear-home")?.addEventListener("click", () => {
    els.lat.value = "";
    els.lng.value = "";
    markDirty();
  });
  $("btn-geo-lookup")?.addEventListener("click", doGeoLookup);
  $("btn-reflector-probe")?.addEventListener("click", reflectorProbe);
  els.themeToggle?.addEventListener("change", () => {
    applyTheme(els.themeToggle.checked);
    markDirty();
  });
  // Dirty-state tracking — any form change.
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  });
  // Keyboard a11y — Esc cancels, Cmd/Ctrl+S saves.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      tryClose();
    } else if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  });
  // Window-close from OS chrome / Cmd+W — prompt if dirty.
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

(async function main() {
  wire();
  const cfg = await window.api.loadSettings();
  populate(cfg);
})();
