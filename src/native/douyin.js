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
const PLAY_REFERER = 'https://www.iesdouyin.com/';

const PAGE_API = /\/aweme\/v1\/web\/(mix\/aweme|aweme\/post|collection|aweme\/listcollection)/;
const DETAIL_API = /\/aweme\/v1\/web\/(aweme\/detail|mix\/aweme)/;
const LOGIN_COOKIE_NAMES = ['sessionid', 'sessionid_ss', 'sid_tt'];

const FIRST_PAGE_TIMEOUT_MS = 12000;
const DETAIL_WAIT_MS = 9000;
const SCROLL_WAIT_MS = 1100;
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

/** 带超时的 promise：CDP 命令偶发不返回，绝不能让整条链路卡死 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms)),
  ]);
}

// 同一时刻只保留一个抓包窗口；重复解析时先干掉上一个，避免僵尸窗口堆积
let inflightWindow = null;

function closeInflightWindow() {
  if (!inflightWindow) return;
  try {
    if (!inflightWindow.isDestroyed()) {
      log('[capture] 关闭上一次的解析窗口');
      inflightWindow.destroy();
    }
  } catch (_) {}
  inflightWindow = null;
}

/** 供上层超时兜底调用：立刻结束当前抓取，别让窗口在后台空转 */
function abortInflight(reason) {
  if (!inflightWindow) return false;
  log('[capture] 上层请求中止：' + (reason || '超时'));
  closeInflightWindow();
  return true;
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

/** 清掉页面/接口标题里的站名、书名号、分集后缀等噪音 */
function cleanTitle(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let name = text
    // 只有跟在分隔符后面才算站名后缀，避免「重生之我在抖音」被削掉
    .replace(/[_|·•\-—–\s]+(抖音短剧|抖音小助手|抖音号|抖音)\s*$/i, '')
    .replace(/^(抖音短剧|抖音)[\s:：\-]+/i, '')
    // 接口里常返回「合集 · 剧名」
    .replace(/^合集[\s·•:：\-]+/,'')
    .replace(/[_|·•\-—–\s]+DOU\+?.*$/i, '')
    .replace(/《|》|【|】/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(抖音|douyin|短剧|合集)$/i.test(name)) return '';
  return sanitizeName(name);
}

/** 判断一个名字能不能当合集名（排除「第3集」「12」这类） */
function usableName(raw) {
  const name = cleanTitle(raw);
  if (!name || name.length < 2) return '';
  if (/^第?\s*\d+\s*[集期话回]?$/.test(name)) return '';
  if (/^\d+$/.test(name)) return '';
  return name;
}

function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s"'<>，。]+/i);
  return match ? match[0] : '';
}

/** 从合集页面 URL 里取 mix_id（只认合集形态，单条作品另走视频解析） */
/**
 * 从任意文本（URL / HTML / 内嵌 JSON）里识别合集或作品 ID。
 * 抖音分享页常见三种形态：页面地址、`"mix_id":"123"`、`/video/123`。
 */
function idFromAnyText(text) {
  if (!text) return null;
  const source = String(text);

  // 我的收藏 / 喜欢（需登录），必须放在用户主页之前判断
  if (/showTab=(collection|favorite|like)/i.test(source) || /\/user\/self/i.test(source)) {
    if (/showTab=(collection)/i.test(source)) return { kind: 'favorites', id: 'collection' };
    if (/showTab=(favorite|like)/i.test(source)) return { kind: 'favorites', id: 'favorite' };
    if (/\/user\/self/i.test(source)) return { kind: 'favorites', id: 'collection' };
  }

  // 用户主页：douyin.com/user/<sec_uid>
  const userMatch = source.match(/\/user\/([A-Za-z0-9_\-]{8,})/);
  if (userMatch && userMatch[1] !== 'self') {
    return { kind: 'user', id: userMatch[1] };
  }

  // 抖音短剧（playlet）：分享链接最外层形态，优先识别
  const playletPatterns = [
    /\/share\/playlet\/detail\/(\d{6,})/,
    /\/playlet\/(?:detail\/)?(\d{6,})/,
    /[?&]playlet_id=(\d{6,})/,
    /"playlet_id"\s*:\s*"?(\d{6,})/,
  ];
  for (const pattern of playletPatterns) {
    const match = source.match(pattern);
    if (match) return { kind: 'playlet', id: match[1] };
  }

  const mixPatterns = [
    /\/collection\/(\d{6,})/,
    /\/share\/collection\/(\d{6,})/,
    /[?&]mix_id=(\d{6,})/,
    /"mix_id"\s*:\s*"?(\d{6,})/,
    /[?&]collection_id=(\d{6,})/,
  ];
  for (const pattern of mixPatterns) {
    const match = source.match(pattern);
    if (match) return { kind: 'collection', id: match[1] };
  }

  const videoPatterns = [
    /\/video\/(\d{6,})/,
    /\/share\/video\/(\d{6,})/,
    /[?&]modal_id=(\d{6,})/,
    /[?&]aweme_id=(\d{6,})/,
    /"aweme_id"\s*:\s*"?(\d{6,})/,
  ];
  for (const pattern of videoPatterns) {
    const match = source.match(pattern);
    if (match) return { kind: 'video', id: match[1] };
  }

  return null;
}

/**
 * 纯 HTTP 跟短链：手动逐跳读 Location，并对落地页 HTML 做一次 ID 扫描。
 * 抖音短链有时是 302，有时是返回一段带跳转的 HTML，两种都覆盖。
 */
async function followHttp(url) {
  let current = url;

  for (let hop = 0; hop < 8; hop++) {
    const direct = idFromAnyText(current);
    if (direct) {
      log('[target] http 命中', direct.kind, direct.id, 'via=url hop=' + hop);
      return direct;
    }

    let response;
    try {
      response = await axios.get(current, {
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        maxRedirects: 0,
        timeout: 15000,
        validateStatus: () => true,
        responseType: 'text',
      });
    } catch (error) {
      log('[target] http 第' + hop + '跳失败:', error.message);
      return null;
    }

    const location = response.headers && response.headers.location;
    const body = typeof response.data === 'string' ? response.data : '';
    log(
      '[target] http hop=' + hop,
      'status=' + response.status,
      'location=' + (location ? urlPath(location) : '无'),
      'bodyLen=' + body.length
    );

    if (location) {
      current = /^https?:\/\//i.test(location) ? location : new URL(location, current).toString();
      continue;
    }

    const fromBody = idFromAnyText(body);
    if (fromBody) {
      log('[target] http 命中', fromBody.kind, fromBody.id, 'via=html hop=' + hop);
      return fromBody;
    }
    break;
  }

  return null;
}

/** 最后兜底：用隐藏窗口真实打开一次，让浏览器自己走完跳转 */
async function resolveViaWindow(url, showWindow) {
  const { BrowserWindow } = require('electron');
  closeInflightWindow();
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: !!showWindow,
    title: '抖音链接解析',
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:douyin-parse',
      backgroundThrottling: false,
    },
  });
  hardenWindow(win, 'capture');
  inflightWindow = win;

  try {
    win.webContents.setUserAgent(UA);
    win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) =>
      log('[target] 窗口 did-fail-load', code, desc, urlPath(failedUrl)));
    // loadURL 也可能不返回，10 秒兜底，拿不到就按"无法识别"处理
    try {
      await withTimeout(win.loadURL(url, { userAgent: UA }), 10000, '窗口加载');
    } catch (error) {
      log('[target] 窗口加载失败:', error.message);
    }
    await delay(2500);

    const finalUrl = win.webContents.getURL();
    log('[target] 窗口落地', urlPath(finalUrl));
    let found = idFromAnyText(finalUrl);
    if (found) {
      log('[target] 窗口命中', found.kind, found.id, 'via=url');
      return found;
    }

    let html = '';
    try {
      html = await win.webContents.executeJavaScript('document.documentElement.outerHTML', true);
    } catch (error) {
      log('[target] 读取页面失败:', error.message);
    }
    found = idFromAnyText(html);
    if (found) {
      log('[target] 窗口命中', found.kind, found.id, 'via=html');
      return found;
    }
    try {
      log('[target] 窗口标题=' + JSON.stringify(await win.webContents.getTitle()));
    } catch (_) {}
    return null;
  } catch (error) {
    log('[target] 窗口打开失败:', error.message);
    return null;
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
    if (inflightWindow === win) inflightWindow = null;
  }
}

/**
 * 识别用户输入：合集链接 / 作品链接 / 短链 / 分享文案 / 纯数字 ID。
 * 依次尝试：直接匹配 → HTTP 跟跳转 → 窗口真实打开。
 */
async function resolveCollectionTarget(input, options = {}) {
  const text = String(input || '').trim();
  if (!text) throw new Error('请粘贴抖音合集分享链接或分享文案');

  const url = extractUrl(text);
  if (!url && /^\d{15,}$/.test(text)) {
    log('[target] 纯 ID 视为单作品', text);
    return { kind: 'video', id: text };
  }
  if (!url) throw new Error('没有找到链接，请粘贴完整分享文案或合集地址');

  const direct = idFromAnyText(url);
  if (direct) {
    log('[target] 直接命中', direct.kind, direct.id);
    return direct;
  }

  log('[target] 短链，开始 HTTP 跟随:', urlPath(url));
  const viaHttp = await followHttp(url);
  if (viaHttp) return viaHttp;

  log('[target] HTTP 未识别，改用窗口跟随');
  const viaWindow = await resolveViaWindow(url, options.showWindow);
  if (viaWindow) return viaWindow;

  throw new Error('无法识别该链接指向的合集或作品；可在设置里打开「解析合集时显示窗口」后重试，看实际落地的页面');
}

function pickCover(video, aweme) {
  const cover = (video && video.cover) || (video && video.origin_cover) || {};
  const list = cover.url_list || [];
  const first = list.find((item) => typeof item === 'string' && /^https?:\/\//.test(item));
  if (first) return first;
  const dynamic = (video && video.dynamic_cover && video.dynamic_cover.url_list) || [];
  return dynamic.find((item) => typeof item === 'string' && /^https?:\/\//.test(item)) || '';
}

/** 作品归属的合集信息（抖音把合集挂在 mix_info 上） */
function mixFromAweme(item) {
  const mix = (item && (item.mix_info || item.mixInfo)) || null;
  if (!mix) return null;
  const id = mix.mix_id || mix.mixId;
  if (!id) return null;
  return {
    mix_id: String(id),
    mix_name: String(mix.mix_name || mix.mixName || '').trim(),
  };
}

/**
 * 由 video_id 直接拼无水印播放地址。
 * 短剧条目里通常只有 video.vid，没有 play_addr；这个经典 play 接口实测
 * 返回 206 + video/mp4 + ftyp，不需要签名，也不需要 Cookie。
 */
function playUrlFromVid(vid, ratio = '1080p') {
  const id = String(vid || '').trim();
  if (!id) return '';
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(id)}&ratio=${ratio}&line=0`;
}

/** 深扫任意 JSON 找 mix_info（单条作品自动扩成合集/短剧时用） */
function findMixInTree(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMixInTree(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const direct = mixFromAweme(node);
  if (direct) return direct;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') {
      const found = findMixInTree(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** 挑选无水印直链：bit_rate 高清优先，其次 play_addr，最后 download_addr 去水印；都没有则用 vid 拼 */
function pickVideoUrl(video) {
  const candidates = [];
  const push = (raw) => {
    if (typeof raw === 'string' && /^https?:\/\//.test(raw)) candidates.push(raw);
  };
  // bit_rate 可能是数组，也可能是对象（短剧接口返回对象）
  const rates = video && video.bit_rate;
  const rateList = Array.isArray(rates) ? rates : (rates && typeof rates === 'object' ? Object.values(rates) : []);
  for (const rate of rateList) {
    if (!rate || typeof rate !== 'object') continue;
    const addr = rate.play_addr || rate.playAddr;
    for (const url of (addr && addr.url_list) || []) push(url);
  }
  if (video && video.play_addr) {
    for (const url of video.play_addr.url_list || []) push(url);
  }
  if (video && video.download_addr) {
    for (const url of video.download_addr.url_list || []) push(url);
  }
  if (video && video.play_api) push(video.play_api);
  if (!candidates.length && video && video.vid) {
    const built = playUrlFromVid(video.vid);
    if (built) return built;
  }
  if (!candidates.length) return '';
  const cleaned = candidates.map((url) => url.replace(/\/playwm\//g, '/play/').replace(/playwm/g, 'play'));
  return cleaned.find((url) => url.includes('/play/')) || cleaned[0];
}

/** 单条 aweme -> 统一结构 */
function normalizeAweme(aweme, index) {
  const video = (aweme && aweme.video) || {};
  // 只有「数组且非空」才算图文；短剧接口的 images 是对象，不能据此判成图文
  const images = Array.isArray(aweme && aweme.images) && aweme.images.length ? aweme.images : null;
  const title = String((aweme && (aweme.desc || aweme.item_title || aweme.caption)) || '').trim();
  return {
    aweme_id: String((aweme && (aweme.aweme_id || aweme.item_id)) || ''),
    vid: String((video && video.vid) || ''),
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
 * 从接口 JSON 里找合集/短剧名。
 * 没文案时这是主要的命名来源，所以按字段可信度排序，
 * 泛化的 title/name 只在同层带 ID 字段时才采信，避免误抓 BGM 名、作者昵称。
 */
const NAME_KEYS = [
  'mix_name', 'mixName',
  'playlet_name', 'playletName', 'playlet_title',
  'series_name', 'seriesName', 'series_title',
  'collection_name', 'share_title',
  'title', 'name',
];
const ID_KEYS = ['playlet_id', 'mix_id', 'series_id', 'collection_id', 'id'];
const GENERIC_NAME_KEYS = new Set(['title', 'name']);

function nameFromJson(node, state, depth = 0) {
  if (state.name || !node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (state.name) return;
      nameFromJson(item, state, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') return;

  for (const key of NAME_KEYS) {
    const value = node[key];
    if (typeof value !== 'string') continue;
    if (GENERIC_NAME_KEYS.has(key)) {
      const hasId = ID_KEYS.some((idKey) => node[idKey] !== undefined && node[idKey] !== null && node[idKey] !== '');
      if (!hasId || depth > 4) continue;
    }
    const cleaned = cleanTitle(value);
    if (!cleaned || cleaned.length < 2) continue;
    if (/^第?\s*\d+\s*[集期话回]/.test(cleaned)) continue;
    state.name = cleaned;
    log('[capture] 名称候选 ' + key + ' -> ' + cleaned);
    return;
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') nameFromJson(value, state, depth + 1);
  }
}

const GENERIC_API = /\/aweme\/|\/playlet\/|\/series\/|\/mix\/|\/episode\/|\/user\/|\/collection/;

/**
 * 递归扫描任意 JSON，找出"能下载的视频节点"。
 * 短剧、合集、主页的接口返回结构各不相同（aweme_list / video_list / episode_list …），
 * 用这个兜底而不是逐个接口写解析，接口改名也不会整条链路失效。
 */
function deepCollectMedia(node, out, depth, trail) {
  if (!node || depth > 8 || out.length > 3000) return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      deepCollectMedia(node[i], out, depth + 1, trail + '[' + i + ']');
    }
    return;
  }
  if (typeof node !== 'object') return;

  const video = node.video || null;
  const id = String(
    node.aweme_id || node.awemeId || node.vid || node.video_id || node.item_id || ''
  );
  let url = video ? pickVideoUrl(video) : '';
  if (!url) {
    const raw =
      node.play_url ||
      node.playUrl ||
      node.video_url ||
      node.videoUrl ||
      (node.play_addr && node.play_addr.url_list && node.play_addr.url_list[0]);
    if (typeof raw === 'string' && /^https?:\/\//.test(raw)) {
      url = raw.replace(/\/playwm\//g, '/play/').replace(/playwm/g, 'play');
    }
  }

  if (url && id) {
    const title = String(node.desc || node.title || node.name || node.episode_title || '').trim();
    const cover = video ? pickCover(video, node) : String(node.cover || node.cover_url || '');
    const duration = video && video.duration
      ? Math.round(video.duration / 1000)
      : (Number(node.duration) > 1000 ? Math.round(Number(node.duration) / 1000) : Number(node.duration) || 0);
    out.push({ id, title, cover, duration, url, trail });
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') deepCollectMedia(value, out, depth + 1, trail + '.' + key);
  }
}

function mergeMedia(target, found) {
  if (!found.length) return 0;
  const known = new Set(target.map((item) => item.id));
  let added = 0;
  for (const item of found) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    target.push(item);
    added += 1;
  }
  return added;
}

/** 统一的响应体处理：CDP 与页面内拦截两条通道都走这里 */
function makeIngest(state, onProgress, notify) {
  return (url, body, source) => {
    if (!body || typeof body !== 'string') return;
    let json = null;
    try {
      json = JSON.parse(body);
    } catch (_) {
      return;
    }
    state.bodies += 1;
    nameFromJson(json, state);

    if (Array.isArray(json.aweme_list) && json.aweme_list.length) {
      state.pages.push(json);
      if (json.has_more === false) state.hasMore = false;
      log(
        '[capture] 列表页#' + state.pages.length,
        'list=' + json.aweme_list.length,
        'total=' + countItems(state.pages),
        'has_more=' + json.has_more,
        'cursor=' + json.cursor,
        'via=' + source
      );
      onProgress({ stage: 'page', pages: state.pages.length, found: countItems(state.pages) });
    }

    const found = [];
    deepCollectMedia(json, found, 0, '');
    if (found.length) {
      const added = mergeMedia(state.media, found);
      log(
        '[capture] 媒体节点',
        urlPath(url),
        'found=' + found.length,
        'new=' + added,
        'total=' + state.media.length,
        'via=' + source
      );
      onProgress({ stage: 'page', pages: state.bodies, found: state.media.length });
    }

    if (hasCapture(state)) notify();
  };
}

const HOOK_PRELOAD = path.join(__dirname, 'douyin-hook.js');

/**
 * 解析/登录窗口的统一加固：
 * 禁止弹新窗口，禁止跳到 http(s) 之外的协议（抖音页面里有 bitbrowser:// 之类的
 * 自定义协议，会触发 Windows 的"选择打开方式"弹窗，直接卡住用户）。
 */
function hardenWindow(win, label) {
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch (_) {}
  const blockNonHttp = (event, targetUrl) => {
    if (!targetUrl || /^https?:/i.test(targetUrl) || /^(about|data|blob|devtools):/i.test(targetUrl)) return;
    try { event.preventDefault(); } catch (_) {}
    log('[' + label + '] 已拦截协议跳转 ' + String(targetUrl).slice(0, 60));
  };
  try {
    win.webContents.on('will-navigate', blockNonHttp);
    win.webContents.on('will-redirect', blockNonHttp);
  } catch (_) {}
}

/**
 * 在隐藏窗口里打开页面，用 CDP 抓页面自己发出的签名请求。
 * 合集页命中 mix/aweme 拿列表；短剧页结构不同，靠 deepCollectMedia 从任意接口里捞视频。
 */
async function capturePage(pageUrlOrId, options) {
  const { BrowserWindow } = require('electron');
  const showWindow = options && options.showWindow;
  const paged = options && options.paged !== false;
  const onProgress = (options && options.onProgress) || (() => {});
  const raw = String(pageUrlOrId || '');
  const pageUrl = /^https?:\/\//i.test(raw) ? raw : `https://www.douyin.com/collection/${raw}`;
  const t0 = Date.now();

  closeInflightWindow();

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: !!showWindow,
    title: '抖音合集解析',
    webPreferences: {
      // 沙箱 preload + 关闭隔离：能在页面世界拦截 fetch/XHR，但页面拿不到 Node 能力
      sandbox: true,
      contextIsolation: false,
      nodeIntegration: false,
      preload: HOOK_PRELOAD,
      // 固定分区：cookie 与静态资源缓存跨次解析复用，第二次起明显更快
      partition: 'persist:douyin-parse',
      // 隐藏窗口默认会被节流（定时器/渲染降速），抖音这类 SPA 会因此迟迟不发请求
      backgroundThrottling: false,
    },
  });
  hardenWindow(win, 'capture');
  inflightWindow = win;

  const state = { pages: [], hasMore: true, bodies: 0, seen: 0, media: [], name: '', xhrs: 0 };
  let attached = false;
  let polling = true;

  // 事件驱动的"首批数据到达"等待：轮询会有 400ms 抖动，这里一有数据立刻醒
  let wake = null;
  const notify = () => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };
  const waitCapture = (ms) => new Promise((resolve) => {
    if (hasCapture(state)) return resolve(true);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      wake = null;
      resolve(false);
    }, ms);
    wake = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
  });

  log('[capture] open', pageUrl, 'showWindow=' + !!showWindow + ' paged=' + paged);
  onProgress({ stage: 'window', pages: 0, found: 0 });

  try {
    win.webContents.setUserAgent(UA);
    win.webContents.on('did-finish-load', () => log('[capture] did-finish-load'));
    win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) =>
      log('[capture] did-fail-load', code, desc, urlPath(failedUrl)));
    win.webContents.on('render-process-gone', (_e, details) =>
      log('[capture] render-process-gone', JSON.stringify(details || {})));

    const ingest = makeIngest(state, onProgress, notify);

    // ===== 通道 1：页面内拦截（preload 注入），最稳定 =====
    const pollHook = async () => {
      while (polling) {
        try {
          const items = await win.webContents.executeJavaScript(
            '(() => { const a = window.__dyData || []; window.__dyData = []; return a; })()',
            true
          );
          if (Array.isArray(items) && items.length) {
            for (const item of items) ingest(item.url, item.body, 'hook');
          }
        } catch (_) {}
        await delay(400);
      }
    };

    // ===== 通道 2：CDP（仅日志 + 兜底；body 必须等 loadingFinished） =====
    const debuggerApi = win.webContents.debugger;
    try {
      debuggerApi.attach('1.3');
      attached = true;
      log('[capture] CDP attached');
      const pending = new Map();
      debuggerApi.on('message', async (_event, method, params) => {
        if (method === 'Network.responseReceived') {
          const url = params && params.response && params.response.url;
          if (!url) return;
          const status = params.response.status;
          const kind = params.type;
          if ((kind === 'XHR' || kind === 'Fetch') && state.xhrs < 60) {
            state.xhrs += 1;
            log('[capture] xhr', status, kind, urlPath(url));
          }
          if (GENERIC_API.test(url) && state.seen < 80) {
            state.seen += 1;
            log('[capture] resp', status, urlPath(url));
          }
          if (PAGE_API.test(url) || GENERIC_API.test(url)) pending.set(params.requestId, url);
          return;
        }
        if (method === 'Network.loadingFailed') {
          pending.delete(params.requestId);
          return;
        }
        if (method !== 'Network.loadingFinished') return;
        const url = pending.get(params.requestId);
        if (!url) return;
        pending.delete(params.requestId);
        try {
          const { body } = await withTimeout(
            debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId }),
            4000,
            'getResponseBody'
          );
          ingest(url, body, 'cdp');
        } catch (error) {
          log('[capture] body-fail', urlPath(url), error.message);
        }
      });
      // 关键：不 await Network.enable。
      // 以往这里一卡住，后面连 loadURL 都执行不到（日志停在 CDP attached），
      // 表现为界面永远"正在打开抖音页面"。现在先导航，enable 用超时兜住。
      withTimeout(debuggerApi.sendCommand('Network.enable'), 3000, 'Network.enable')
        .then(() => log('[capture] Network.enable 完成'))
        .catch((error) => log('[capture] Network.enable 异常:', error.message));
    } catch (error) {
      log('[capture] CDP 不可用:', error.message);
      console.warn('[Douyin] CDP 不可用，改用页面内拦截:', error.message);
    }

    // 不再等整页 load 完才看数据：抖音首页子资源多，整页 load 常要 2-4 秒，
    // 而接口往往 1 秒内就返回了。这里并发等待，谁先到谁先用。
    log('[capture] 开始导航');
    const loadPromise = win.loadURL(pageUrl, { userAgent: UA }).then(() => {
      log('[perf] loadURL 完成 ' + (Date.now() - t0) + 'ms');
    }).catch((error) => {
      log('[capture] loadURL 失败:', error.message);
    });
    pollHook();

    const gotFirst = await waitCapture(FIRST_PAGE_TIMEOUT_MS);
    log('[perf] 首批数据 ' + (Date.now() - t0) + 'ms got=' + gotFirst + ' xhr=' + state.xhrs);

    // 滚动需要 DOM 就绪，但最多再等 6 秒，不能无限等
    await Promise.race([loadPromise, delay(6000)]);
    log('[perf] 页面就绪 ' + (Date.now() - t0) + 'ms');
    let pageTitle = '';
    try {
      pageTitle = String((await win.webContents.getTitle()) || '').trim();
      log('[capture] title=' + JSON.stringify(pageTitle));
    } catch (_) {}
    onProgress({ stage: 'loaded', pages: state.bodies, found: mediaCount(state) });

    if (!hasCapture(state)) {
      // 页面到底有没有跑起来：看 readyState / 地址 / 有没有发出接口
      try {
        const diag = await win.webContents.executeJavaScript(`(() => ({
          ready: document.readyState,
          href: location.href,
          text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
        }))()`, true);
        log(
          '[capture] 首屏超时，未捕获到任何作品 xhr=' + state.xhrs +
          ' ready=' + (diag && diag.ready) +
          ' href=' + urlPath(diag && diag.href) +
          ' text=' + JSON.stringify((diag && diag.text) || '')
        );
      } catch (error) {
        log('[capture] 首屏超时，未捕获到任何作品 xhr=' + state.xhrs + '（诊断读取失败: ' + error.message + '）');
      }
    }

    if (!paged) {
      // 短剧页一次就把全集返回，没有分页，滚动纯属浪费：
      // 只留一小段静默期，等并行发出的其它接口落地即可
      await delay(700);
      onProgress({ stage: 'scroll', pages: state.bodies, found: mediaCount(state) });
    } else {
      let lastCount = -1;
      let stable = 0;
      let emptyRounds = 0;
      for (let i = 0; i < MAX_SCROLLS; i++) {
        // 兜底预算：整段抓取不超过 40 秒，避免界面已经超时了窗口还在滚
        if (Date.now() - t0 > 40000) {
          log('[capture] 抓取超过 40 秒，提前结束');
          break;
        }
        const count = mediaCount(state);
        if (count === lastCount) stable += 1;
        else stable = 0;
        if (!hasCapture(state)) {
          emptyRounds += 1;
          if (emptyRounds >= 5) {
            log('[capture] 连续 5 轮没有任何数据，停止滚动');
            break;
          }
        }
        if (hasCapture(state) && (!state.hasMore || stable >= 2)) break;
        lastCount = count;
        try {
          await win.webContents.executeJavaScript(
            'window.scrollTo(0, document.body.scrollHeight); document.body.scrollHeight;',
            true
          );
        } catch (_) {}
        // 抖音列表多是内部滚动容器，window.scrollTo 不一定生效，补一次真实滚轮事件
        if (attached) {
          try {
            await withTimeout(
              win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
                type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 1500, pointerType: 'mouse',
              }),
              2000,
              'wheel'
            );
          } catch (_) {}
        }
        await delay(SCROLL_WAIT_MS);
        onProgress({ stage: 'scroll', pages: state.bodies, found: mediaCount(state) });
      }
    }
    log(
      '[capture] 抓取结束 total=' + mediaCount(state) +
      ' pages=' + state.pages.length +
      ' bodies=' + state.bodies +
      ' hasMore=' + state.hasMore
    );
    log('[perf] 抓取结束 ' + (Date.now() - t0) + 'ms');

    let mixName = '';
    let author = '';
    for (const page of state.pages) {
      const info = page.mix_info || page.collection_info;
      if (!mixName && info && info.mix_name) mixName = info.mix_name;
      if (!author && info && info.author && info.author.nickname) author = info.author.nickname;
    }
    // 主页作品没有 mix_info，作者名从第一条作品的 author 上取
    if (!author) {
      for (const page of state.pages) {
        const first = (page.aweme_list || [])[0];
        if (first && first.author && first.author.nickname) {
          author = String(first.author.nickname).trim();
          break;
        }
      }
    }

    if (!hasCapture(state)) {
      const domIds = await scrapeDomIds(win);
      log('[capture] DOM 兜底 id 数=' + domIds.length);
      if (domIds.length) {
        return { pages: state.pages, domIds, media: state.media, mixName, author, pageTitle, detectedName: state.name };
      }
    }

    return { pages: state.pages, domIds: [], media: state.media, mixName, author, pageTitle, detectedName: state.name };
  } finally {
    polling = false;
    try {
      if (attached) win.webContents.debugger.detach();
    } catch (_) {}
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
    if (inflightWindow === win) inflightWindow = null;
  }
}

function countItems(pages) {
  let total = 0;
  for (const page of pages) total += (page.aweme_list || []).length;
  return total;
}

/** 已抓到的作品总数：列表接口优先，其次通用媒体节点 */
function mediaCount(state) {
  const fromPages = countItems(state.pages);
  return fromPages > 0 ? fromPages : state.media.length;
}

function hasCapture(state) {
  return countItems(state.pages) > 0 || state.media.length > 0;
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
      log('[detail] loaderData keys=' + Object.keys(loader).join('|').slice(0, 200));

      for (const key of Object.keys(loader)) {
        const res = loader[key] && loader[key].videoInfoRes;
        const itemList = res && res.item_list;
        if (!Array.isArray(itemList) || !itemList.length) {
          log('[detail] ' + key + ' 无 item_list');
          continue;
        }
        const item = itemList[0];
        const url = pickVideoUrl(item.video || {});
        log('[detail] item_list=' + itemList.length + ' playUrl=' + (url ? urlPath(url) : '空') + ' vid=' + ((item.video && item.video.vid) || '(无)'));
        if (url) {
          const mix = mixFromAweme(item);
          if (mix) log('[detail] 归属合集 ' + mix.mix_id + ' 「' + mix.mix_name + '」');
          return {
            url,
            referer: REFERER,
            title: String(item.desc || '').trim(),
            cover: pickCover(item.video || {}, item),
            duration: item.video && item.video.duration ? Math.round(item.video.duration / 1000) : 0,
            type: Array.isArray(item.images) && item.images.length ? 'images' : 'video',
            mix,
          };
        }
      }

      // 结构变了也不怕：对整棵 _ROUTER_DATA 做通用媒体扫描
      const found = [];
      deepCollectMedia(router, found, 0, '');
      log('[detail] _ROUTER_DATA 通用扫描节点数=' + found.length + (found[0] ? ' trail=' + found[0].trail : ''));
      if (found.length) {
        const best = found[0];
        return {
          url: best.url,
          referer: REFERER,
          title: best.title || '',
          cover: best.cover || '',
          duration: best.duration || 0,
          type: 'video',
          mix: findMixInTree(router),
        };
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

/** 兜底：打开作品页，用页面内拦截（辅以 CDP）抓 aweme/detail 响应 */
async function resolveByCapture(awemeId) {
  const { BrowserWindow } = require('electron');
  closeInflightWindow();
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: false,
      nodeIntegration: false,
      preload: HOOK_PRELOAD,
      partition: 'persist:douyin-parse',
      backgroundThrottling: false,
    },
  });
  hardenWindow(win, 'capture');
  inflightWindow = win;
  let attached = false;
  let polling = true;
  let result = null;
  const state = { xhrs: 0 };

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
      const kind = params.type;
      if ((kind === 'XHR' || kind === 'Fetch') && state.xhrs < 40) {
        state.xhrs += 1;
        log('[detail] xhr', params.response.status, kind, urlPath(url));
      }
      if (/\/aweme\//.test(url)) log('[detail] resp', params.response.status, urlPath(url));
      if (!DETAIL_API.test(url)) return;
      try {
        const { body } = await debuggerApi.sendCommand('Network.getResponseBody', {
          requestId: params.requestId,
        });
        log('[detail] hit', urlPath(url), 'bodyLen=' + (body ? body.length : 0));
        const json = JSON.parse(body);
        const list = json.aweme_list || json.aweme_details || (json.aweme_detail ? [json.aweme_detail] : []);
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
          mix: mixFromAweme(item),
        };
        if (result.mix) log('[detail] 归属合集 ' + result.mix.mix_id + ' 「' + result.mix.mix_name + '」');
      } catch (error) {
        log('[detail] body-fail', urlPath(url), error.message);
      }
    });
    // 同样不能 await Network.enable：一旦不返回，后面 loadURL 都执行不到（单条作品卡死的原因）
    withTimeout(debuggerApi.sendCommand('Network.enable'), 3000, 'Network.enable')
      .then(() => log('[detail] Network.enable 完成'))
      .catch((error) => log('[detail] Network.enable 异常:', error.message));

    // 页面内拦截通道：CDP 取 body 在抖音大页面上几乎必失败，这里才是主通道
    const consumeHookBody = (url, body) => {
      if (result || !body) return;
      let json = null;
      try { json = JSON.parse(body); } catch (_) { return; }
      const list = json.aweme_list || json.aweme_details || (json.aweme_detail ? [json.aweme_detail] : []);
      const item = Array.isArray(list) ? list[0] : null;
      if (item) {
        const playUrl = pickVideoUrl(item.video || {});
        if (playUrl) {
          result = {
            url: playUrl,
            referer: REFERER,
            title: String(item.desc || '').trim(),
            cover: pickCover(item.video || {}, item),
            duration: item.video && item.video.duration ? Math.round(item.video.duration / 1000) : 0,
            type: 'video',
            mix: mixFromAweme(item),
          };
          log('[detail] hook 命中 ' + urlPath(url) + (result.mix ? ' 归属合集 ' + result.mix.mix_id : ''));
          return;
        }
      }
      const found = [];
      deepCollectMedia(json, found, 0, '');
      if (found.length) {
        result = {
          url: found[0].url,
          referer: REFERER,
          title: found[0].title || '',
          cover: found[0].cover || '',
          duration: found[0].duration || 0,
          type: 'video',
          mix: findMixInTree(json),
        };
        log('[detail] hook 通用扫描命中 ' + urlPath(url) + ' trail=' + found[0].trail);
      }
    };

    const pollHook = async () => {
      while (polling && !result) {
        try {
          const items = await win.webContents.executeJavaScript(
            '(() => { const a = window.__dyData || []; window.__dyData = []; return a; })()',
            true
          );
          if (Array.isArray(items)) {
            for (const item of items) consumeHookBody(item.url, item.body);
          }
        } catch (_) {}
        await delay(400);
      }
    };

    // 分享页轻、Web 页稳：依次尝试，谁先出结果用谁
    const entries = [
      `https://www.iesdouyin.com/share/video/${awemeId}/`,
      `https://www.douyin.com/video/${awemeId}`,
    ];
    pollHook();
    for (let i = 0; i < entries.length; i++) {
      if (result) break;
      const entry = entries[i];
      log('[detail] 入口 ' + (i + 1) + '/' + entries.length + ' ' + urlPath(entry));
      win.loadURL(entry, { userAgent: UA })
        .then(() => log('[detail] loadURL 完成 ' + urlPath(entry)))
        .catch((error) => log('[detail] loadURL 失败:', error.message));
      const startedAt = Date.now();
      while (Date.now() - startedAt < DETAIL_WAIT_MS && !result) {
        await delay(300);
      }
      log('[perf] 入口' + (i + 1) + ' 等待结束 ' + (Date.now() - startedAt) + 'ms got=' + !!result + ' xhr=' + state.xhrs);
    }

    try {
      log('[detail] title=' + JSON.stringify((await win.webContents.getTitle()) || ''));
    } catch (_) {}
    if (!result) throw new Error('未获取到无水印直链（可能触发风控，可在设置里打开「解析合集时显示窗口」后重试）');
    return result;
  } finally {
    polling = false;
    try {
      if (attached) win.webContents.debugger.detach();
    } catch (_) {}
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) {}
    if (inflightWindow === win) inflightWindow = null;
  }
}

/** 抓包结果 -> 作品列表（列表接口优先，其次通用媒体节点，最后 DOM 逐条补解析） */
async function itemsFromCapture(captured, onProgress) {
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

  // 短剧等页面不走 aweme_list，用通用扫描结果
  if (!items.length && (captured.media || []).length) {
    for (const media of captured.media) {
      if (!media.url || !media.id || seen.has(media.id)) continue;
      seen.add(media.id);
      items.push({
        aweme_id: media.id,
        index: items.length + 1,
        title: media.title || `第 ${items.length + 1} 集`,
        cover: media.cover || '',
        duration: media.duration || 0,
        url: media.url,
        type: 'video',
        music: '',
      });
    }
    log('[capture] 用通用媒体节点组装 ' + items.length + ' 条');
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

  // play_url 一并带给下载端：首次下载直接用，省一次解析
  return items.map((item) => ({ ...item, play_url: item.url || '' }));
}

const PLAYLET_PAGE_SIZE = 10;
const PLAYLET_MAX_PAGES = 60;

/**
 * 短剧走纯 HTTP：/web/api/playlet/detail 拿名字与总集数，
 * /web/api/playlet/item/list 按 cursor 翻页拿全部条目（每条带 video.vid）。
 * 这条路不开窗口，1 秒级完成，也不受渲染/风控影响。
 */
async function fetchPlaylet(playletId, onProgress) {
  const id = String(playletId);
  const headers = {
    'User-Agent': MOBILE_UA,
    Referer: `https://www.iesdouyin.com/share/playlet/detail/${id}/`,
    Accept: 'application/json, text/plain, */*',
  };

  let name = '';
  let author = '';
  let total = 0;
  try {
    const detail = await withTimeout(
      axios.get(`https://www.iesdouyin.com/web/api/playlet/detail/?playlet_id=${id}`, {
        headers, timeout: 15000, responseType: 'json',
      }),
      15000,
      'playlet detail'
    );
    const info = (detail.data && detail.data.playlet_info) || {};
    name = usableName(info.playlet_name) || usableName(info.title);
    author = String((info.author && (info.author.nickname || info.author.unique_id)) || '').trim();
    total = Number(info.total_episode) || 0;
    log('[playlet] detail name=' + JSON.stringify(name) + ' total=' + total + ' author=' + JSON.stringify(author));
  } catch (error) {
    log('[playlet] detail 失败:', error.message);
  }

  const items = [];
  const seen = new Set();
  let cursor = 0;

  for (let page = 0; page < PLAYLET_MAX_PAGES; page++) {
    let data = null;
    try {
      const res = await withTimeout(
        axios.get(
          `https://www.iesdouyin.com/web/api/playlet/item/list/?playlet_id=${id}&count=${PLAYLET_PAGE_SIZE}&cursor=${cursor}`,
          { headers, timeout: 15000, responseType: 'json' }
        ),
        15000,
        'playlet list'
      );
      data = res.data || {};
    } catch (error) {
      log('[playlet] 第' + (page + 1) + '页请求失败:', error.message);
      break;
    }

    const list = Array.isArray(data.aweme_list) ? data.aweme_list : [];
    let added = 0;
    for (const aweme of list) {
      const item = normalizeAweme(aweme, items.length + 1);
      if (!item.aweme_id || seen.has(item.aweme_id)) continue;
      seen.add(item.aweme_id);
      items.push(item);
      added += 1;
      if (!name) name = usableName(aweme && aweme.playlet_info && aweme.playlet_info.playlet_name);
    }

    log(
      '[playlet] 第' + (page + 1) + '页 list=' + list.length +
      ' new=' + added + ' total=' + items.length +
      ' has_more=' + data.has_more + ' cursor=' + data.cursor
    );
    onProgress({ stage: 'page', pages: page + 1, found: items.length });

    if (!list.length || data.has_more === false) break;
    const next = Number(data.cursor);
    if (!Number.isFinite(next) || next === cursor) break;
    cursor = next;
  }

  if (!items.length) return null;
  return {
    items: items.map((item) => ({ ...item, play_url: item.url || '' })),
    name,
    author,
    total: total || items.length,
  };
}

// ===== 登录态 =====
function parseSession() {
  const { session } = require('electron');
  return session.fromPartition('persist:douyin-parse');
}

/** 是否已登录（看抖音的关键 Cookie） */
async function loginStatus() {
  try {
    const ses = parseSession();
    const cookies = await ses.cookies.get({ domain: '.douyin.com' });
    const hit = cookies.find((item) => LOGIN_COOKIE_NAMES.includes(item.name) && item.value);
    const nickname = (cookies.find((item) => item.name === 'nickname') || {}).value || '';
    log('[login] cookie 数=' + cookies.length + ' 已登录=' + !!hit);
    return {
      loggedIn: !!hit,
      cookies: cookies.length,
      nickname: nickname ? decodeURIComponent(nickname) : '',
    };
  } catch (error) {
    log('[login] 状态检查失败:', error.message);
    return { loggedIn: false, cookies: 0, nickname: '', error: error.message };
  }
}

/** 打开可见的抖音窗口让用户扫码登录；登录态由持久分区保存 */
async function openLoginWindow() {
  const { BrowserWindow } = require('electron');
  // 登录窗口独立使用，不登记为 inflightWindow：否则解析一开始就会把它关掉
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: true,
    title: '抖音登录（登录后可关闭此窗口）',
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:douyin-parse',
      backgroundThrottling: false,
    },
  });
  win.on('closed', () => log('[login] 登录窗口已关闭'));
  hardenWindow(win, 'login');
  win.webContents.setUserAgent(UA);
  win.loadURL('https://www.douyin.com/', { userAgent: UA })
    .then(() => log('[login] 登录页已加载'))
    .catch((error) => log('[login] 登录页加载失败:', error.message));
  log('[login] 已打开登录窗口');
  return { success: true };
}

function collectionResult(mixId, mixName, author, items, extra = {}) {
  const usableCount = items.filter((item) => item.type === 'video' && item.url).length;
  return {
    mix_id: String(mixId),
    mix_name: mixName,
    author: author || '',
    total: items.length,
    videos: usableCount,
    images: items.filter((item) => item.type !== 'video').length,
    items,
    ...extra,
  };
}

/**
 * 解析入口。三种输入都走同一条流水线：
 *   合集页 → 打开合集页抓 mix/aweme
 *   短剧页 → 打开短剧分享页，用通用扫描捞各集
 *   单作品 → 先取详情，若属于合集/短剧则顺势解析整部
 */
async function resolveCollection(input, options = {}) {
  resetLogIfLarge();
  const tStart = Date.now();
  const finish = (result) => {
    log('[perf] 解析总耗时 ' + (Date.now() - tStart) + 'ms');
    return result;
  };
  log('===== 开始解析 =====');
  log('[input]', JSON.stringify(String(input || '').slice(0, 200)));

  const onProgress = options.onProgress || (() => {});
  const target = await resolveCollectionTarget(input, { showWindow: options.showWindow });
  log('[target] kind=' + target.kind + ' id=' + target.id);

  // 分享文案里常带【剧名】，比 合集<id> 友好得多
  const bracketMatch = String(input || '').match(/[【\[]([^】\]]{2,40})[】\]]/);
  const titleHint = bracketMatch ? usableName(bracketMatch[1]) : '';
  if (titleHint) log('[input] 文案标题=' + titleHint);

  onProgress({ stage: 'opening', pages: 0, found: 0 });

  const readPage = async (pageUrls, keyId, hintName, paged) => {
    const urls = Array.isArray(pageUrls) ? pageUrls : [pageUrls];
    let lastError = null;

    for (let i = 0; i < urls.length; i++) {
      const pageUrl = urls[i];
      try {
        log('[result] 尝试入口 ' + (i + 1) + '/' + urls.length + ' ' + urlPath(pageUrl));
        if (i > 0) onProgress({ stage: 'retry', attempt: i + 1, total: urls.length, pages: 0, found: 0 });
        const captured = await capturePage(pageUrl, {
          showWindow: options.showWindow,
          paged,
          onProgress,
        });
        const items = await itemsFromCapture(captured, onProgress);
        if (!items.length) {
          log('[result] 该入口没有数据：' + urlPath(pageUrl));
          continue;
        }
        const keyText = String(keyId);
        const fallbackName = keyText.startsWith('fav-')
          ? (keyText === 'fav-favorite' ? '我的喜欢' : '我的收藏')
          : (/^\d+$/.test(keyText)
            ? `合集${keyText.slice(-6)}`
            : (usableName(captured.author) ? `${usableName(captured.author)} 的作品` : `主页${keyText.slice(-6)}`));
        const mixName = usableName(captured.mixName)
          || usableName(captured.detectedName)
          || usableName(hintName)
          || usableName(titleHint)
          || usableName(captured.pageTitle)
          || fallbackName;
        const result = collectionResult(keyId, mixName, captured.author, items);
        log(
          '[result] 成功 name=' + JSON.stringify(mixName),
          'total=' + result.total,
          'videos=' + result.videos,
          'images=' + result.images,
          'entry=' + urlPath(pageUrl),
          'source=' + (captured.pages.length ? 'cdp-list' : (captured.media.length ? 'cdp-media' : 'dom'))
        );
        return result;
      } catch (error) {
        lastError = error;
        log('[result] 入口失败 ' + urlPath(pageUrl) + '：' + error.message);
      }
    }

    throw lastError || new Error('未能解析出作品列表；若页面要求验证，请到设置里打开「解析合集时显示窗口」后重试');
  };

  if (target.kind === 'collection') {
    return finish(await readPage([`https://www.douyin.com/collection/${target.id}`], target.id, '', true));
  }

  if (target.kind === 'user') {
    log('[result] 用户主页：' + target.id);
    return finish(await readPage([`https://www.douyin.com/user/${target.id}`], target.id, '', true));
  }

  if (target.kind === 'favorites') {
    const status = await loginStatus();
    if (!status.loggedIn) {
      throw new Error('收藏/喜欢需要先登录：请到 设置 → 抖音 → 打开登录窗口，扫码登录后再试');
    }
    const tab = target.id === 'favorite' ? 'favorite' : 'collection';
    log('[result] 我的' + (tab === 'favorite' ? '喜欢' : '收藏') + '（已登录）');
    return finish(await readPage([
      `https://www.douyin.com/user/self?showTab=${tab}`,
    ], `fav-${tab}`, '', true));
  }

  if (target.kind === 'playlet') {
    // 短剧优先走纯 HTTP：快、稳、不开窗口
    log('[result] 短剧：尝试 HTTP 接口');
    try {
      const playlet = await fetchPlaylet(target.id, onProgress);
      if (playlet) {
        const mixName = usableName(playlet.name) || usableName(titleHint) || `短剧${target.id.slice(-6)}`;
        const result = collectionResult(target.id, mixName, playlet.author, playlet.items);
        log(
          '[result] 成功 name=' + JSON.stringify(mixName),
          'total=' + result.total,
          'videos=' + result.videos,
          'entry=http-playlet'
        );
        return finish(result);
      }
      log('[result] HTTP 短剧接口无数据，退回窗口抓取');
    } catch (error) {
      log('[result] HTTP 短剧接口异常：' + error.message + '，退回窗口抓取');
    }
    // 兜底：分享页（无分页）→ Web 合集页
    return finish(await readPage([
      `https://www.iesdouyin.com/share/playlet/detail/${target.id}/`,
      `https://www.douyin.com/collection/${target.id}`,
    ], target.id, '', false));
  }

  // 单条作品：先取详情，若属于合集则顺势解析整部
  const info = await resolvePlayUrl(target.id);
  if (info.mix && info.mix.mix_id) {
    log('[result] 作品属于合集 ' + info.mix.mix_id + ' 「' + (info.mix.mix_name || '') + '」，改为解析整部');
    return finish(await readPage([`https://www.douyin.com/collection/${info.mix.mix_id}`], info.mix.mix_id, info.mix.mix_name, true));
  }

  log('[result] 单作品（无归属合集）');
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
    play_url: info.url || '',
  };
  return finish(collectionResult(target.id, title, '', [item], { single: true }));
}

module.exports = {
  UA,
  REFERER,
  PLAY_REFERER,
  sanitizeName,
  cleanTitle,
  playUrlFromVid,
  loginStatus,
  openLoginWindow,
  abortInflight,
  resolveCollection,
  resolvePlayUrl,
  resolveCollectionTarget,
  log,
  logPath,
};
