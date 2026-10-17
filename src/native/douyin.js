/**
 * douyin.js - 抖音合集解析与无水印直链获取
 *
 * 合集作品列表走 aweme/v1/web/mix/aweme 接口，请求带 a_bogus 签名，
 * 纯 HTTP 无法自行构造。这里改为在隐藏窗口里打开合集页，
 * 用 CDP 抓抖音前端自己发出的签名请求，直接复用其响应。
 * 响应里的 aweme_list 已带 play_addr，列表与直链一次拿全。
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 9; SM-N9860) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.152 Mobile Safari/537.36';
const REFERER = 'https://www.douyin.com/';

const PAGE_API = /\/aweme\/v1\/web\/(mix\/aweme|aweme\/post|collection)/;
const DETAIL_API = /\/aweme\/v1\/web\/(aweme\/detail|mix\/aweme)/;

const FIRST_PAGE_TIMEOUT_MS = 20000;
const SCROLL_WAIT_MS = 1600;
const MAX_SCROLLS = 80;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// ===== 诊断日志 =====
// 打包版没有终端，解析失败时用户看不到主进程输出。
// 这里把关键过程落盘，排查时只需要这个文件。
let logFile = null;

function logPath() {
  if (logFile !== null) return logFile;
  try {
    const { app } = require('electron');
    logFile = path.join(app.getPath('userData'), 'douyin-parse.log');
  } catch (_) {
    logFile = '';
  }
  return logFile;
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try { console.log(line); } catch (_) {}
  try {
    const file = logPath();
    if (file) fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (_) {}
}

function resetLogIfLarge() {
  try {
    const file = logPath();
    if (!file || !fs.existsSync(file)) return;
    if (fs.statSync(file).size > LOG_MAX_BYTES) fs.truncateSync(file, 0);
  } catch (_) {}
}

/** 日志里只留路径，避免刷屏和泄露带签名的查询串 */
function urlPath(url) {
  if (!url) return '';
  try {
    return new URL(url).pathname;
  } catch (_) {
    return String(url).split('?')[0];
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>，。]+/i);
  return match ? match[0] : '';
}

/** 从合集页面 URL 里取 mix_id（只认合集形态，单条作品另走视频解析） */
function mixIdFromUrl(url) {
  if (!url) return '';
  const patterns = [
    /\/collection\/(\d{6,})/,
    /\/share\/collection\/(\d{6,})/,
    /[?&]mix_id=(\d{6,})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return '';
}

/** 从作品页面 URL 里取 aweme_id */
function videoIdFromUrl(url) {
  if (!url) return '';
  const patterns = [
    /\/video\/(\d{6,})/,
    /\/share\/video\/(\d{6,})/,
    /[?&]modal_id=(\d{6,})/,
    /[?&]aweme_id=(\d{6,})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return '';
}

/** 短链跟随跳转，拿到真实地址 */
async function followRedirect(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': MOBILE_UA },
      maxRedirects: 10,
      timeout: 15000,
      validateStatus: () => true,
    });
    const finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || url;
    return { finalUrl, html: typeof response.data === 'string' ? response.data : '' };
  } catch (error) {
    return { finalUrl: url, html: '' };
  }
}

/**
 * 识别用户输入：合集链接 / 短链 / 分享文案 / 纯数字 mix_id。
 * 返回 { mixId, pageUrl }。
 */
async function resolveCollectionTarget(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('请粘贴抖音合集分享链接或分享文案');

  const url = extractUrl(text);
  if (!url && /^\d{15,}$/.test(text)) {
    return { kind: 'video', id: text };
  }
  if (!url) throw new Error('没有找到链接，请粘贴完整分享文案或合集地址');

  let current = url;
  let mixId = mixIdFromUrl(current);
  let videoId = videoIdFromUrl(current);
  if (!mixId && !videoId && /v\.douyin\.com|iesdouyin\.com/i.test(current)) {
    const { finalUrl } = await followRedirect(current);
    current = finalUrl || current;
    mixId = mixIdFromUrl(current);
    videoId = videoIdFromUrl(current);
  }
  if (mixId) return { kind: 'collection', id: mixId };
  if (videoId) return { kind: 'video', id: videoId };
  throw new Error('无法识别的链接：请粘贴抖音合集页或作品的分享链接');
}

function pickCover(video, aweme) {
  const cover = (video && video.cover) || (video && video.origin_cover) || {};
  const list = cover.url_list || [];
  const first = list.find((item) => typeof item === 'string' && /^https?:\/\//.test(item));
  if (first) return first;
  const dynamic = (video && video.dynamic_cover && video.dynamic_cover.url_list) || [];
  return dynamic.find((item) => typeof item === 'string' && /^https?:\/\//.test(item)) || '';
}

/** 挑选无水印直链：bit_rate 高清优先，其次 play_addr，最后 download_addr 去水印 */
function pickVideoUrl(video) {
  const candidates = [];
  const push = (raw) => {
    if (typeof raw === 'string' && /^https?:\/\//.test(raw)) candidates.push(raw);
  };
  for (const rate of (video && video.bit_rate) || []) {
    if (!rate || !rate.play_addr) continue;
    for (const url of rate.play_addr.url_list || []) push(url);
  }
  if (video && video.play_addr) {
    for (const url of video.play_addr.url_list || []) push(url);
  }
  if (video && video.download_addr) {
    for (const url of video.download_addr.url_list || []) push(url);
  }
  if (!candidates.length) return '';
  const cleaned = candidates.map((url) => url.replace(/\/playwm\//g, '/play/').replace(/playwm/g, 'play'));
  return cleaned.find((url) => url.includes('/play/')) || cleaned[0];
}

/** 单条 aweme -> 统一结构 */
function normalizeAweme(aweme, index) {
  const video = (aweme && aweme.video) || {};
  const images = Array.isArray(aweme && aweme.images) && aweme.images.length ? aweme.images : null;
  const title = String((aweme && aweme.desc) || '').trim();
  return {
    aweme_id: String((aweme && aweme.aweme_id) || ''),
    index,
    title: title || `作品 ${index}`,
    cover: pickCover(video, aweme),
    duration: video && video.duration ? Math.round(video.duration / 1000) : 0,
    url: images ? '' : pickVideoUrl(video),
    type: images ? 'images' : 'video',
    music: (aweme && aweme.music && aweme.music.title) || '',
  };
}

/**
 * 在隐藏窗口里打开合集页，用 CDP 抓抖音自己发出的 mix/aweme 响应，
 * 并自动滚动触发分页。任一环节失败时退回 DOM 抓作品 ID。
 */
async function captureCollection(mixId, options) {
  const { BrowserWindow } = require('electron');
  const showWindow = options && options.showWindow;
  const onProgress = (options && options.onProgress) || (() => {});
  const pageUrl = `https://www.douyin.com/collection/${mixId}`;

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: !!showWindow,
    title: '抖音合集解析',
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },
  });

  const state = { pages: [], hasMore: true, bodies: 0, seen: 0 };
  let attached = false;

  log('[capture] open', pageUrl, 'showWindow=' + !!showWindow);

  try {
    win.webContents.setUserAgent(UA);
    win.webContents.on('did-finish-load', () => log('[capture] did-finish-load'));
    win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) =>
      log('[capture] did-fail-load', code, desc, urlPath(failedUrl)));
    win.webContents.on('render-process-gone', (_e, details) =>
      log('[capture] render-process-gone', JSON.stringify(details || {})));

    const debuggerApi = win.webContents.debugger;
    try {
      debuggerApi.attach('1.3');
      attached = true;
      log('[capture] CDP attached');
      debuggerApi.on('message', async (_event, method, params) => {
        if (method !== 'Network.responseReceived') return;
        const url = params && params.response && params.response.url;
        if (!url) return;
        const status = params.response.status;

        // 把页面实际发出的 aweme 系请求都记下来：
        // 接口一旦改名，这里能直接看出应该匹配什么路径
        if (/\/aweme\//.test(url) || /\/mix\//.test(url)) {
          if (state.seen < 80) {
            state.seen += 1;
            log('[capture] resp', status, urlPath(url));
          }
        }

        if (!PAGE_API.test(url)) return;
        try {
          const { body } = await debuggerApi.sendCommand('Network.getResponseBody', {
            requestId: params.requestId,
          });
          log('[capture] hit', urlPath(url), 'bodyLen=' + (body ? body.length : 0));
          const json = JSON.parse(body);
          state.bodies += 1;
          if (Array.isArray(json.aweme_list)) state.pages.push(json);
          if (json.has_more === false) state.hasMore = false;
          log(
            '[capture] page#' + state.bodies,
            'list=' + ((json.aweme_list && json.aweme_list.length) || 0),
            'total=' + countItems(state.pages),
            'has_more=' + json.has_more,
            'cursor=' + json.cursor
          );
          onProgress({ stage: 'page', pages: state.bodies, found: countItems(state.pages) });
        } catch (error) {
          log('[capture] body-fail', urlPath(url), error.message);
        }
      });
      await debuggerApi.sendCommand('Network.enable');
    } catch (error) {
      log('[capture] CDP 不可用:', error.message);
      console.warn('[Douyin] CDP 不可用，改用 DOM 抓取:', error.message);
    }

    await win.loadURL(pageUrl, { userAgent: UA });
    try {
      const title = await win.webContents.getTitle();
      log('[capture] title=' + JSON.stringify(title || ''));
    } catch (_) {}

    const startedAt = Date.now();
    while (Date.now() - startedAt < FIRST_PAGE_TIMEOUT_MS && state.pages.length === 0) {
      await delay(400);
    }
    if (state.pages.length === 0) {
      log('[capture] 首屏超时，未捕获到页面列表（waitMs=' + (Date.now() - startedAt) + '）');
    }

    let lastCount = -1;
    let stable = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      const count = countItems(state.pages);
      if (count === lastCount) stable += 1;
      else stable = 0;
      if (state.pages.length > 0 && (!state.hasMore || stable >= 3)) break;
      lastCount = count;
      try {
        await win.webContents.executeJavaScript(
          'window.scrollTo(0, document.body.scrollHeight); document.body.scrollHeight;',
          true
        );
      } catch (_) {}
      await delay(SCROLL_WAIT_MS);
      onProgress({ stage: 'scroll', pages: state.bodies, found: countItems(state.pages) });
    }
    log('[capture] scroll 结束 total=' + countItems(state.pages) + ' pages=' + state.bodies + ' hasMore=' + state.hasMore);

    let mixName = '';
    let author = '';
    for (const page of state.pages) {
      const info = page.mix_info || page.collection_info;
      if (!mixName && info && info.mix_name) mixName = info.mix_name;
      if (!author && info && info.author && info.author.nickname) author = info.author.nickname;
    }

    if (!countItems(state.pages)) {
      const domIds = await scrapeDomIds(win);
      log('[capture] DOM 兜底 id 数=' + domIds.length);
      if (domIds.length) {
        return { pages: state.pages, domIds, mixName, author };
      }
    }

    return { pages: state.pages, domIds: [], mixName, author };
  } finally {
    try {
      if (attached) win.webContents.debugger.detach();
    } catch (_) {}
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
  }
}

function countItems(pages) {
  let total = 0;
  for (const page of pages) total += (page.aweme_list || []).length;
  return total;
}

/** 兜底：从渲染后的 DOM 里收集作品 ID */
async function scrapeDomIds(win) {
  try {
    const ids = await win.webContents.executeJavaScript(`(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="/video/"]').forEach((a) => {
        const m = (a.getAttribute('href') || '').match(/\\/video\\/(\\d{6,})/);
        if (m) set.add(m[1]);
      });
      return [...set];
    })()`, true);
    return Array.isArray(ids) ? ids : [];
  } catch (_) {
    return [];
  }
}

/** 逐条补解析（DOM 兜底路径 / 下载重试时重新取直链） */
async function resolvePlayUrl(awemeId) {
  const id = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(id)) throw new Error('作品 ID 无效');

  const shareUrl = `https://www.iesdouyin.com/share/video/${id}/`;
  log('[detail] share 页', shareUrl);
  try {
    const response = await axios.get(shareUrl, {
      headers: {
        'User-Agent': MOBILE_UA,
        Referer: REFERER,
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: 20000,
      maxRedirects: 10,
    });
    const html = typeof response.data === 'string' ? response.data : '';
    log('[detail] share status=' + response.status + ' htmlLen=' + html.length);
    const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
    log('[detail] _ROUTER_DATA ' + (match ? '命中' : '未命中'));
    if (match) {
      const router = JSON.parse(match[1]);
      const loader = router.loaderData || {};
      for (const key of Object.keys(loader)) {
        const res = loader[key] && loader[key].videoInfoRes;
        const itemList = res && res.item_list;
        if (Array.isArray(itemList) && itemList.length) {
          const item = itemList[0];
          const url = pickVideoUrl(item.video || {});
          log('[detail] item_list=' + itemList.length + ' playUrl=' + (url ? urlPath(url) : '空'));
          if (url) {
            return {
              url,
              referer: REFERER,
              title: String(item.desc || '').trim(),
              cover: pickCover(item.video || {}, item),
              duration: item.video && item.video.duration ? Math.round(item.video.duration / 1000) : 0,
              type: Array.isArray(item.images) && item.images.length ? 'images' : 'video',
            };
          }
        }
      }
      log('[detail] 遍历 loaderData 未取到直链');
    }
  } catch (error) {
    log('[detail] share 页失败:', error.message);
    console.warn('[Douyin] 分享页解析失败，改用页面抓包:', error.message);
  }

  log('[detail] 回落到页面抓包', id);
  return resolveByCapture(id);
}

/** 兜底：打开作品页，用 CDP 抓 aweme/detail 响应 */
async function resolveByCapture(awemeId) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  let attached = false;
  let result = null;

  try {
    win.webContents.setUserAgent(UA);
    const debuggerApi = win.webContents.debugger;
    debuggerApi.attach('1.3');
    attached = true;
    log('[detail] 抓包窗口 CDP attached');
    debuggerApi.on('message', async (_event, method, params) => {
      if (result) return;
      if (method !== 'Network.responseReceived') return;
      const url = params && params.response && params.response.url;
      if (!url) return;
      if (/\/aweme\//.test(url)) log('[detail] resp', params.response.status, urlPath(url));
      if (!DETAIL_API.test(url)) return;
      try {
        const { body } = await debuggerApi.sendCommand('Network.getResponseBody', {
          requestId: params.requestId,
        });
        log('[detail] hit', urlPath(url), 'bodyLen=' + (body ? body.length : 0));
        const json = JSON.parse(body);
        const list = json.aweme_list || json.aweme_details || [];
        const item = Array.isArray(list) ? list[0] : null;
        if (!item) {
          log('[detail] 响应里没有 aweme');
          return;
        }
        const playUrl = pickVideoUrl(item.video || {});
        if (!playUrl) {
          log('[detail] aweme 里没有可用 play_addr');
          return;
        }
        result = {
          url: playUrl,
          referer: REFERER,
          title: String(item.desc || '').trim(),
          cover: pickCover(item.video || {}, item),
          duration: item.video && item.video.duration ? Math.round(item.video.duration / 1000) : 0,
          type: 'video',
        };
      } catch (error) {
        log('[detail] body-fail', urlPath(url), error.message);
      }
    });
    await debuggerApi.sendCommand('Network.enable');

    await win.loadURL(`https://www.douyin.com/video/${awemeId}`, { userAgent: UA });
    try {
      log('[detail] title=' + JSON.stringify((await win.webContents.getTitle()) || ''));
    } catch (_) {}

    const startedAt = Date.now();
    while (Date.now() - startedAt < FIRST_PAGE_TIMEOUT_MS && !result) {
      await delay(400);
    }
    if (!result) throw new Error('未获取到无水印直链（可能触发风控，可在设置里打开「显示解析窗口」重试）');
    return result;
  } finally {
    try {
      if (attached) win.webContents.debugger.detach();
    } catch (_) {}
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
  }
}

/** 解析合集：列表 + 无水印直链；粘贴单条作品链接时退化为单作品解析 */
async function resolveCollection(input, options = {}) {
  resetLogIfLarge();
  log('===== 开始解析 =====');
  log('[input]', JSON.stringify(String(input || '').slice(0, 200)));

  const target = await resolveCollectionTarget(input);
  log('[target] kind=' + target.kind + ' id=' + target.id);

  const onProgress = options.onProgress || (() => {});
  onProgress({ stage: 'opening', pages: 0, found: 0 });

  if (target.kind === 'video') {
    const info = await resolvePlayUrl(target.id);
    const title = sanitizeName(info.title) || `作品${target.id.slice(-6)}`;
    const item = {
      aweme_id: target.id,
      index: 1,
      title: info.title || title,
      cover: info.cover || '',
      duration: info.duration || 0,
      url: info.url,
      type: info.type || 'video',
      music: '',
    };
    const usable = item.type === 'video' && item.url;
    return {
      mix_id: target.id,
      mix_name: title,
      author: '',
      total: 1,
      videos: usable ? 1 : 0,
      images: usable ? 0 : 1,
      items: [item],
      single: true,
    };
  }

  const captured = await captureCollection(target.id, {
    showWindow: options.showWindow,
    onProgress,
  });

  const items = [];
  const seen = new Set();
  for (const page of captured.pages) {
    for (const aweme of page.aweme_list || []) {
      const id = String((aweme && aweme.aweme_id) || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push(normalizeAweme(aweme, items.length + 1));
    }
  }

  if (!items.length && captured.domIds.length) {
    onProgress({ stage: 'detail', pages: captured.pages.length, found: 0 });
    for (let i = 0; i < captured.domIds.length; i++) {
      try {
        const info = await resolvePlayUrl(captured.domIds[i]);
        items.push({
          aweme_id: captured.domIds[i],
          index: i + 1,
          title: info.title || `作品 ${i + 1}`,
          cover: info.cover || '',
          duration: info.duration || 0,
          url: info.url,
          type: info.type || 'video',
          music: '',
        });
      } catch (_) {}
      onProgress({ stage: 'detail', pages: captured.pages.length, found: items.length });
    }
  }

  if (!items.length) {
    log('[result] 失败：没有解析到任何作品');
    throw new Error('未能获取合集作品列表；若页面要求验证，请到设置里打开「显示解析窗口」后重试');
  }

  const mixName = sanitizeName(captured.mixName) || `合集${target.id.slice(-6)}`;
  const usableCount = items.filter((item) => item.type === 'video' && item.url).length;
  log(
    '[result] 成功 mix=' + JSON.stringify(mixName),
    'total=' + items.length,
    'videos=' + usableCount,
    'images=' + (items.length - usableCount),
    'source=' + (captured.pages.length ? 'cdp' : 'dom')
  );

  return {
    mix_id: target.id,
    mix_name: mixName,
    author: captured.author || '',
    total: items.length,
    videos: usableCount,
    images: items.filter((item) => item.type !== 'video').length,
    items,
  };
}

module.exports = {
  UA,
  REFERER,
  sanitizeName,
  resolveCollection,
  resolvePlayUrl,
  resolveCollectionTarget,
  log,
  logPath,
};
