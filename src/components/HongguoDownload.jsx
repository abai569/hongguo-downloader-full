import React, { useState } from 'react';
import './HongguoDownload.css';
import { Film, Download, CheckSquare, Square, RefreshCw, Folder, Sparkles, Search } from './icons';
import SearchPanel from './SearchPanel';


function HongguoDownload({ onNavigate }) {
  const [tab, setTab] = useState('search'); // 'search' | 'input'
  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // 短剧解析结果
  const [seriesData, setSeriesData] = useState(null); // { series_id, series_title, cover, total, episodes: [...] }
  const [selectedVids, setSelectedVids] = useState(new Set());
  const [rangeInput, setRangeInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 滚动容器是 .main-content（不是 window），切到解析界面后要滚回顶部
  const scrollToTop = () => {
    const el = document.querySelector('.main-content');
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 搜索选中一部剧后：复用既有的选集下载界面
  const handleSeriesFromSearch = (data) => {
    setErrorMsg('');
    setTab('input');
    setSeriesData(data);
    setSelectedVids(new Set(data.episodes.map((ep) => ep.vid)));
    setSuccessMsg(`已选中《${data.series_title}》共 ${data.total} 集，可直接提交下载`);
    scrollToTop();
  };

  // 解析红果短剧
  const handleResolve = async () => {
    if (!inputUrl.trim()) {
      setErrorMsg('请输入红果短剧分享链接或 series_id');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    setSeriesData(null);
    setSelectedVids(new Set());

    try {
      const res = await window.electronAPI.hongguoResolve(inputUrl.trim());
      if (res.success && res.data) {
        setSeriesData(res.data);
        // 默认全选
        const allVids = new Set(res.data.episodes.map((ep) => ep.vid));
        setSelectedVids(allVids);
        setSuccessMsg(`解析成功！找到《${res.data.series_title}》共 ${res.data.total} 集`);
      } else {
        setErrorMsg(res.error || '解析失败，请检查链接或网络');
      }
    } catch (err) {
      setErrorMsg('解析过程出现错误: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  // 勾选/取消勾选单集
  const toggleVid = (vid) => {
    const next = new Set(selectedVids);
    if (next.has(vid)) {
      next.delete(vid);
    } else {
      next.add(vid);
    }
    setSelectedVids(next);
  };

  // 全选
  const handleSelectAll = () => {
    if (!seriesData) return;
    setSelectedVids(new Set(seriesData.episodes.map((ep) => ep.vid)));
  };

  // 反选
  const handleInvertSelect = () => {
    if (!seriesData) return;
    const next = new Set();
    for (const ep of seriesData.episodes) {
      if (!selectedVids.has(ep.vid)) {
        next.add(ep.vid);
      }
    }
    setSelectedVids(next);
  };

  // 清空选择
  const handleDeselectAll = () => {
    setSelectedVids(new Set());
  };

  // 快捷集数选择
  const handleQuickSelect = (type) => {
    if (!seriesData || !seriesData.episodes) return;
    const eps = seriesData.episodes;
    const total = eps.length;
    let targetEps = [];
    if (type === 'first10') {
      targetEps = eps.slice(0, 10);
    } else if (type === 'first30') {
      targetEps = eps.slice(0, 30);
    } else if (type === 'last30') {
      targetEps = eps.slice(Math.max(0, total - 30));
    }
    setSelectedVids(new Set(targetEps.map((ep) => ep.vid)));
  };

  // 根据区间字符串应用筛选 (如 "1-30" 或 "1,5,10-20")
  const handleApplyRange = () => {
    if (!seriesData || !seriesData.episodes || !rangeInput.trim()) return;
    const total = seriesData.episodes.length;
    const nums = new Set();
    const parts = rangeInput.split(',');
    for (let part of parts) {
      part = part.trim();
      if (part.includes('-')) {
        const [a, b] = part.split('-').map((n) => parseInt(n.trim(), 10));
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (i >= 1 && i <= total) nums.add(i);
          }
        }
      } else {
        const n = parseInt(part, 10);
        if (!isNaN(n) && n >= 1 && n <= total) nums.add(n);
      }
    }
    const selectedEps = seriesData.episodes.filter((ep) => nums.has(ep.vid_index));
    setSelectedVids(new Set(selectedEps.map((ep) => ep.vid)));
  };

  // 提交批量下载
  const handleBatchDownload = async () => {
    if (!seriesData || selectedVids.size === 0) {
      setErrorMsg('请至少勾选一集欲下载的短剧');
      return;
    }
    setSubmitting(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const selectedEps = seriesData.episodes.filter((ep) => selectedVids.has(ep.vid));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: seriesData.series_id,
        seriesTitle: seriesData.series_title,
        episodes: selectedEps,
      });
      if (res.success) {
        setSuccessMsg(`已提交 ${res.count} 集，可在「下载管理」查看实时进度。`);
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
      {/* 头部 Banner 区 */}
      <div className="hongguo-hero">
        <div className="hero-icon">
          <Film size={32} />
        </div>
        <div className="hero-text">
          <h2>红果短剧批量下载</h2>
          <p>支持粘贴红果短剧 App 分享链接或剧集 ID，突破 AES-128 CENC 原生加密，无水印全集高清下载。</p>
        </div>
      </div>

      {/* 方式切换 */}
      <div className="mode-tabs">
        <button
          className={`mode-tab ${tab === 'search' ? 'active' : ''}`}
          onClick={() => setTab('search')}
        >
          <Search size={16} />
          <span>搜索剧集</span>
        </button>
        <button
          className={`mode-tab ${tab === 'input' ? 'active' : ''}`}
          onClick={() => setTab('input')}
        >
          <Sparkles size={16} />
          <span>粘贴链接 / ID</span>
        </button>
      </div>

      {/* 两个面板都保持挂载，只切换显示：
          否则「搜索剧集」里搜到的结果会在切到「粘贴链接/ID」后被卸载丢掉，
          回来还得重新搜一次 */}
      <div style={{ display: tab === 'search' ? 'block' : 'none' }}>
        <SearchPanel
          onSelectSeries={handleSeriesFromSearch}
          onSwitchToInput={() => setTab('input')}
        />
      </div>

      <div style={{ display: tab === 'input' ? 'block' : 'none' }}>
        {/* 解析输入卡片 */}
        <div className="hongguo-card">
          <div className="card-header-title">
            <Sparkles size={18} />
            <span>输入短剧链接或 ID</span>
          </div>
          <div className="input-group">
            <input
              type="text"
              className="input-field"
              placeholder="例如: https://novelquickapp.com/s/WGPClz6sw10/ 或 7664958856774044697"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleResolve()}
            />
            <button className="btn btn-primary" onClick={handleResolve} disabled={loading}>
              {loading ? (
                <>
                  <RefreshCw size={16} className="spin" />
                  <span>解析中...</span>
                </>
              ) : (
                <>
                  <Film size={16} />
                  <span>解析剧集</span>
                </>
              )}
            </button>
          </div>

          {/* 已选中剧集时，提示统一放到下面按钮那行的下一行，避免上下重复 */}
          {!seriesData && errorMsg && <div className="alert alert-error">{errorMsg}</div>}
          {!seriesData && successMsg && <div className="alert alert-success">{successMsg}</div>}
        </div>
      </div>

      {/* 搜索模式下的提示信息（解析卡片被隐藏了，这里单独显示） */}
      {!seriesData && tab === 'search' && (errorMsg || successMsg) && (
        <div className="hongguo-card" style={{ marginTop: 0 }}>
          {errorMsg && <div className="alert alert-error">{errorMsg}</div>}
          {successMsg && <div className="alert alert-success">{successMsg}</div>}
        </div>
      )}

      {/* 剧集列表与选择控制 */}
      {seriesData && (
        <div className="hongguo-card episode-section">
          {/* 短剧元信息 */}
          <div className="series-header">
            <div className="series-info">
              {seriesData.cover ? (
                <img src={seriesData.cover} alt={seriesData.series_title} className="series-cover" />
              ) : (
                <div className="series-cover-placeholder">
                  <Film size={28} />
                </div>
              )}
              <div className="series-meta">
                <h3 className="series-title">《{seriesData.series_title}》</h3>
                <div className="series-tags">
                  <span className="badge">总集数: {seriesData.total} 集</span>
                  <span className="badge badge-secondary">series_id: {seriesData.series_id}</span>
                  <span className="badge badge-success">AES-128 原生自动解密</span>
                </div>
              </div>
            </div>

            <div className="batch-action-bar">
              <button
                className="btn btn-primary"
                onClick={handleBatchDownload}
                disabled={submitting || selectedVids.size === 0}
              >
                <Download size={16} />
                <span>下载选中集数 ({selectedVids.size}/{seriesData.total})</span>
              </button>
              {onNavigate && (
                <button className="btn btn-outline" onClick={() => onNavigate('manager')}>
                  <Folder size={16} />
                  <span>查看下载管理</span>
                </button>
              )}
            </div>

            {/* 提示放到按钮下一行 */}
            {(successMsg || errorMsg) && (
              <div className="batch-status">
                {successMsg && <span className="batch-status-ok">{successMsg}</span>}
                {errorMsg && <span className="batch-status-err">{errorMsg}</span>}
              </div>
            )}
          </div>

          {/* 筛选与操作栏 */}
          <div className="controls-row">
            <div className="select-buttons">
              <button className="btn-chip" onClick={handleSelectAll}>全选</button>
              <button className="btn-chip" onClick={handleInvertSelect}>反选</button>
              <button className="btn-chip" onClick={handleDeselectAll}>取消全选</button>
              <span className="divider"></span>
              <button className="btn-chip" onClick={() => handleQuickSelect('first10')}>前 10 集</button>
              <button className="btn-chip" onClick={() => handleQuickSelect('first30')}>前 30 集</button>
              <button className="btn-chip" onClick={() => handleQuickSelect('last30')}>后 30 集</button>
            </div>

            <div className="range-filter">
              <span className="range-label">范围筛选:</span>
              <input
                type="text"
                className="range-input"
                placeholder="如 1-30 或 1,5,10"
                value={rangeInput}
                onChange={(e) => setRangeInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleApplyRange()}
              />
              <button className="btn-chip btn-chip-primary" onClick={handleApplyRange}>应用</button>
            </div>
          </div>

          {/* 剧集网格列表 */}
          <div className="episode-grid">
            {seriesData.episodes.map((ep) => {
              const isChecked = selectedVids.has(ep.vid);
              return (
                <div
                  key={ep.vid}
                  className={`episode-card ${isChecked ? 'selected' : ''}`}
                  onClick={() => toggleVid(ep.vid)}
                >
                  <div className="checkbox-icon">
                    {isChecked ? <CheckSquare size={18} className="icon-checked" /> : <Square size={18} className="icon-unchecked" />}
                  </div>
                  <div className="episode-info">
                    <span className="episode-num">第 {String(ep.vid_index).padStart(2, '0')} 集</span>
                    {ep.title && <span className="episode-title">{ep.title}</span>}
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

export default HongguoDownload;
