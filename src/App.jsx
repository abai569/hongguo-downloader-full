import React, { useState, useEffect, useRef } from 'react';
import { Film, Download, Settings, Play, Sparkles, Music } from './components/icons';
import HongguoDownload from './components/HongguoDownload';
import DouyinDownload from './components/DouyinDownload';
import DownloadManager from './components/DownloadManager';
import SettingsPage from './components/Settings';
import Player from './components/Player';
import Browse from './components/Browse';

const MENU = [
  { id: 'browse', label: '浏览', icon: Sparkles },
  { id: 'player', label: '播放', icon: Play },
  { id: 'download', label: '红果下载', icon: Film },
  { id: 'douyin', label: '抖音下载', icon: Music },
  { id: 'manager', label: '下载管理', icon: Download },
  { id: 'settings', label: '设置', icon: Settings },
];

export default function App() {
  const [page, setPage] = useState('browse');
  const [appInfo, setAppInfo] = useState(null); // { version, brand, appName }
  const [playerTarget, setPlayerTarget] = useState(null); // 浏览页点播 -> 播放页选中
  const [copied, setCopied] = useState(false); // 页脚群号「已复制」反馈

  // 点击页脚群号 -> 复制到系统剪贴板，2 秒后恢复原文案
  const handleCopyGroup = async () => {
    const group = '1109483648';
    let ok = false;
    try {
      if (window.electronAPI && window.electronAPI.copyText) {
        const res = await window.electronAPI.copyText(group);
        ok = !!(res && res.success);
      }
    } catch (_) {}
    if (!ok) {
      // 兜底：浏览器剪贴板 / 临时 textarea
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(group);
          ok = true;
        }
      } catch (_) {}
    }
    if (!ok) {
      try {
        const el = document.createElement('textarea');
        el.value = group;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand('copy');
        document.body.removeChild(el);
      } catch (_) {}
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    window.electronAPI.getAppInfo().then((info) => {
      setAppInfo(info);
    });
  }, []);

  // 主进程发来的导航指令（例如浏览页点「立即播放」）
  useEffect(() => {
    if (!window.electronAPI.onNavigate) return undefined;
    return window.electronAPI.onNavigate((data) => {
      if (!data || !data.page) return;
      if (data.payload) setPlayerTarget({ ...data.payload, ts: Date.now() });
      setPage(data.page);
    });
  }, []);

  // 页面保活：切走的页面只隐藏、不卸载。
  // 否则离开「抖音下载」再回来，解析结果全丢，得重新解析一遍（很慢）。
  // 播放页例外：离开即卸载，避免后台继续出声。
  const [visited, setVisited] = useState(() => new Set([page]));
  const contentRef = useRef(null);
  const scrollMap = useRef({});
  const prevPageRef = useRef(page);

  useEffect(() => {
    setVisited((prev) => (prev.has(page) ? prev : new Set(prev).add(page)));
    const el = contentRef.current;
    if (!el) return;
    // 每个页面记住自己的滚动位置，切回来时还原
    if (prevPageRef.current !== page) {
      scrollMap.current[prevPageRef.current] = el.scrollTop;
      el.scrollTop = scrollMap.current[page] || 0;
      prevPageRef.current = page;
    }
  }, [page]);

  const PAGES = [
    { id: 'browse', node: <Browse onNavigate={setPage} /> },
    { id: 'download', node: <HongguoDownload onNavigate={setPage} /> },
    { id: 'douyin', node: <DouyinDownload onNavigate={setPage} /> },
    { id: 'manager', node: <DownloadManager onNavigate={setPage} /> },
    { id: 'settings', node: <SettingsPage /> },
  ];

  return (
    <div className="app-layout">
      {/* 左侧边栏 */}
      <div className="sidebar">
        <div className="sidebar-brand">
          <div className="logo">
            <Film size={18} />
          </div>
          <div>
            <div className="brand-text">
              {appInfo ? appInfo.brand : '果抖下载器'}
              <span className="brand-ver">v{appInfo ? appInfo.version : ''}</span>
            </div>
          </div>
        </div>

        <div className="sidebar-menu">
          {MENU.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                className={`sidebar-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </div>
            );
          })}
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className={`footer-note footer-copy ${copied ? 'is-copied' : ''}`}
            onClick={handleCopyGroup}
            title="点击复制 QQ 群号"
          >
            {copied ? '已复制：1109483648' : 'QQ交流群：1109483648'}
          </button>
        </div>
      </div>

      {/* 右侧主体区域 */}
      <div className="main-wrapper">
        <div className="main-content" ref={contentRef}>
          {PAGES.map(({ id, node }) => (
            visited.has(id) ? (
              <div key={id} className="page-slot" style={{ display: page === id ? 'block' : 'none' }}>
                {node}
              </div>
            ) : null
          ))}
          {page === 'player' && (
            <div className="page-slot">
              <Player target={playerTarget} onNavigate={setPage} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
