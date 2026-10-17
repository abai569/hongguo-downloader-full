import React, { useCallback, useEffect, useRef, useState } from 'react';
import './LanShare.css';
import { Share2, Copy, RefreshCw, Play, Folder, AlertCircle } from './icons';

/**
 * 局域网共享（电视播放）独立页面。
 * 原来塞在设置页里，剧一多就很臃肿，这里单独一页。
 */
function LanShare({ onNavigate, active }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ running: false, m3u: '', txt: '', web: '', count: 0 });
  const [groups, setGroups] = useState([]);
  const [copiedKey, setCopiedKey] = useState('');
  const [error, setError] = useState('');
  const timerRef = useRef(null);

  const loadAll = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || !api.lanShareStatus) return;
    try {
      const settings = await api.getSettings();
      setEnabled(!!(settings && settings.lan_share_enabled));
    } catch (_) {}
    try {
      const res = await api.lanShareStatus();
      if (res) {
        setStatus({
          running: !!res.running,
          m3u: res.m3u || '',
          txt: res.txt || '',
          web: res.web || '',
          count: res.count || 0,
        });
      }
    } catch (_) {}
    try {
      const g = await api.lanShareGroups();
      if (g && g.success) setGroups(g.groups || []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // 页面保活，切回来要重新拉一次；共享运行时每 8 秒刷新一次统计
  useEffect(() => {
    if (!active) return undefined;
    loadAll();
    return undefined;
  }, [active, loadAll]);

  useEffect(() => {
    if (!status.running) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return undefined;
    }
    timerRef.current = setInterval(() => { loadAll(); }, 8000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [status.running, loadAll]);

  const toggle = async (next) => {
    const api = window.electronAPI;
    if (!api || !api.lanShareStart) return;
    setBusy(true);
    setError('');
    try {
      const res = next ? await api.lanShareStart() : await api.lanShareStop();
      if (res && res.success) {
        setEnabled(next);
        const saved = await api.getSettings();
        await api.saveSettings({ ...saved, lan_share_enabled: next });
        await loadAll();
      } else {
        setError((res && res.error) || '启动失败，端口可能被占用');
        await loadAll();
      }
    } catch (err) {
      setError(err.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };

  const copyTo = async (text, key) => {
    if (!text) return;
    try {
      const res = await window.electronAPI.copyText(text);
      if (res && res.success) {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(''), 1800);
      }
    } catch (_) {}
  };

  const setMergedOnly = async (name, on) => {
    try {
      const res = await window.electronAPI.lanShareSetMergedOnly(name, on);
      if (res && res.success) {
        setGroups(res.groups || []);
        await loadAll();
      }
    } catch (_) {}
  };

  const copyLabel = (key, text) => (copiedKey === key ? '已复制' : text);

  return (
    <div className="lan-container">
      <div className="hongguo-hero">
        <div className="hero-icon">
          <Share2 size={32} />
        </div>
        <div className="hero-text">
          <h2>局域网共享（电视播放）</h2>
          <p>电脑上跑一个本地 HTTP 服务，电视/手机在同一个 Wi-Fi 下就能播放已下载的视频；支持按剧分组与整部连播。</p>
        </div>
      </div>

      <div className="hongguo-card">
        <div className="lan-switch-row">
          <label className="proxy-switch-row" style={{ margin: 0, flex: 1 }}>
            <input type="checkbox" checked={enabled || status.running} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
            <span className="proxy-switch-text">
              开启局域网共享
              <em>开启后本机监听 0.0.0.0:8899，仅局域网内可访问；关掉即停止服务</em>
            </span>
          </label>
          <span className={`lan-state ${status.running ? 'is-on' : ''}`}>
            {status.running ? `运行中 · 共 ${status.count} 个视频` : '未开启'}
          </span>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginTop: 12 }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        {status.running && (
          <div className="lan-addr-list">
            <div className="lan-addr-row">
              <span className="lan-addr-label">播放列表（m3u）</span>
              <code className="lan-addr">{status.m3u}</code>
              <button className="btn btn-outline btn-sm" onClick={() => copyTo(status.m3u, 'm3u')}>
                <Copy size={14} /> {copyLabel('m3u', '复制')}
              </button>
            </div>
            <div className="lan-addr-row">
              <span className="lan-addr-label">播放列表（txt）</span>
              <code className="lan-addr">{status.txt}</code>
              <button className="btn btn-outline btn-sm" onClick={() => copyTo(status.txt, 'txt')}>
                <Copy size={14} /> {copyLabel('txt', '复制')}
              </button>
            </div>
            <div className="lan-addr-row">
              <span className="lan-addr-label">目录页（浏览器）</span>
              <code className="lan-addr">{status.web}</code>
              <button className="btn btn-outline btn-sm" onClick={() => copyTo(status.web, 'web')}>
                <Copy size={14} /> {copyLabel('web', '复制')}
              </button>
            </div>
            <p className="settings-hint" style={{ marginTop: 8 }}>
              电视端：OK影视 / FongMi → 设置 → <b>直播</b> → 直播源，填 m3u 地址（不要填到「点播配置」）。
              播放列表每次请求都是实时生成的；电视端若看不到新剧集，在直播页菜单里<b>刷新节目源</b>。
            </p>
            <p className="settings-hint">
              首次开启若 Windows 弹出防火墙提示，请勾选「专用网络」允许，否则电视连不上。
            </p>
          </div>
        )}
      </div>

      <div className="hongguo-card">
        <div className="card-header-title">
          <Folder size={18} />
          <span>按剧控制（共 {groups.length} 部）</span>
          <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} onClick={loadAll}>
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
        <p className="settings-hint">
          勾上「只显示整部」后，该剧在播放列表里只保留「▶ 整部连播」（需先在下载管理里合并整部）。
          还没更新完的剧建议不勾，否则电视上就看不到新集了。
        </p>

        {groups.length === 0 ? (
          <div className="lan-empty">还没有可共享的视频，先下载几部吧</div>
        ) : (
          <div className="lan-group-list">
            {groups.map((g) => (
              <label key={g.name} className={`lan-group-row ${g.hasMerged ? '' : 'is-disabled'}`}>
                <input
                  type="checkbox"
                  checked={!!g.mergedOnly}
                  disabled={!g.hasMerged}
                  onChange={(e) => setMergedOnly(g.name, e.target.checked)}
                />
                <span className="lan-group-name" title={g.name}>{g.name}</span>
                <span className="lan-group-meta">
                  {g.hasMerged ? (
                    <span className="lan-merged-tag">
                      <Play size={11} /> 已合并
                    </span>
                  ) : (
                    <span className="lan-plain-tag">未合并</span>
                  )}
                  {g.episodes} 集{g.merged > 0 ? ` · ${g.merged} 个整部` : ''}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default LanShare;
