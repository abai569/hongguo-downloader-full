/**
 * douyin-hook.js - 解析窗口专用 preload
 *
 * 目的：在页面内拦截 fetch / XHR 的响应，把 JSON 正文存到 window.__dyData，
 * 由主进程轮询取走。相比 CDP 的 Network.getResponseBody（在抖音这种大页面上
 * 极易报 "No resource with given identifier found"），页面内拦截稳定得多。
 *
 * 该窗口 contextIsolation 关闭、nodeIntegration 关闭：只暴露数据，不暴露 Node。
 */
const MAX_ITEMS = 60;
const MAX_BODY = 3 * 1024 * 1024;
const INTEREST = /\/aweme\/|\/playlet\/|\/mix\/|\/collection|\/user\/|\/publish|\/item\/|\/listcollection/i;

function push(url, body) {
  try {
    if (!url || typeof body !== 'string') return;
    if (!INTEREST.test(url)) return;
    if (body.length > MAX_BODY) return;
    if (!Array.isArray(window.__dyData)) window.__dyData = [];
    window.__dyData.push({ url, body, t: Date.now() });
    if (window.__dyData.length > MAX_ITEMS) window.__dyData.splice(0, window.__dyData.length - MAX_ITEMS);
    window.__dyCount = (window.__dyCount || 0) + 1;
  } catch (_) {}
}

function install() {
  if (window.__dyHooked) return;
  window.__dyHooked = true;
  window.__dyData = [];
  window.__dyCount = 0;

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function patchedFetch(...args) {
      const promise = origFetch.apply(this, args);
      promise
        .then((res) => {
          try {
            const url = String((res && res.url) || (args[0] && (args[0].url || args[0])) || '');
            if (!INTEREST.test(url)) return;
            res.clone().text().then((text) => push(url, text)).catch(() => {});
          } catch (_) {}
        })
        .catch(() => {});
      return promise;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && OrigXHR.prototype) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function patchedOpen(method, url, ...rest) {
      try { this.__dyUrl = String(url || ''); } catch (_) {}
      return origOpen.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.send = function patchedSend(...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const url = String(this.responseURL || this.__dyUrl || '');
            const type = this.responseType;
            if (type === '' || type === 'text') {
              push(url, this.responseText);
            } else if (type === 'json' && this.response) {
              push(url, JSON.stringify(this.response));
            }
          } catch (_) {}
        });
      } catch (_) {}
      return origSend.apply(this, args);
    };
  }
}

install();
