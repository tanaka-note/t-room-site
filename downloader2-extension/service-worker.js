import "./profile.js";
import { classifyObservation, mergeCandidate } from "./capture/candidates.js";
import { normalizeHeaders, normalizeHeaderObject, requestContext } from "./capture/request-context.js";

const CHANNEL = "tlain-downloader2-v1";
const NATIVE_HOST = "com.tlain.downloader2";
const CONTROLLER_ORIGINS = new Set(globalThis.TLAIN_DOWNLOADER2_PROFILE?.controllerOrigins || []);
const requests = new Map();
const candidates = new Map();
const nativePending = new Map();
let capture = null;
let nativePort = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!allowedController(sender) || message?.channel !== CHANNEL || message?.direction !== "page-to-extension") return false;
  void handleControllerMessage(message, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: safeMessage(error) })
  );
  return true;
});

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!isCaptureTab(details.tabId)) return;
  requests.set(details.requestId, { url: details.url, method: details.method, resourceType: details.type, initiator: details.initiator, headers: {} });
}, { urls: ["<all_urls>"] });

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (!isCaptureTab(details.tabId)) return;
  const current = requests.get(details.requestId) || { url: details.url, method: details.method, resourceType: details.type, initiator: details.initiator };
  current.headers = normalizeHeaders(details.requestHeaders);
  requests.set(details.requestId, current);
}, { urls: ["<all_urls>"] }, ["requestHeaders", "extraHeaders"]);

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (!isCaptureTab(details.tabId)) return;
  const current = requests.get(details.requestId) || { url: details.url, method: "GET", resourceType: details.type, headers: {} };
  const responseHeaders = normalizeHeaders(details.responseHeaders);
  const contentType = headerValue(details.responseHeaders, "content-type");
  emitObservation({
    url: details.url, contentType, status: details.statusCode, resourceType: details.type, source: "webRequest",
    drmSystem: headerValue(details.responseHeaders, "x-tlain-drm-system"),
    requestContext: requestContext(current.method, current.headers, current.initiator),
    responseContext: { url: details.url, headers: responseHeaders }
  });
}, { urls: ["<all_urls>"] }, ["responseHeaders", "extraHeaders"]);

chrome.webRequest.onCompleted.addListener((details) => requests.delete(details.requestId), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener((details) => requests.delete(details.requestId), { urls: ["<all_urls>"] });
chrome.tabs.onRemoved.addListener((tabId) => { if (capture?.captureTabId === tabId) void stopCapture(); });
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!capture?.deep || source.tabId !== capture.captureTabId) return;
  if (method === "Network.requestWillBeSent") {
    const key = `cdp:${params.requestId}`;
    const previous = requests.get(key) || {};
    requests.set(key, {
      ...previous,
      url: params.request?.url, method: params.request?.method, resourceType: String(params.type || "").toLowerCase(),
      initiator: params.documentURL, headers: { ...(previous.headers || {}), ...normalizeHeaderObject(params.request?.headers) }
    });
  }
  if (method === "Network.requestWillBeSentExtraInfo") {
    const key = `cdp:${params.requestId}`;
    const current = requests.get(key) || {};
    current.headers = { ...(current.headers || {}), ...normalizeHeaderObject(params.headers) };
    requests.set(key, current);
  }
  if (method === "Network.responseReceived") {
    const current = requests.get(`cdp:${params.requestId}`) || {};
    emitObservation({
      url: params.response?.url || current.url, contentType: params.response?.mimeType,
      status: params.response?.status, resourceType: String(params.type || current.resourceType || "").toLowerCase(), source: "debugger",
      requestContext: requestContext(current.method, current.headers || {}, current.initiator)
    });
  }
  if (method === "Network.loadingFinished" || method === "Network.loadingFailed") requests.delete(`cdp:${params.requestId}`);
});
chrome.debugger.onDetach.addListener((source) => { if (capture?.captureTabId === source.tabId) capture.deep = false; });

async function handleControllerMessage(message, sender) {
  if (message.type === "page.ready" || message.type === "extension.ping") {
    if (capture) capture.controlTabId = sender.tab.id;
    return { browser: sender.tab?.url?.includes("edge") ? "Edge" : "Chrome", version: chrome.runtime.getManifest().version };
  }
  if (message.type === "capture.start") return startCapture(sender.tab.id, message.payload);
  if (["host.ping", "device.pair.prepare", "device.pair", "download.start", "download.cancel", "history.list", "tools.status"].includes(message.type)) {
    const result = await sendNative({ version: 1, type: message.type, requestId: message.requestId, payload: message.payload || {} });
    return result;
  }
  throw new Error("未対応のExtensionメッセージです。");
}

async function startCapture(controlTabId, payload) {
  const target = new URL(String(payload?.url || ""));
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("http/httpsの動画ページURLを入力してください。");
  await stopCapture();
  requests.clear();
  candidates.clear();
  const tab = await chrome.tabs.create({ url: target.href, active: true });
  capture = { controlTabId, captureTabId: tab.id, deep: false };
  if (payload?.deep) {
    const granted = await chrome.permissions.request({ permissions: ["debugger"] });
    if (!granted) throw new Error("Deep Captureの権限が許可されませんでした。");
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    capture.deep = true;
  }
  return { tabId: tab.id, deep: capture.deep };
}

async function stopCapture() {
  const previous = capture;
  capture = null;
  requests.clear();
  if (previous?.deep && previous.captureTabId != null) {
    try { await chrome.debugger.detach({ tabId: previous.captureTabId }); } catch { /* tab may already be gone */ }
  }
}

function emitObservation(input) {
  const candidate = classifyObservation(input);
  if (!candidate || !capture) return;
  const merged = mergeCandidate(candidates.get(candidate.key), candidate);
  candidates.set(candidate.key, merged);
  void chrome.tabs.sendMessage(capture.controlTabId, { channel: CHANNEL, type: "capture.candidate", candidate: merged }).catch(() => {});
}

function sendNative(message) {
  const port = ensureNativePort();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { nativePending.delete(message.requestId); reject(new Error("Windows Companionから応答がありません。")); }, 15000);
    nativePending.set(message.requestId, { resolve, reject, timer });
    port.postMessage(message);
  });
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener((message) => {
    if (message?.type === "download.progress") {
      if (capture?.controlTabId != null) void chrome.tabs.sendMessage(capture.controlTabId, { channel: CHANNEL, ...message }).catch(() => {});
      return;
    }
    const callback = nativePending.get(message?.requestId);
    if (!callback) return;
    nativePending.delete(message.requestId);
    clearTimeout(callback.timer);
    if (message.ok === false) callback.reject(new Error(message.error?.message || message.error || "Companionで処理を完了できませんでした。"));
    else callback.resolve(message.result || {});
  });
  nativePort.onDisconnect.addListener(() => {
    const error = new Error(chrome.runtime.lastError?.message || "Windows Companionとの接続が切れました。");
    for (const callback of nativePending.values()) { clearTimeout(callback.timer); callback.reject(error); }
    nativePending.clear();
    nativePort = null;
  });
  return nativePort;
}

function allowedController(sender) {
  try {
    const url = new URL(sender.tab?.url || "");
    return CONTROLLER_ORIGINS.has(url.origin) && url.pathname.startsWith("/downloader2/") && sender.frameId === 0;
  } catch { return false; }
}

function isCaptureTab(tabId) { return capture?.captureTabId != null && tabId === capture.captureTabId; }
function headerValue(headers, name) { return (headers || []).find((item) => String(item.name || "").toLowerCase() === name)?.value || ""; }
function safeMessage(error) { const text = String(error?.message || ""); return /[\u3040-\u30ff\u3400-\u9fff]/.test(text) ? text.slice(0, 240) : "Extensionで処理を完了できませんでした。"; }
