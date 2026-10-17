import React, { useEffect, useMemo, useState } from 'react';
import './DouyinDownload.css';
import { Music, Download, CheckSquare, Square, RefreshCw, Folder, Link2, Image as ImageIcon, Film } from './icons';

const STAGE_TEXT = {
  opening: '正在打开合集页…',
  page: (p) => `已读取 ${p.pages || 0} 页，发现 ${p.found || 0} 个作品`,
  scroll: (p) => `已发现 ${p.found || 0} 个作品，正在加载更多…`,
  detail: (p) => `正在补全直链 ${p.found || 0} 个…`,
};

function progressText(progress) {
  if (!progress) return '';
  const builder = STAGE_TEXT[progress.stage];
  if (!builder) return '';
  return typeof builder === 'function' ? builder(progress) : builder;
}

function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function DouyinDownload({ onNavigate }) {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [collection, setCollection] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api || !api.onDouyinParseProgress) return undefined;
    return api.onDouyinParseProgress((data) => setProgress(data));
  }, []);

  const videoItems = useMemo(
    () => (collection ? collection.items.filter((item) => item.type === 'video' && item.url) : []),
    [collection]
  );

  const handleResolve = async () => {
    if (!input.trim()) {
      setErrorMsg('请粘贴抖音合集分享链接或分享文案');
      return;
    }
    setLoading(true);
    setProgress(null);
    setErrorMsg('');
    setSuccessMsg('');
    setCollection(null);
    setSelected(new Set());
    try {
      const res = await window.electronAPI.douyinResolveCollection(input.trim());
      if (res.success && res.data) {
        setCollection(res.data);
        const usable = res.data.items.filter((item) => item.type === 'video' && item.url);
        setSelected(new Set(usable.map((item) => item.aweme_id)));
        const skipped = res.data.items.length - usable.length;
        setSuccessMsg(
          `解析成功：已获取 ${usable.length} 个视频` +
            (skipped > 0 ? `，${skipped} 个图文作品已跳过` : '')
        );
      } else {
        setErrorMsg(res.error || '解析失败，请检查链接或网络');
      }
    } catch (err) {
      setErrorMsg('解析过程出现错误: ' + err.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(videoItems.map((item) => item.aweme_id)));
  const selectNone = () => setSelected(new Set());
  const invert = () => {
    const next = new Set();
    for (const item of videoItems) if (!selected.has(item.aweme_id)) next.add(item.aweme_id);
    setSelected(next);
  };

  const handleDownload = async () => {
    if (!collection || selected.size === 0) {
      setErrorMsg('请至少勾选一个作品');
      return;
    }
    setSubmitting(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const items = collection.items.filter((item) => selected.has(item.aweme_id));
      const res = await window.electronAPI.douyinDownloadCollection({
        mixId: collection.mix_id,
        mixName: collection.mix_name,
        author: collection.author,
        items,
      });
      if (res.success) {
        setSuccessMsg(`已提交 ${res.count} 个作品到下载队列，可在「下载管理」查看进度，下载完成后可一键合并。`);
      } else {
        setErrorMsg(res.error || '提交下载失败');
      }
    } catch (err) {
      setErrorMsg('提交下载异常: ' + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="hongguo-container">
      <div className="hongguo-hero">
        <div className="hero-icon">
          <Music size={32} />
        </div>
        <div className="hero-text">
          <h2>抖音合集批量下载</h2>
          <p>粘贴抖音合集分享链接或分享文案，自动枚举全部作品并无水印下载，支持一键合并成整部。</p>
        </div>
      </div>

      <div className="hongguo-card">
        <div className="card-header-title">
          <Link2 size={18} />
          <span>粘贴合集链接 / 分享文案</span>
        </div>
        <textarea
          className="dy-input"
          rows={3}
          placeholder={'例如：3.28 复制打开抖音，看看【某某的作品】合集 https://v.douyin.com/xxxxxx/'}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) handleResolve();
          }}
        />
        <div className="dy-input-actions">
          <span className="dy-hint">解析需要后台渲染页面，通常 3–8 秒；同一作者/合集再次解析会更快</span>
          <button className="btn btn-primary" onClick={handleResolve} disabled={loading}>
            {loading ? (
              <>
                <RefreshCw size={16} className="spin" />
                <span>解析中…</span>
              </>
            ) : (
              <>
                <Music size={16} />
                <span>解析合集</span>
              </>
            )}
          </button>
        </div>
        {loading && progressText(progress) && (
          <div className="dy-progress-hint">{progressText(progress)}</div>
        )}
        {errorMsg && (
          <div className="alert alert-error dy-alert">
            <span>{errorMsg}</span>
            <button
              className="dy-log-btn"
              onClick={() => window.electronAPI.openDouyinLog && window.electronAPI.openDouyinLog()}
              title="把日志文件内容发给开发者，可快速定位失败原因"
            >
              打开解析日志
            </button>
          </div>
        )}
        {successMsg && <div className="alert alert-success">{successMsg}</div>}
      </div>

      {collection && (
        <div className="hongguo-card episode-section">
          <div className="series-header">
            <div className="series-info">
              <div className="series-cover-placeholder">
                <Music size={28} />
              </div>
              <div className="series-meta">
                <h3 className="series-title">{collection.mix_name}</h3>
                <div className="series-tags">
                  {collection.author && <span className="badge">作者: {collection.author}</span>}
                  <span className="badge">共 {collection.total} 个作品</span>
                  <span className="badge badge-secondary">视频 {collection.videos}</span>
                  {collection.images > 0 && (
                    <span className="badge badge-secondary">图文 {collection.images} 个（跳过）</span>
                  )}
                  <span className="badge badge-success">无水印直链</span>
                </div>
              </div>
            </div>

            <div className="batch-action-bar">
              <button
                className="btn btn-primary"
                onClick={handleDownload}
                disabled={submitting || selected.size === 0}
              >
                <Download size={16} />
                <span>下载选中作品 ({selected.size}/{videoItems.length})</span>
              </button>
              {onNavigate && (
                <button className="btn btn-outline" onClick={() => onNavigate('manager')}>
                  <Folder size={16} />
                  <span>查看下载管理</span>
                </button>
              )}
            </div>
          </div>

          <div className="controls-row">
            <div className="select-buttons">
              <button className="btn-chip" onClick={selectAll}>全选</button>
              <button className="btn-chip" onClick={invert}>反选</button>
              <button className="btn-chip" onClick={selectNone}>取消全选</button>
            </div>
            <span className="dy-hint">下载完成后到「下载管理」选择本合集可一键合并</span>
          </div>

          <div className="dy-grid">
            {collection.items.map((item) => {
              const usable = item.type === 'video' && item.url;
              const checked = selected.has(item.aweme_id);
              return (
                <div
                  key={item.aweme_id}
                  className={`dy-card ${checked ? 'selected' : ''} ${usable ? '' : 'disabled'}`}
                  onClick={() => usable && toggle(item.aweme_id)}
                  title={usable ? item.title : '图文作品暂不支持下载'}
                >
                  <div className="dy-thumb">
                    {item.cover ? (
                      <img src={item.cover} alt="" loading="lazy" />
                    ) : (
                      <div className="dy-thumb-empty">
                        <Film size={22} />
                      </div>
                    )}
                    {item.duration > 0 && <span className="dy-duration">{fmtDuration(item.duration)}</span>}
                    {!usable && (
                      <span className="dy-badge-images">
                        <ImageIcon size={12} />
                        图文
                      </span>
                    )}
                  </div>
                  <div className="dy-meta">
                    <div className="checkbox-icon">
                      {checked ? (
                        <CheckSquare size={16} className="icon-checked" />
                      ) : (
                        <Square size={16} className="icon-unchecked" />
                      )}
                    </div>
                    <span className="dy-index">{String(item.index).padStart(2, '0')}</span>
                    <span className="dy-title">{item.title}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default DouyinDownload;
