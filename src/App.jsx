import React, { useState, useEffect } from 'react';
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

  const renderPage = () => {
    switch (page) {
      case 'browse':
        return <Browse onNavigate={setPage} />;
      case 'player':
        return <Player target={playerTarget} onNavigate={setPage} />;
      case 'manager':
        return <DownloadManager onNavigate={setPage} />;
      case 'settings':
        return <SettingsPage />;
      case 'download':
        return <HongguoDownload onNavigate={setPage} />;
      case 'douyin':
        return <DouyinDownload onNavigate={setPage} />;
      default:
        return <HongguoDownload onNavigate={setPage} />;
    }
  };

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
          <div className="footer-note">QQ交流群：1109483648</div>
        </div>
      </div>

      {/* 右侧主体区域 */}
      <div className="main-wrapper">
        <div className="main-content">{renderPage()}</div>
      </div>
    </div>
  );
}
