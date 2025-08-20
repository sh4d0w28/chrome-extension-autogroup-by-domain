const DEFAULT_CONFIG = {
  groupByBaseDomain: true,
  defaultColor: "grey",
  categories: [
    { title: "Jira",    color: "yellow", patterns: ["atlassian.net", "jira"] },
    { title: "Gmail",   color: "red",    patterns: ["mail.google.com", "gmail.com"] },
    { title: "Git",     color: "blue",   patterns: ["github.com", "gitlab.com", "bitbucket.org"] },
    { title: "Jenkins", color: "green",  patterns: ["jenkins"] }
  ]
};

let CONFIG = DEFAULT_CONFIG;

// cache windowId:title -> groupId
const cache = new Map();

function getBase(host) {
  const parts = host.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host;
}

function matches(host, pattern) {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("/") && p.endsWith("/")) {
    try { return new RegExp(p.slice(1, -1), "i").test(host); } catch { return false; }
  }
  return host === p || host.endsWith("." + p) || host.includes(p);
}

function classify(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase();

    for (const c of CONFIG.categories || []) {
      if ((c.patterns || []).some(p => matches(host, p))) {
        return { title: c.title, color: c.color || CONFIG.defaultColor || "grey" };
      }
    }
    if (CONFIG.groupByBaseDomain) {
      return { title: getBase(host), color: CONFIG.defaultColor || "grey" };
    }
    return null;
  } catch { return null; }
}

async function findGroupIdByTitle(windowId, title) {
  const key = `${windowId}:${title}`;
  if (cache.has(key)) return cache.get(key) || null;

  const tabs = await chrome.tabs.query({ windowId });
  const ids = [...new Set(tabs.map(t => t.groupId).filter(id => id && id > -1))];
  for (const gid of ids) {
    try {
      const g = await chrome.tabGroups.get(gid);
      if (g.title === title) { cache.set(key, gid); return gid; }
    } catch {}
  }
  return null;
}

async function groupTab(tab) {
  if (!tab?.id || !tab?.windowId || !tab?.url) return;
  const info = classify(tab.url);
  if (!info) return;
  const existing = await findGroupIdByTitle(tab.windowId, info.title);
  if (existing) { await chrome.tabs.group({ groupId: existing, tabIds: tab.id }); return; }
  const newId = await chrome.tabs.group({ tabIds: tab.id });
  await chrome.tabGroups.update(newId, { title: info.title, color: info.color });
  cache.set(`${tab.windowId}:${info.title}`, newId);
}

async function regroupAll() {
  const wins = await chrome.windows.getAll();
  for (const w of wins) {
    const tabs = await chrome.tabs.query({ windowId: w.id });
    for (const t of tabs) await groupTab(t);
  }
}

function loadConfig(initial = false) {
  chrome.storage.sync.get({ tabgrouper: DEFAULT_CONFIG }, (obj) => {
    CONFIG = obj.tabgrouper || DEFAULT_CONFIG;
    cache.clear();
    if (initial) regroupAll();
  });
}

chrome.runtime.onInstalled.addListener(() => loadConfig(true));
chrome.runtime.onStartup.addListener(() => loadConfig(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.tabgrouper) { loadConfig(false); regroupAll(); }
});

chrome.tabs.onUpdated.addListener((id, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") groupTab(tab);
});
chrome.tabs.onCreated.addListener((tab) => { if (tab.url) groupTab(tab); });
chrome.tabs.onAttached.addListener((tabId) => {
  chrome.tabs.get(tabId).then(groupTab).catch(() => {});
});
chrome.windows.onCreated.addListener(() => { regroupAll(); });

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "reapply-grouping") regroupAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "regroup") { regroupAll().then(() => sendResponse({ ok: true })); return true; }
});
