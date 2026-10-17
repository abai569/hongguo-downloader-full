import React, { useState, useEffect } from 'react';
import './Settings.css';
import { Settings, Folder, Check, Globe, X, RefreshCw, AlertCircle, ExternalLink } from './icons';


const FORMAT_PRESETS = [
  { label: '剧名_第N集', value: '剧名 集数' },
  { label: '剧名_第N集_标题', value: '剧名 集数 标题' },
  { label: '仅剧名', value: '剧名' },
];

const PROXY_MODES = [
  { value: 'system', label: '跟随系统', desc: '使用系统 / 环境变量里已有的代理设置' },
  { value: 'custom', label: '手动指定', desc: '自己填写代理地址与端口（支持 HTTP/HTTPS 代理）' },
  { value: 'direct', label: '强制直连', desc: '忽略一切代理，直接连接' },
];

// 常见代理软件默认端口，方便一键填入
const PORT_PRESETS = [
  { label: 'Clash / Mihomo', port: 7890 },
  { label: 'V2rayN', port: 10809 },
  { label: 'Shadowsocks', port: 1080 },
  { label: 'Burp / 抓包', port: 8080 },
];

/** 已保存设置 -> 当前生效的代理描述 */
function describeProxy(settings) {
  if (!settings || settings.proxy_enabled !== true) {
    return { on: false, text: '未启用（所有请求直连）' };
  }
  const mode = settings.proxy_mode || 'system';
  if (mode === 'direct') {
    return { on: false, text: '已开启但模式为「强制直连」' };
  }
  if (mode === 'custom') {
    const host = (settings.proxy_host || '').trim();
    const port = (settings.proxy_port || '').toString().trim();
    if (!host) return { on: false, text: '已开启，但未填写代理地址' };
    return { on: true, text: `${host}${port ? ':' + port : ''}` };
  }
  return { on: true, text: '跟随系统 / 环境变量代理' };
}

function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(false);
  const [proxyOpen, setProxyOpen] = useState(false);
  const [proxyDraft, setProxyDraft] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings);
  }, []);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const selectFolder = async () => {
    const dir = await window.electronAPI.selectFolder();
    if (dir) update('root', dir);
  };

  const save = async () => {
    const res = await window.electronAPI.saveSettings(settings);
    if (res && res.success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  // ===== 代理弹窗 =====
  const openProxyModal = () => {
    setProxyDraft({
      proxy_enabled: settings.proxy_enabled === true,
      proxy_mode: settings.proxy_mode || 'system',
      proxy_host: settings.proxy_host || '127.0.0.1',
      proxy_port: settings.proxy_port || 7890,
      proxy_username: settings.proxy_username || '',
      proxy_password: settings.proxy_password || '',
    });
    setTestResult(null);
    setProxyOpen(true);
  };

  const patchDraft = (key, value) => {
    setProxyDraft((prev) => ({ ...prev, [key]: value }));
    setTestResult(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await window.electronAPI.testProxy(proxyDraft);
      setTestResult(res);
    } catch (e) {
      setTestResult({ success: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const applyProxy = async () => {
    const next = { ...settings, ...proxyDraft };
    const res = await window.electronAPI.saveSettings(next);
    if (res && res.success) {
      setSettings(next);
      setProxyOpen(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!settings) {
    return <div className="settings-container">加载中...</div>;
  }

  const proxyInfo = describeProxy(settings);
  const mode = proxyDraft ? proxyDraft.proxy_mode : 'system';

  return (
    <div className="settings-container">
      <div className="settings-header">
        <Settings size={22} />
        <h2>设置</h2>
      </div>

      <div className="settings-card">
        <div className="settings-group">
          <label className="settings-label">下载目录</label>
          <div className="folder-row">
            <input
              type="text"
              className="input-field"
              value={settings.root || ''}
              onChange={(e) => update('root', e.target.value)}
              placeholder="选择下载保存目录"
            />
            <button className="btn btn-outline" onClick={selectFolder}>
              <Folder size={16} />
              选择文件夹
            </button>
          </div>
          <p className="settings-hint">文件将保存到 <code>下载目录/红果短剧/剧名/</code> 下</p>
        </div>

        <div className="settings-group">
          <label className="settings-label">文件命名规则</label>
          <div className="preset-row">
            {FORMAT_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn-chip ${settings.name_format === p.value ? 'btn-chip-primary' : ''}`}
                onClick={() => update('name_format', p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="input-field mt8"
            value={settings.name_format || ''}
            onChange={(e) => update('name_format', e.target.value)}
          />
          <p className="settings-hint">
            可用变量：<code>剧名</code>（series_title）· <code>集数</code>（vid_index，如 001）· <code>标题</code>（ep_title）
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">最大并发下载数</label>
          <select
            className="input-field select-field"
            value={settings.max_concurrent || 3}
            onChange={(e) => update('max_concurrent', parseInt(e.target.value, 10))}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>{n} 个同时下载</option>
            ))}
          </select>
          <p className="settings-hint">
            同时下载 <b>{settings.max_concurrent || 3}</b> 集（保存后立即生效）。
            并发越高越快，但可能触发接口限流，建议 3~5。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">窗口与后台</label>
          <label className="proxy-switch-row">
            <input
              type="checkbox"
              checked={settings.close_to_tray !== false}
              onChange={(e) => update('close_to_tray', e.target.checked)}
            />
            <span className="proxy-switch-text">
              关闭窗口时隐藏到托盘（默认开启）
              <em>开启：点 X 隐藏到托盘，下载继续；关闭：点 X 退出程序（有下载任务时会弹确认框）</em>
            </span>
          </label>
          <p className="settings-hint">
            托盘图标在任务栏右下角通知区域，若没看到请点「显示隐藏的图标」。保存后立即生效。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-label">抖音</label>
          <label className="proxy-switch-row">
            <input
              type="checkbox"
              checked={settings.douyin_parse_window === true}
              onChange={(e) => update('douyin_parse_window', e.target.checked)}
            />
            <span className="proxy-switch-text">
              解析合集时显示窗口
              <em>默认隐藏。遇到风控验证页时打开，可手动完成验证后再解析</em>
            </span>
          </label>
          <p className="settings-hint">
            合集解析会在后台打开抖音页面并抓取接口，通常 3–8 秒；缓存与 Cookie 会跨次复用。保存后立即生效。
          </p>
          <div className="proxy-status-row">
            <button
              className="btn btn-outline btn-sm"
              onClick={async () => {
                const res = await window.electronAPI.openDouyinLog();
                if (res && !res.success) window.alert(res.error || '打开日志失败');
              }}
              title="解析失败时把该文件发给开发者，可快速定位问题"
            >
              <ExternalLink size={14} />
              打开解析日志
            </button>
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">网络代理</label>
          <div className="proxy-status-row">
            <span className={`proxy-dot ${proxyInfo.on ? 'proxy-dot-on' : 'proxy-dot-off'}`} />
            <span className="proxy-status-text">
              {proxyInfo.on ? <>已启用：<code>{proxyInfo.text}</code></> : proxyInfo.text}
            </span>
            <button className="btn btn-outline btn-sm" onClick={openProxyModal}>
              <Globe size={15} />
              配置代理
            </button>
          </div>
          <p className="settings-hint">
            本机有代理（Clash / V2rayN 等）时在这里填上，解析剧集与下载视频都会走该代理。保存后立即生效，无需重启。
          </p>
        </div>

        <div className="settings-footer">
          <button className="btn btn-primary" onClick={save}>
            {saved ? <><Check size={16} /> 已保存</> : '保存设置'}
          </button>
        </div>
      </div>

      {proxyOpen && proxyDraft && (
        <div className="proxy-modal-mask" onClick={() => setProxyOpen(false)}>
          <div className="proxy-modal" onClick={(e) => e.stopPropagation()}>
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <Globe size={18} />
                <span>网络代理设置</span>
              </div>
              <button className="icon-btn" title="关闭" onClick={() => setProxyOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="proxy-modal-body">
              <label className="proxy-switch-row">
                <input
                  type="checkbox"
                  checked={proxyDraft.proxy_enabled}
                  onChange={(e) => patchDraft('proxy_enabled', e.target.checked)}
                />
                <span className="proxy-switch-text">
                  启用代理
                  <em>关闭时代理不生效，所有请求直连</em>
                </span>
              </label>

              <div className={`proxy-fields ${proxyDraft.proxy_enabled ? '' : 'proxy-fields-disabled'}`}>
                <div className="settings-group">
                  <label className="settings-label">代理模式</label>
                  <div className="proxy-mode-list">
                    {PROXY_MODES.map((m) => (
                      <label
                        key={m.value}
                        className={`proxy-mode-item ${mode === m.value ? 'active' : ''}`}
                      >
                        <input
                          type="radio"
                          name="proxy_mode"
                          value={m.value}
                          checked={mode === m.value}
                          disabled={!proxyDraft.proxy_enabled}
                          onChange={() => patchDraft('proxy_mode', m.value)}
                        />
                        <span className="proxy-mode-body">
                          <b>{m.label}</b>
                          <em>{m.desc}</em>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">代理地址</label>
                    <div className="proxy-host-row">
                      <input
                        type="text"
                        className="input-field"
                        placeholder="127.0.0.1"
                        value={proxyDraft.proxy_host}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_host', e.target.value)}
                      />
                      <span className="proxy-colon">:</span>
                      <input
                        type="number"
                        className="input-field proxy-port"
                        placeholder="7890"
                        min="1"
                        max="65535"
                        value={proxyDraft.proxy_port}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_port', e.target.value)}
                      />
                    </div>
                    <div className="preset-row mt8">
                      {PORT_PRESETS.map((p) => (
                        <button
                          key={p.port}
                          type="button"
                          className="btn-chip"
                          disabled={!proxyDraft.proxy_enabled}
                          onClick={() => patchDraft('proxy_port', p.port)}
                        >
                          {p.label} {p.port}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {mode === 'custom' && (
                  <div className="settings-group">
                    <label className="settings-label">代理认证（可选）</label>
                    <div className="proxy-auth-row">
                      <input
                        type="text"
                        className="input-field"
                        placeholder="用户名"
                        autoComplete="off"
                        value={proxyDraft.proxy_username}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_username', e.target.value)}
                      />
                      <input
                        type="password"
                        className="input-field"
                        placeholder="密码"
                        autoComplete="new-password"
                        value={proxyDraft.proxy_password}
                        disabled={!proxyDraft.proxy_enabled}
                        onChange={(e) => patchDraft('proxy_password', e.target.value)}
                      />
                    </div>
                    <p className="settings-hint">代理无需认证时留空即可</p>
                  </div>
                )}
              </div>

              {testResult && (
                <div className={`proxy-test-result ${testResult.success ? 'ok' : 'fail'}`}>
                  {testResult.success ? <Check size={15} /> : <AlertCircle size={15} />}
                  <span>
                    {testResult.success ? testResult.message : testResult.error}
                    {testResult.success && testResult.via ? ` · 经由 ${testResult.via}` : ''}
                  </span>
                </div>
              )}
            </div>

            <div className="proxy-modal-foot">
              <button className="btn btn-outline" onClick={runTest} disabled={testing}>
                <RefreshCw size={15} />
                {testing ? '测试中...' : '测试连接'}
              </button>
              <div className="proxy-foot-right">
                <button className="btn btn-outline" onClick={() => setProxyOpen(false)}>取消</button>
                <button className="btn btn-primary" onClick={applyProxy}>
                  <Check size={15} />
                  保存并生效
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export default SettingsPage;
