/**
 * 雪线之上 · 预防滑雪运动损伤 —— 交互式全景科普学习系统
 * 主应用逻辑
 *
 * 模块：
 *   1. 数据装载      —— content.json（章节/节点/知识卡/决策）/ quiz.json（前后测题库）
 *   2. 全景播放      —— PanoramaPlayer + 双 video 缓冲实现片段无缝衔接
 *   3. 情境决策引擎  —— 关键节点后弹出雪场情境选择题，分支跳转
 *   4. 学习闭环      —— 前测 / 后测 / 学习档案，localStorage 持久化并可导出 CSV
 */
(function () {
  'use strict';

  var VIDEO_DIR = 'assets/video/';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    chapters: [],
    nodes: [],
    seq: [],                 // 正常播放序列
    idx: 0,                  // 当前在正常序列中的位置
    decisions: [],
    refs: [],
    quiz: { pre: [], post: [] },
    done: {},                // slug -> true
    decisionsMade: [],
    quizResult: { pre: null, post: null },
    inQuiz: null,
    detourSlug: null,        // 当前是否处于"后果片段"绕行中
    filterChapter: null,     // 侧栏筛选的篇章，null = 全部
    narration: {},           // slug -> { segments: [{t, dur|actualDur, text}] }
    subtitleOn: true,
    awaitingReturn: false,
    webglOk: true,
    player: null,
    active: null,
    standby: null,
    resumeAfterLab: false     // 从 3D 实验室返回后是否恢复播放
  };

  /* ==========================================================
     一、数据装载
     ========================================================== */
  function loadData() {
    // 双通道数据装载：
    // 1) HTTP 模式：优先 fetch 最新 JSON（改内容后无需重新生成 data.js）
    // 2) file:// 模式：fetch 被浏览器安全策略禁止，回退到 data.js 内联数据
    var inline = window.__APP_DATA__ || {};
    function loadOne(url, inlineKey, fallback) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).catch(function () {
        var d = inline[inlineKey];
        if (d === undefined || d === null) {
          if (fallback !== undefined) return fallback;
          throw new Error('数据源缺失：' + url + '（请确认 data/data.js 已随页面一同加载）');
        }
        return d;
      });
    }
    return Promise.all([
      loadOne('data/content.json', 'content'),
      loadOne('data/quiz.json', 'quiz'),
      loadOne('data/narration.json', 'narration', { nodes: {} })
    ]).then(function (res) {
      var c = res[0], q = res[1], n = res[2];
      state.chapters = c.chapters;
      state.nodes = c.nodes;
      state.decisions = c.decisions || [];
      state.refs = c.refs || [];
      state.narration = n.nodes || {};
      state.quiz = q;

      // 播放序列 = 按 chapters 顺序拼接各篇章节点
      state.seq = [];
      state.chapters.forEach(function (ch) {
        state.nodes.forEach(function (n) {
          if (n.chapter === ch.id) state.seq.push(n);
        });
      });
      // 保障：未被任何篇章收录的节点追加在末尾
      state.nodes.forEach(function (n) {
        if (state.seq.indexOf(n) === -1) state.seq.push(n);
      });

      loadProgress();
      renderTabs();
      renderNodeList();
      renderProgressSummary();
    }).catch(function (err) {
      document.body.insertAdjacentHTML('afterbegin',
        '<div style="padding:40px;color:#ffcdd2;font-size:14px;line-height:2">' +
        '数据装载失败：' + esc(err.message) + '<br>' +
        '① 推荐：双击本作品目录下的「启动预览.command」（自动启动本地服务并打开浏览器）；<br>' +
        '② 或手动执行：进入「参赛打包文件/作品及成果文件」目录后运行 ' +
        '<code>python3 工作文件/serve.py 8000</code>，再访问 <code>http://localhost:8000</code>。<br>' +
        '<span style="opacity:.75">说明：浏览器在 file:// 协议下禁止读取本地数据文件，这是安全策略而非作品故障；' +
        '直接双击 index.html 时系统已自动尝试使用内联数据，若仍失败请检查 data/data.js 是否与本页在同一目录。</span></div>');
    });
  }

  /* ==========================================================
     二、进度持久化（统一由 Progress 模块管理）
     ========================================================== */
  function loadProgress() {
    var P = window.Progress;
    if (!P) return;
    state.done = P._state.video.done || {};
    state.decisionsMade = P._state.video.decisions || [];
    state.quizResult = P._state.quiz || { pre: null, post: null };
  }

  function saveProgress() {
    var P = window.Progress;
    if (!P) return;
    P._state.video.done = state.done;
    P._state.video.decisions = state.decisionsMade;
    P._state.quiz = state.quizResult;
    P.save();
  }

  /* ==========================================================
     三、渲染：篇章标签 / 节点列表 / 进度
     ========================================================== */
  function renderTabs() {
    var box = $('chapterTabs');
    box.innerHTML = '';
    state.chapters.forEach(function (ch, i) {
      var b = document.createElement('button');
      b.className = 'chapter-tab' + (i === 0 ? ' active' : '');
      b.textContent = ch.icon + ' ' + ch.title;
      b.addEventListener('click', function () {
        var wasActive = b.classList.contains('active');
        Array.prototype.forEach.call(box.children, function (x) { x.classList.remove('active'); });
        if (wasActive) {
          // 再次点击已选篇章 → 取消筛选，显示全部节点
          renderNodeList(null);
        } else {
          b.classList.add('active');
          renderNodeList(ch.id);
        }
      });
      box.appendChild(b);
    });
  }

  function renderNodeList(chapterId) {
    // chapterId 未传时沿用当前筛选；state.filterChapter 为 null 表示显示全部
    if (chapterId !== undefined) state.filterChapter = chapterId || null;
    var filter = state.filterChapter;
    var ul = $('nodeList');
    ul.innerHTML = '';
    state.seq.forEach(function (n, i) {
      if (filter && n.chapter !== filter) return;
      var li = document.createElement('li');
      var btn = document.createElement('button');
      var globalPos = state.seq.indexOf(n) + 1;
      btn.className = 'node-item' + (state.done[n.slug] ? ' done' : '') +
        (state.seq[state.idx] === n ? ' active' : '');
      btn.innerHTML =
        '<span class="node-idx">' + (state.done[n.slug] ? '✓' : globalPos) + '</span>' +
        '<span class="node-name">' + n.title + '</span>' +
        '<span class="node-dur">' + fmtTime(n.duration) + '</span>';
      btn.addEventListener('click', function () {
        state.detourSlug = null;
        playIndex(state.seq.indexOf(n));
      });
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function renderProgressSummary() {
    var total = state.seq.length;
    var doneCount = Object.keys(state.done).length;
    var pct = total ? Math.round(doneCount / total * 100) : 0;
    $('progressSummary').innerHTML =
      '<div class="ps-bar"><div class="ps-fill" style="width:' + pct + '%"></div></div>' +
      '<span>' + doneCount + ' / ' + total + '</span>';
    var P = window.Progress;
    $('scoreValue').textContent = P ? P._state.points : 0;
  }

  /** 完成节点发分 + 篇章通关检测（幂等，由 Progress 去重） */
  function awardNodeDone(node) {
    var P = window.Progress;
    if (!P) return;
    P.award('node:' + node.slug, 'video', '完成《' + node.title + '》', 10);
    // 篇章通关：该篇章全部节点已完成
    var ch = state.chapters.filter(function (c) { return c.id === node.chapter; })[0];
    if (!ch) return;
    var list = state.seq.filter(function (n) { return n.chapter === ch.id; });
    var allDone = list.length && list.every(function (n) { return state.done[n.slug]; });
    if (allDone) {
      P.award('chapter:' + ch.id, 'video', '通关篇章「' + ch.title + '」', 20);
    }
  }  /* 节点 → 3D 实验室模块映射（损伤认知篇） */
  var LAB_MAP = {
    '21_joint_sprain': 'knee',
    '22_fracture': 'wrist',
    '23_frostbite': 'frostbite',
    '24_frostbite_face': 'frostbite',
    '25_frostbite_torso': 'frostbite',
    '26_frostbite_ankle': 'ankle'
  };

  function openLab3D(moduleId) {
    if (typeof window.Lab3D === 'undefined') {
      openOverlay('<div class="ov-kicker">组件缺失</div>' +
        '<h3 class="ov-title">3D 实验室组件未加载</h3>' +
        '<div class="ov-scene">请确认 js/injury3d.js 与 js/vendor/three.min.js 存在。</div>' +
        '<div class="ov-actions"><button class="btn btn-primary" data-close>知道了</button></div>');
      return;
    }
    if (state.active && !state.active.paused) {
      state.active.pause();
      state.resumeAfterLab = true;
    }
    window.Lab3D.open(moduleId || 'knee');
  }

  function renderKnowledge(node) {
    var box = $('knowledgeCard');
    if (!node || !node.knowledge) { box.innerHTML = '<p style="color:#5d7a8f">暂无知识卡</p>'; return; }
    var k = node.knowledge;
    var refsHtml = '';
    if (k.refs && k.refs.length) {
      var map = {};
      state.refs.forEach(function (r) { map[r.id] = r.text; });
      refsHtml = '<div class="know-refs">资料依据：<br>' + k.refs.map(function (id) {
        return '· ' + (map[id] || id);
      }).join('<br>') + '</div>';
    }
    var labMod = LAB_MAP[node.slug];
    var labHtml = labMod
      ? '<button class="know-lab-btn" data-lab-mod="' + labMod + '">🔬 在 3D 损伤实验室中观察这一损伤</button>'
      : '';
    box.innerHTML =
      '<div class="know-summary">' + esc(node.summary || '') + '</div>' +
      '<ul class="know-points">' + (k.points || []).map(function (p) {
        return '<li>' + esc(p) + '</li>';
      }).join('') + '</ul>' + refsHtml + labHtml;

    var labBtn = box.querySelector('.know-lab-btn');
    if (labBtn) {
      labBtn.addEventListener('click', function () {
        openLab3D(labBtn.dataset.labMod);
      });
    }
  }

  /* ==========================================================
     四、播放器与片段调度
     ========================================================== */
  function initPlayer() {
    var canvas = $('pano');
    var videoA = $('videoA'), videoB = $('videoB');
    state.active = videoA;
    state.standby = videoB;

    try {
      state.player = new PanoramaPlayer(canvas, { fov: 78, vignette: 0.3 });
    } catch (e) {
      state.webglOk = false;
      $('fallbackNotice').classList.remove('hidden');
      canvas.style.display = 'none';
      return;
    }

    state.player.onError = function () {
      // 纹理上传失败（常见于 file:// 协议下的跨域限制）→ 降级为平面播放
      if (state.webglOk) {
        state.webglOk = false;
        state.player.stop();
        $('fallbackNotice').classList.remove('hidden');
        canvas.style.display = 'none';
        enterFlatMode();
      }
    };

    state.player.attachHotspotLayer($('hotspotLayer'));
    state.player.onHotspotClick = function (h) {
      openOverlay('<div class="ov-kicker">视角提示</div>' +
        '<h3 class="ov-title">' + esc(h.label) + '</h3>' +
        '<div class="ov-scene">' + esc(h.text) + '</div>' +
        '<div class="ov-actions"><button class="btn btn-primary" data-close>知道了</button></div>');
    };

    [videoA, videoB].forEach(function (v) {
      v.addEventListener('timeupdate', onTimeUpdate);
      v.addEventListener('ended', onEnded);
      v.addEventListener('error', function () {
        var msg = '视频加载失败：' + (v.src || '').split('/').pop();
        if (state.webglOk) {
          $('hudHint').textContent = msg + '（若通过 file:// 打开，请改用本地 HTTP 服务）';
        }
      });
    });

    state.player.start();
    window.addEventListener('resize', function () { state.player.resize(); });
  }

  function enterFlatMode() {
    // 平面降级：直接显示 video 元素，支持左右拖动查看全景画面
    var vp = document.querySelector('.viewport');
    var v = state.active;
    v.classList.add('flat-video');
    vp.appendChild(v);
    var dragging = false, sx = 0, ox = 0;
    v.style.transform = 'translateX(0px)';
    function down(x) { dragging = true; sx = x; ox = parseFloat(v.dataset.ox || '0'); }
    function move(x) {
      if (!dragging) return;
      var tx = Math.max(-v.clientWidth * 0.5, Math.min(0, ox + (x - sx)));
      v.dataset.ox = tx;
      v.style.transform = 'translateX(' + tx + 'px)';
    }
    v.addEventListener('mousedown', function (e) { down(e.clientX); });
    window.addEventListener('mousemove', function (e) { move(e.clientX); });
    window.addEventListener('mouseup', function () { dragging = false; });
    v.addEventListener('touchstart', function (e) { down(e.touches[0].clientX); }, { passive: true });
    v.addEventListener('touchmove', function (e) { move(e.touches[0].clientX); }, { passive: true });
    v.addEventListener('touchend', function () { dragging = false; });
  }

  function nodeUrl(node) { return VIDEO_DIR + node.slug + '.mp4'; }

  function playIndex(i) {
    if (i < 0 || i >= state.seq.length) return;
    state.idx = i;
    var node = state.seq[i];
    var ch = state.chapters.filter(function (c) { return c.id === node.chapter; })[0];

    $('hudChapter').textContent = ch ? ch.title : '综合';
    $('hudNode').textContent = node.title;
    $('hudHint').textContent = node.summary || '';

    renderKnowledge(node);
    renderNodeList();
    renderProgressSummary();

    var v = state.standby;
    var url = nodeUrl(node);
    if (v.getAttribute('src') !== url) {
      v.setAttribute('src', url);
      v.load();
    }
    v.currentTime = 0;

    var prev = state.active;
    prev.pause();

    if (state.webglOk) {
      state.player.setOpacity(0);
    }
    var p = v.play();
    if (p && p.catch) {
      p.then(function () {
        if (state.webglOk) {
          state.player.setSource(v);
          state.player.setOpacity(1);
        }
      }).catch(function () {
        $('hudHint').textContent = '浏览器阻止了自动播放，请点击播放按钮继续。';
      });
    } else {
      if (state.webglOk) {
        state.player.setSource(v);
        state.player.setOpacity(1);
      }
    }

    // 交换缓冲：原 active 变为 standby，用于预载下一片段
    state.standby = prev;
    state.active = v;

    if (state.webglOk) {
      state.player.setHotspots(node.hotspots || []);
    }
    preloadNext();
  }

  function preloadNext() {
    var next = state.seq[state.idx + 1];
    if (!next) return;
    var url = nodeUrl(next);
    var v = state.standby;
    if (v.getAttribute('src') !== url) {
      v.setAttribute('src', url);
      v.load();
    }
  }

  function onTimeUpdate() {
    var v = state.active;
    if (!v || !v.duration) return;
    var pct = (v.currentTime / v.duration) * 100;
    $('progressBar').style.width = pct + '%';
    $('timeLabel').textContent = fmtTime(v.currentTime) + ' / ' + fmtTime(v.duration);
    updateSubtitle(v);
  }

  /** 按句号/问号/感叹号/分号断行，提升长字幕可读性（标点保留在行尾） */
  function breakLines(text) {
    var s = String(text == null ? '' : text);
    var parts = s.match(/[^。！？；!?;]+[。！？；!?;]?/g);
    if (!parts) return esc(s);
    return parts.map(esc).join('<br>');
  }

  /** 依据 narration 时间轴渲染字幕 */
  function updateSubtitle(v) {
    var bar = $('subtitleBar');
    if (!state.subtitleOn) { bar.classList.remove('visible'); return; }
    var node = state.seq[state.idx];
    var nar = state.narration[node ? node.slug : ''];
    if (!nar || !nar.segments || !nar.segments.length) { bar.classList.remove('visible'); return; }
    var t = v.currentTime;
    var hit = null;
    for (var i = 0; i < nar.segments.length; i++) {
      var s = nar.segments[i];
      var d = s.actualDur != null ? s.actualDur : s.dur;
      if (t >= s.t - 0.15 && t <= s.t + d + 0.35) { hit = s; break; }
    }
    if (hit) {
      var el = $('subText');
      if (el.dataset.raw !== hit.text) {
        el.dataset.raw = hit.text;
        el.innerHTML = breakLines(hit.text);
      }
      bar.classList.add('visible');
    } else {
      bar.classList.remove('visible');
    }
  }

  function onEnded(e) {
    if (e.target !== state.active) return;
    var node = state.seq[state.idx];

    // 绕行（风险后果片段）播完 → 回到正常路径的下一节点
    if (state.detourSlug) {
      state.detourSlug = null;
      openOverlay('<div class="ov-kicker">回到正路</div>' +
        '<h3 class="ov-title">正确的做法是这样的</h3>' +
        '<div class="ov-scene">刚才看到的是错误选择的后果。接下来回到标准流程，看看正确动作应该怎么做。</div>' +
        '<div class="ov-actions"><button class="btn btn-primary" data-continue>继续正确流程</button></div>');
      return;
    }

    if (!state.done[node.slug]) {
      state.done[node.slug] = true;
      saveProgress();
      awardNodeDone(node);
      renderProgressSummary();
      renderNodeList();
    }

    var d = state.decisions.filter(function (x) { return x.after === node.slug; })[0];
    if (d && !state.decisionsMade.some(function (m) { return m.id === d.id; })) {
      showDecision(d);
      return;
    }

    if (state.idx + 1 < state.seq.length) {
      playIndex(state.idx + 1);
    } else {
      finishCourse();
    }
  }

  /* ==========================================================
     五、情境决策引擎
     ========================================================== */
  function showDecision(d) {
    var html =
      '<div class="ov-kicker">雪场情境 · 决策点</div>' +
      '<h3 class="ov-title">' + esc(d.question) + '</h3>' +
      '<div class="ov-scene">' + esc(d.scene) + '</div>' +
      '<div class="opt-list">' +
      d.options.map(function (o, i) {
        return '<button class="opt" data-i="' + i + '">' +
          '<span class="opt-key">' + 'ABC'[i] + '</span><span>' + esc(o.text) + '</span></button>';
      }).join('') +
      '</div><div id="fbBox"></div>';

    openOverlay(html, function (body) {
      var fb = body.querySelector('#fbBox');
      var opts = body.querySelectorAll('.opt');
      Array.prototype.forEach.call(opts, function (btn) {
        btn.addEventListener('click', function () {
          var i = parseInt(btn.getAttribute('data-i'), 10);
          var o = d.options[i];
          var isSafe = o.verdict === 'safe';

          Array.prototype.forEach.call(opts, function (x) { x.classList.add('disabled'); });
          btn.classList.remove('disabled');
          btn.classList.add(isSafe ? 'picked-safe' : 'picked-risky');

          state.decisionsMade.push({ id: d.id, pick: i, verdict: o.verdict, at: Date.now() });
          saveProgress();
          if (isSafe && window.Progress) {
            window.Progress.award('dec:' + d.id, 'video', '安全决策：' + d.question.slice(0, 14) + '…', 5);
          }
          renderProgressSummary();

          fb.innerHTML = '<div class="opt-feedback ' + o.verdict + '">' +
            '<strong>' + (isSafe ? '✓ 安全选择' : '✕ 高危选择') + '</strong><br>' + esc(o.feedback) + '</div>' +
            '<div class="ov-actions"><button class="btn btn-primary" data-pick-next="' + i + '">' +
            (isSafe ? '继续' : '看看正确做法') + '</button></div>';

          var nextBtn = fb.querySelector('[data-pick-next]');
          nextBtn.addEventListener('click', function () {
            closeOverlay();
            jumpTo(o.next, !isSafe);
          });
        });
      });
    });
  }

  /** 跳转到目标片段。isDetour=true 表示这是风险后果片段，播完后回到正常路径 */
  function jumpTo(slug, isDetour) {
    var target = -1;
    for (var i = 0; i < state.seq.length; i++) {
      if (state.seq[i].slug === slug) { target = i; break; }
    }
    if (target === -1) return;

    if (isDetour) {
      state.detourSlug = slug;
      playIndex(target);
    } else {
      state.idx = target;
      playIndex(target);
    }
  }

  /* ==========================================================
     六、测验与学习闭环
     ========================================================== */
  function runQuiz(phase) {
    var qs = state.quiz[phase] || [];
    if (!qs.length) return;
    state.inQuiz = { phase: phase, i: 0, correct: 0, answers: [] };
    renderQuizQuestion();
  }

  function renderQuizQuestion() {
    var q = state.inQuiz;
    var qs = state.quiz[q.phase];
    if (q.i >= qs.length) { finishQuiz(); return; }
    var item = qs[q.i];
    var html =
      '<div class="ov-kicker">' + (q.phase === 'pre' ? '前测' : '后测') +
      ' · 第 ' + (q.i + 1) + ' / ' + qs.length + ' 题</div>' +
      '<p class="quiz-q">' + esc(item.question) + '</p>' +
      '<div class="opt-list">' +
      item.options.map(function (o, i) {
        return '<button class="opt" data-i="' + i + '">' +
          '<span class="opt-key">' + 'ABCD'[i] + '</span><span>' + esc(o) + '</span></button>';
      }).join('') +
      '</div><div id="qFb"></div>';

    openOverlay(html, function (body) {
      var fb = body.querySelector('#qFb');
      var opts = body.querySelectorAll('.opt');
      Array.prototype.forEach.call(opts, function (btn) {
        btn.addEventListener('click', function () {
          var i = parseInt(btn.getAttribute('data-i'), 10);
          var ok = (i === item.answer);
          Array.prototype.forEach.call(opts, function (x) { x.classList.add('disabled'); });
          btn.classList.remove('disabled');
          btn.classList.add(ok ? 'picked-safe' : 'picked-risky');
          if (!ok) {
            opts[item.answer].classList.add('picked-safe');
          }
          q.answers.push({ id: item.id, pick: i, correct: ok });
          if (ok) q.correct++;

          fb.innerHTML = '<div class="quiz-explain">' + esc(item.explain) + '</div>' +
            '<div class="ov-actions"><button class="btn btn-primary" data-next>' +
            (q.i + 1 < qs.length ? '下一题' : '查看结果') + '</button></div>';
          fb.querySelector('[data-next]').addEventListener('click', function () {
            q.i++;
            renderQuizQuestion();
          });
        });
      });
    });
  }

  function finishQuiz() {
    var q = state.inQuiz;
    var total = state.quiz[q.phase].length;
    var res = { correct: q.correct, total: total, at: Date.now() };
    state.quizResult[q.phase] = res;
    saveProgress();

    /* 统一积分：完成 +10；后测正确率 ≥80% +30；较前测提升 ≥2 题 +20 */
    var P = window.Progress;
    if (P) {
      P.award('quiz-' + q.phase, 'quiz', (q.phase === 'pre' ? '完成前测' : '完成后测') +
        '（' + q.correct + '/' + total + '）', 10);
      if (q.phase === 'post') {
        if (total && q.correct / total >= 0.8) {
          P.award('quiz-post-high', 'quiz', '后测正确率 ≥80%', 30);
        }
        var pre = state.quizResult.pre;
        if (pre && q.correct - pre.correct >= 2) {
          P.award('quiz-post-gain', 'quiz', '后测较前测提升 ' + (q.correct - pre.correct) + ' 题', 20);
        }
      }
    }
    renderProgressSummary();

    var extra = '';
    if (q.phase === 'post' && state.quizResult.pre) {
      var pre = state.quizResult.pre, post = res;
      var d = post.correct - pre.correct;
      extra = '<div class="opt-feedback ' + (d >= 0 ? 'safe' : 'risky') + '">' +
        '前测 ' + pre.correct + ' / ' + pre.total + ' → 后测 ' + post.correct + ' / ' + post.total +
        '　（' + (d >= 0 ? '+' : '') + d + ' 题）</div>';
    }

    openOverlay('<div class="ov-kicker">' + (q.phase === 'pre' ? '前测' : '后测') + '结果</div>' +
      '<h3 class="ov-title">答对 ' + q.correct + ' / ' + total + ' 题</h3>' +
      '<div class="ov-scene">' +
      (q.phase === 'pre'
        ? '已记录你的起始水平。学完视频后再来做一次后测，就能看到自己的进步。'
        : '本轮学习完成。后测结果与前测的差值，可作为科普内容有效性的参考。') +
      '</div>' + extra +
      '<div class="ov-actions">' +
      (q.phase === 'pre'
        ? '<button class="btn btn-primary" data-start>开始视频学习</button>' +
          '<button class="btn btn-ghost" data-home>返回首页</button>'
        : '<button class="btn btn-primary" data-archive>查看学习档案</button>' +
          '<button class="btn btn-ghost" data-home>返回首页</button>') +
      '</div>', function (body) {
      var s = body.querySelector('[data-start]');
      if (s) s.addEventListener('click', function () { closeOverlay(); enterApp(); });
      var a = body.querySelector('[data-archive]');
      if (a) a.addEventListener('click', function () { closeOverlay(); showArchive(); });
      var h = body.querySelector('[data-home]');
      if (h) h.addEventListener('click', function () { closeOverlay(); showSplash(); });
    });
    state.inQuiz = null;
  }

  function finishCourse() {
    showArchive();
  }

  /* ==========================================================
     七、学习档案（统一档案由 progress.js 渲染，此处补充篇章明细）
     ========================================================== */
  function showArchive() {
    var P = window.Progress;
    if (!P) { window.alert('档案组件未加载'); return; }

    var chRows = state.chapters.map(function (ch) {
      var list = state.seq.filter(function (n) { return n.chapter === ch.id; });
      var d = list.filter(function (n) { return state.done[n.slug]; }).length;
      var p = list.length ? Math.round(d / list.length * 100) : 0;
      var color = ch.id === 'injury' ? 'var(--warn)' : (ch.id === 'skill' ? 'var(--safe)' : 'var(--ice)');
      return '<div class="arch-bar"><span class="lab">' + ch.icon + ' ' + ch.title + '</span>' +
        '<span class="track"><span class="fill" style="width:' + p + '%;background:' + color + '"></span></span>' +
        '<span class="val">' + d + '/' + list.length + '</span></div>';
    }).join('');

    var pre = state.quizResult.pre, post = state.quizResult.post;
    var quizRow = '';
    if (pre || post) {
      quizRow = '<div class="arch-bar"><span class="lab">📝 测评记录</span><span class="track"></span><span class="val">' +
        (pre ? '前测 ' + pre.correct + '/' + pre.total : '前测 —') + ' · ' +
        (post ? '后测 ' + post.correct + '/' + post.total : '后测 —') + '</span></div>';
    }

    P.showArchive('<h4 class="panel-title">视频篇章进度</h4>' + chRows + quizRow);
  }

  /* ==========================================================
     八、界面控制
     ========================================================== */
  var guideShown = false;
  function enterApp() {
    $('splash').classList.add('hidden');
    $('app').classList.remove('hidden');
    if (state.player) state.player.resize();
    if (!state.active.getAttribute('src')) {
      playIndex(0);
    } else {
      var p = state.active.play();
      if (p && p.catch) p.catch(function () {});
    }
    /* 全景滑动引导：每次会话首次进入时显示 6 秒 */
    if (!guideShown && state.webglOk) {
      guideShown = true;
      var g = $('panoGuide');
      if (g) {
        g.classList.remove('hidden');
        setTimeout(function () {
          g.classList.add('fading');
          setTimeout(function () { g.classList.add('hidden'); g.classList.remove('fading'); }, 700);
        }, 6000);
      }
    }
  }

  function openOverlay(html, after) {
    var ov = $('overlay');
    $('overlayBody').innerHTML = html;
    ov.classList.remove('hidden');
    if (after) after($('overlayBody'));
    var closer = $('overlayBody').querySelector('[data-close]');
    if (closer) closer.addEventListener('click', closeOverlay);
  }

  function closeOverlay() { $('overlay').classList.add('hidden'); }

  /* ==========================================================
     九、工具函数
     ========================================================== */
  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ==========================================================
     十、启动
     ========================================================== */

  /** 返回模块选择首页 */
  function showSplash() {
    if (state.active) state.active.pause();
    $('app').classList.add('hidden');
    $('splash').classList.remove('hidden');
    if (window.Progress) window.Progress.renderHub();
  }

  /** 知识测试选择面板（前测/后测自由选择，不再强制前置） */
  function showQuizPicker() {
    var pre = state.quizResult.pre, post = state.quizResult.post;
    function state_(r) { return r ? '已完成 ' + r.correct + '/' + r.total : '未开始'; }
    function cls(r) { return r ? 'done' : ''; }
    openOverlay(
      '<div class="ov-kicker">知识测试</div>' +
      '<h3 class="ov-title">检验你的掌握程度</h3>' +
      '<div class="ov-scene">共 12 题（前测/后测各 6 题）。建议先做前测记录起始水平，' +
      '学完视频与 3D 模块后再做后测，对比进步幅度。</div>' +
      '<div class="quiz-pick">' +
      '<button class="quiz-pick-item ' + cls(pre) + '" data-phase="pre">' +
      '<span class="quiz-pick-ic">1️⃣</span>' +
      '<span class="quiz-pick-body"><strong>前测 · 起始水平</strong>' +
      '<small>6 道选择题，了解你现在的滑雪安全知识基础</small></span>' +
      '<span class="quiz-pick-state ' + (pre ? '' : 'todo') + '">' + state_(pre) + '</span></button>' +
      '<button class="quiz-pick-item ' + cls(post) + '" data-phase="post">' +
      '<span class="quiz-pick-ic">2️⃣</span>' +
      '<span class="quiz-pick-body"><strong>后测 · 学习效果</strong>' +
      '<small>同样 6 道题，可与前测对比；正确率 ≥80% 有额外积分</small></span>' +
      '<span class="quiz-pick-state ' + (post ? '' : 'todo') + '">' + state_(post) + '</span></button>' +
      '</div>' +
      '<div class="ov-actions"><button class="btn btn-ghost" data-close>返回首页</button></div>',
      function (body) {
        Array.prototype.forEach.call(body.querySelectorAll('[data-phase]'), function (b) {
          b.addEventListener('click', function () {
            closeOverlay();
            runQuiz(b.getAttribute('data-phase'));
          });
        });
      }
    );
  }

  function bindUI() {
    /* 首页模块卡片 */
    var hub = $('moduleHub');
    if (hub) {
      Array.prototype.forEach.call(hub.querySelectorAll('.mc'), function (card) {
        card.addEventListener('click', function () {
          var m = card.getAttribute('data-module');
          if (m === 'video') enterApp();
          else if (m === 'quiz') showQuizPicker();
          else if (m === 'lab') openLab3D();
          else if (m === 'slope') openSki3D();
        });
      });
    }
    var hubArch = $('btnHubArchive');
    if (hubArch) hubArch.addEventListener('click', showArchive);
    /* 首页等级/积分卡片：点击直接查看学习档案 */
    var hubPts = $('hubPoints');
    if (hubPts) hubPts.addEventListener('click', showArchive);

    if (typeof window.Lab3D !== 'undefined') {
      window.Lab3D.onClose(function () {
        if (state.resumeAfterLab && state.active) {
          var p = state.active.play();
          if (p && p.catch) p.catch(function () {});
          updatePlayBtn();
        }
        state.resumeAfterLab = false;
        if (window.Progress) window.Progress.renderHub();
      });
    }

    $('btnArchive').addEventListener('click', showArchive);
    $('btnLab3D').addEventListener('click', function () {
      var node = state.seq[state.idx];
      openLab3D(node ? LAB_MAP[node.slug] : 'knee');
    });
    $('btnSki3D').addEventListener('click', function () { openSki3D(); });
    $('btnBackSplash').addEventListener('click', showSplash);

    $('overlayClose').addEventListener('click', closeOverlay);
    $('overlay').addEventListener('click', function (e) {
      if (e.target === $('overlay') && !state.inQuiz) closeOverlay();
    });

    $('btnPlay').addEventListener('click', function () {
      var v = state.active;
      if (!v) return;
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      else v.pause();
      updatePlayBtn();
    });

    $('btnPrev').addEventListener('click', function () {
      state.detourSlug = null;
      playIndex(Math.max(0, state.idx - 1));
    });

    $('btnNext').addEventListener('click', function () {
      state.detourSlug = null;
      if (state.idx + 1 < state.seq.length) playIndex(state.idx + 1);
      else finishCourse();
    });

    $('btnReset').addEventListener('click', function () {
      if (state.player) { state.player.tYaw = 0; state.player.tPitch = 0; state.player.fov = 78; state.player._dirty = true; }
    });

    $('btnSub').addEventListener('click', function () {
      state.subtitleOn = !state.subtitleOn;
      this.style.opacity = state.subtitleOn ? '1' : '.45';
      var bar = $('subtitleBar');
      if (!state.subtitleOn) bar.classList.remove('visible');
    });

    $('btnFull').addEventListener('click', function () {
      var vp = document.querySelector('.viewport');
      if (!document.fullscreenElement) {
        if (vp.requestFullscreen) vp.requestFullscreen();
      } else if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeOverlay();
      if (e.key === ' ' && $('overlay').classList.contains('hidden')) {
        e.preventDefault();
        $('btnPlay').click();
      }
    });

    if (state.active) {
      state.active.addEventListener('play', updatePlayBtn);
      state.active.addEventListener('pause', updatePlayBtn);
    }
    if (state.standby) {
      state.standby.addEventListener('play', updatePlayBtn);
      state.standby.addEventListener('pause', updatePlayBtn);
    }
  }

  function updatePlayBtn() {
    var v = state.active;
    $('btnPlay').textContent = (v && !v.paused) ? '❚❚' : '▶';
  }

  function checkProtocol() {
    if (location.protocol !== 'file:') return;
    // file:// 模式：数据已由 data.js 内联兜底，但全景纹理会被浏览器安全策略阻止。
    // 直接增强统一的降级提示条，避免与 WebGL 降级提示重复弹出两条。
    var notice = $('fallbackNotice');
    notice.innerHTML =
      '检测到以 file:// 方式打开：学习数据已自动切换为内联副本，可正常学习；' +
      '但浏览器安全策略会禁止全景视频纹理渲染，画面将使用平面播放模式（可左右拖动查看）。<br>' +
      '完整体验：请双击作品目录下的「启动预览.command」，' +
      '或进入本目录执行 <code>python3 ../../工作文件/serve.py 8000</code> 后访问 <code>http://localhost:8000</code>。';
    notice.classList.remove('hidden');
  }

  /** 打开全景滑雪场 3D 模块（ski3d.js 未加载时给出非阻塞提示） */
  function openSki3D() {
    if (typeof window.Ski3D === 'undefined') {
      openOverlay('<div class="ov-kicker">敬请期待</div>' +
        '<h3 class="ov-title">全景滑雪场模块加载中</h3>' +
        '<div class="ov-scene">未检测到 js/ski3d.js 或场景文件 assets/models/ski_slope.glb，' +
        '请确认作品目录完整后重试。</div>' +
        '<div class="ov-actions"><button class="btn btn-primary" data-close>知道了</button></div>');
      return;
    }
    if (state.active && !state.active.paused) {
      state.active.pause();
      state.resumeAfterLab = true;
    }
    window.Ski3D.open();
  }

  /** 返回模块选择首页（供四个模块的顶栏「首页」按钮统一调用） */
  function goHome() {
    state.resumeAfterLab = false;   // 回首页时不恢复视频播放
    showSplash();
  }

  /* 暴露全局弹层与统一档案入口（供 progress.js / injury3d.js / ski3d.js 使用） */
  window.openGlobalOverlay = openOverlay;
  window.closeGlobalOverlay = closeOverlay;
  window.showGlobalArchive = showArchive;
  window.goHome = goHome;

  document.addEventListener('DOMContentLoaded', function () {
    loadData().then(function () {
      initPlayer();
      bindUI();
      checkProtocol();
      updatePlayBtn();
      if (window.Progress) window.Progress.renderHub();
      // 调试接口（供自动化测试与现场排查使用，不影响正常功能）
      window.__ski = state;
    });
  });
})();
