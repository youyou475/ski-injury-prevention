/* ============================================================
 * progress.js — 统一积分与学习档案系统
 *
 * 四个学习模块共享同一套积分与档案：
 *   视频学习（video）  —— 完成节点 / 安全决策 / 篇章通关
 *   知识测试（quiz）   —— 前测 / 后测 / 正确率 / 提升幅度
 *   3D 实验室（lab）   —— 模块探索 / 损伤触发 / 演示播放
 *   全景滑雪场（slope）—— 站点完成 / 全程通关
 *
 * 特性：
 *   - award(key, ...) 幂等发分（同一 key 只发一次，重玩不刷分）
 *   - 等级称号体系 + 首页模块卡片进度渲染
 *   - 积分 Toast 通知
 *   - 学习档案（统一时间线 + 分模块统计 + CSV 导出 + 重置）
 *   - localStorage 持久化；自动迁移旧版数据（ski_injury_prevention_v2）
 * ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'ski_injury_progress_v1';
  var OLD_KEY = 'ski_injury_prevention_v2';

  /* ---------- 等级体系（按当前内容最大可得约 600 分校准） ---------- */
  var LEVELS = [
    { min: 0, name: '雪场访客', icon: '🎫', desc: '刚刚踏上雪道，安全第一课开始' },
    { min: 80, name: '冰雪新手', icon: '⛷', desc: '已经了解基本装备与热身要点' },
    { min: 200, name: '滑雪爱好者', icon: '🎿', desc: '掌握滑行技术，能做出安全决策' },
    { min: 350, name: '安全先锋', icon: '🛡️', desc: '通晓四类损伤机理与预防方法' },
    { min: 500, name: '雪线守护者', icon: '🏔️', desc: '全部模块通关，滑雪安全知识满点' }
  ];

  var MODULE_META = {
    video: { name: '视频学习', icon: '🎬', color: 'var(--ice)' },
    quiz: { name: '知识测试', icon: '📝', color: 'var(--safe)' },
    lab: { name: '损伤实验室', icon: '🔬', color: 'var(--warn)' },
    slope: { name: '全景滑雪场', icon: '🏔️', color: '#b39ddb' }
  };

  /* ---------- 状态 ---------- */
  var S = {
    points: 0,
    modules: { video: 0, quiz: 0, lab: 0, slope: 0 },
    awarded: {},          // key -> true（幂等发分记录）
    log: [],              // [{module, label, points, at}] 最新在前
    video: { done: {}, decisions: [] },
    quiz: { pre: null, post: null },
    lab: { opened: {}, danger: {}, demo: {} },
    slope: { stations: {}, finished: false }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- 持久化（含旧数据迁移） ---------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        S.points = s.points || 0;
        S.modules = Object.assign({ video: 0, quiz: 0, lab: 0, slope: 0 }, s.modules || {});
        S.awarded = s.awarded || {};
        S.log = s.log || [];
        S.video = Object.assign({ done: {}, decisions: [] }, s.video || {});
        S.quiz = Object.assign({ pre: null, post: null }, s.quiz || {});
        S.lab = Object.assign({ opened: {}, danger: {}, demo: {} }, s.lab || {});
        S.slope = Object.assign({ stations: {}, finished: false }, s.slope || {});
        return;
      }
      // 迁移旧版：保留学习记录，旧积分 scale 不同故不迁移
      var old = localStorage.getItem(OLD_KEY);
      if (old) {
        var o = JSON.parse(old);
        S.video.done = o.done || {};
        S.video.decisions = o.decisionsMade || [];
        S.quiz = o.quizResult || { pre: null, post: null };
        save();
      }
    } catch (e) { /* 存储不可用时仅内存生效 */ }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 发分 ---------- */
  /**
   * 幂等发分。同一 key 全周期只发一次。
   * @param {string} key 唯一键，如 'node:07_knee' / 'lab-open:wrist' / 'slope-station:2'
   * @param {string} module video|quiz|lab|slope
   * @param {string} label 流水说明
   * @param {number} points 分值
   * @param {boolean} silent 不弹 Toast（批量补登时用）
   * @returns {number} 实际发放分值（0 表示已发过）
   */
  function award(key, module, label, points, silent) {
    if (S.awarded[key]) return 0;
    S.awarded[key] = true;
    S.points += points;
    S.modules[module] = (S.modules[module] || 0) + points;
    S.log.unshift({ module: module, label: label, points: points, at: Date.now() });
    if (S.log.length > 200) S.log.length = 200;
    save();
    if (!silent) toast(label, points);
    renderHub();
    return points;
  }

  /* ---------- 等级 ---------- */
  function level() {
    var i = 0;
    for (var k = 0; k < LEVELS.length; k++) {
      if (S.points >= LEVELS[k].min) i = k;
    }
    var cur = LEVELS[i], next = LEVELS[i + 1] || null;
    var pct = 100;
    if (next) {
      pct = Math.round((S.points - cur.min) / (next.min - cur.min) * 100);
    }
    return { index: i, current: cur, next: next, pct: Math.max(0, Math.min(100, pct)) };
  }

  /* ---------- Toast ---------- */
  var toastTimer = 0;
  function toast(label, points) {
    var box = $('toastBox');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = '<span class="toast-ic">+' + points + '</span>' +
      '<span class="toast-tx">' + esc(label) + '</span>';
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 350);
    }, 2600);
    while (box.children.length > 3) box.removeChild(box.firstChild);
  }

  /* ---------- 汇总数据 ---------- */
  function summary() {
    var vd = Object.keys(S.video.done).length;
    var labOpen = Object.keys(S.lab.opened).length;
    var slopeDone = Object.keys(S.slope.stations).length;
    return {
      points: S.points,
      level: level(),
      modules: S.modules,
      video: { done: vd, decisions: S.video.decisions.length },
      quiz: { pre: S.quiz.pre, post: S.quiz.post },
      lab: { opened: labOpen, total: 4 },
      slope: { stations: slopeDone, total: 5, finished: S.slope.finished },
      log: S.log
    };
  }

  /* ---------- 首页模块卡片渲染 ---------- */
  function renderHub() {
    var hub = $('moduleHub');
    if (!hub) return;
    var sum = summary();
    var lv = sum.level;

    var chip = $('hubPoints');
    if (chip) {
      chip.innerHTML = '<span class="hub-lv-ic">' + lv.current.icon + '</span>' +
        '<span class="hub-lv-name">' + esc(lv.current.name) + '</span>' +
        '<span class="hub-pts">' + S.points + ' 分</span>' +
        '<span class="hub-go">学习档案 ›</span>';
    }

    function card(module, progress, points) {
      var el = hub.querySelector('[data-module="' + module + '"]');
      if (!el) return;
      var p = el.querySelector('.mc-progress');
      var s = el.querySelector('.mc-points');
      if (p) p.textContent = progress;
      if (s) s.textContent = (S.modules[module] || 0) + ' 分';
    }

    card('video', sum.video.done + ' / 23 段已学', S.modules.video);
    card('quiz',
      (S.quiz.pre ? '前测 ' + S.quiz.pre.correct + '/' + S.quiz.pre.total : '前测未做') +
      ' · ' + (S.quiz.post ? '后测 ' + S.quiz.post.correct + '/' + S.quiz.post.total : '后测未做'),
      S.modules.quiz);
    card('lab', sum.lab.opened + ' / 4 个机理已探索', S.modules.lab);
    card('slope', sum.slope.stations + ' / 5 站' + (S.slope.finished ? ' · 已通关' : ''), S.modules.slope);
  }

  /* ---------- 学习档案 ---------- */
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function showArchive(extraSections) {
    var sum = summary();
    var lv = sum.level;

    var cells =
      '<div class="arch-cell"><div class="arch-num">' + S.points + '</div><div class="arch-lab">总积分</div></div>' +
      '<div class="arch-cell"><div class="arch-num">' + sum.video.done + '/23</div><div class="arch-lab">视频节点</div></div>' +
      '<div class="arch-cell"><div class="arch-num">' + sum.video.decisions + '</div><div class="arch-lab">情境决策</div></div>' +
      '<div class="arch-cell"><div class="arch-num">' + sum.lab.opened + '/4</div><div class="arch-lab">3D 机理</div></div>' +
      '<div class="arch-cell"><div class="arch-num">' + sum.slope.stations + '/5</div><div class="arch-lab">雪场站点</div></div>';

    var modRows = Object.keys(MODULE_META).map(function (m) {
      var meta = MODULE_META[m];
      var pct = sum.points ? Math.round((S.modules[m] || 0) / sum.points * 100) : 0;
      return '<div class="arch-bar"><span class="lab">' + meta.icon + ' ' + meta.name + '</span>' +
        '<span class="track"><span class="fill" style="width:' + pct + '%;background:' + meta.color + '"></span></span>' +
        '<span class="val">' + (S.modules[m] || 0) + ' 分</span></div>';
    }).join('');

    var quizRows = '';
    if (S.quiz.pre || S.quiz.post) {
      var prePct = S.quiz.pre ? Math.round(S.quiz.pre.correct / S.quiz.pre.total * 100) : 0;
      var postPct = S.quiz.post ? Math.round(S.quiz.post.correct / S.quiz.post.total * 100) : 0;
      quizRows = '<div class="arch-bar"><span class="lab">📝 测评记录</span>' +
        '<span class="track"><span class="fill" style="width:' + prePct + '%;background:var(--text-faint)"></span></span>' +
        '<span class="val">前测 ' + (S.quiz.pre ? S.quiz.pre.correct + '/' + S.quiz.pre.total + ' · ' + prePct + '%' : '—') + '</span></div>' +
        '<div class="arch-bar"><span class="lab"></span>' +
        '<span class="track"><span class="fill" style="width:' + postPct + '%;background:var(--safe)"></span></span>' +
        '<span class="val">后测 ' + (S.quiz.post ? S.quiz.post.correct + '/' + S.quiz.post.total + ' · ' + postPct + '%' : '—') + '</span></div>';
    }

    var timeline = S.log.length
      ? S.log.slice(0, 12).map(function (l) {
          return '<div class="tl-row"><span class="tl-ic">' + (MODULE_META[l.module] || {}).icon + '</span>' +
            '<span class="tl-tx">' + esc(l.label) + '</span>' +
            '<span class="tl-pts">+' + l.points + '</span>' +
            '<span class="tl-t">' + fmtTime(l.at) + '</span></div>';
        }).join('')
      : '<p style="color:var(--text-faint);font-size:13px">还没有学习记录，去任意模块开始吧。</p>';

    var nextInfo = lv.next
      ? '再获得 <strong>' + (lv.next.min - S.points) + '</strong> 分晋升「' + esc(lv.next.name) + '」'
      : '已达最高等级，恭喜通关全部内容！';

    openOverlay(
      '<div class="ov-kicker">学习档案</div>' +
      '<h3 class="ov-title">' + lv.current.icon + ' ' + esc(lv.current.name) +
      '<span class="arch-lv-desc">' + esc(lv.current.desc) + '</span></h3>' +
      '<div class="arch-lv-bar"><div class="arch-lv-fill" style="width:' + lv.pct + '%"></div></div>' +
      '<p class="arch-lv-next">' + nextInfo + '</p>' +
      '<div class="arch-grid">' + cells + '</div>' +
      '<h4 class="panel-title">模块积分分布</h4>' + modRows + quizRows +
      (extraSections || '') +
      '<h4 class="panel-title">最近动态</h4><div class="tl-list">' + timeline + '</div>' +
      '<div class="ov-actions">' +
      '<button class="btn btn-ghost" data-export>导出记录(CSV)</button>' +
      '<button class="btn btn-ghost" data-reset>清空重来</button>' +
      '<button class="btn btn-primary" data-close>关闭</button>' +
      '</div>',
      function (body) {
        body.querySelector('[data-export]').addEventListener('click', exportCSV);
        body.querySelector('[data-reset]').addEventListener('click', function () {
          if (window.confirm('确定清空全部学习记录与积分吗？此操作不可恢复。')) {
            try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
            location.reload();
          }
        });
      }
    );
  }

  function exportCSV() {
    var rows = [['模块', '行为', '积分', '时间']];
    Object.keys(MODULE_META).forEach(function (m) {
      rows.push([MODULE_META[m].name, '模块小计', S.modules[m] || 0, '']);
    });
    rows.push(['合计', '总积分', S.points, '']);
    S.log.slice().reverse().forEach(function (l) {
      rows.push([(MODULE_META[l.module] || {}).name || l.module, l.label, '+' + l.points, fmtTime(l.at)]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '雪线之上_学习档案.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* 复用全局弹层（app.js 提供）；若未就绪则降级为 alert 概要 */
  function openOverlay(html, after) {
    if (typeof window.openGlobalOverlay === 'function') {
      window.openGlobalOverlay(html, after);
    } else {
      window.alert('学习档案：当前积分 ' + S.points);
    }
  }

  /* ---------- 暴露 ---------- */
  window.Progress = {
    load: load,
    save: save,
    award: award,
    toast: toast,
    summary: summary,
    level: level,
    renderHub: renderHub,
    showArchive: showArchive,
    exportCSV: exportCSV,
    LEVELS: LEVELS,
    MODULE_META: MODULE_META,
    _state: S
  };

  load();
})();
