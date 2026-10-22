/* ============================================================
 * injury3d.js — 损伤机理实验室（3D 交互模块）
 *
 * 功能：基于 Three.js（本地 vendor 引入，MIT 协议）构建可 360°
 * 旋转的滑雪者程序化模型，配合「致损因素」滑杆，可视化四类
 * 滑雪损伤的发生机理：膝关节前交叉韧带损伤、桡骨远端骨折、
 * 踝内翻扭伤、冻伤（血管收缩）。
 *
 * 依赖：js/vendor/three.min.js（r128）
 * 数据：data/injury3d.json（HTTP 优先，file:// 回退 data.js 内联）
 * 集成：app.js 顶栏按钮 / 知识卡「在 3D 实验室中查看」
 * ============================================================ */
(function () {
  'use strict';

  var DATA_URL = 'data/injury3d.json';
  var labData = null;

  /* ---------- 状态 ---------- */
  var S = {
    open: false,
    moduleId: null,
    value: 0,            // 0–100
    def: 15,
    stage: 0,
    auto: false, autoT: 0,
    anatomy: true,
    renderer: null, scene: null, camera: null,
    rig: null,           // 当前模块的场景对象
    focus: null,         // THREE.Vector3 相机注视点
    orbit: {
      yaw: 0.6, pitch: 0.14, dist: 1.0,
      tYaw: 0.6, tPitch: 0.14, tDist: 1.0,
      minDist: 0.35, maxDist: 3.0,
      dragging: false, lastX: 0, lastY: 0, idle: 0
    },
    pointers: {},
    pinchDist: 0,
    raf: 0, lastT: 0,
    flash: 0
  };

  var DISPLAY = {
    knee: function (v) { return Math.round(v) + '%'; },
    wrist: function (v) { return Math.round(v * 0.85) + '°'; },
    ankle: function (v) { return Math.round(v * 0.4) + '°'; },
    frostbite: function (v) { return '体感 -' + Math.round(v * 0.3) + '°C'; }
  };

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------- 数据装载（HTTP 优先，file:// 回退内联） ---------- */
  function loadData(cb) {
    if (labData) { cb(labData); return; }
    fetch(DATA_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { labData = d; cb(d); })
      .catch(function () {
        var d = window.__APP_DATA__ && window.__APP_DATA__.injury3d;
        if (d) { labData = d; cb(d); } else { cb(null); }
      });
  }

  /* ============================================================
   *  一、打开 / 关闭
   * ============================================================ */
  function open(moduleId) {
    loadData(function (d) {
      if (!d) { showNotice('损伤机理实验室数据加载失败，请检查 data/injury3d.json 是否存在。'); return; }
      if (typeof THREE === 'undefined') {
        showNotice('3D 引擎（three.min.js）加载失败，请确认 js/vendor/ 目录完整。');
        return;
      }
      var ids = d.modules.map(function (m) { return m.id; });
      S.moduleId = ids.indexOf(moduleId) >= 0 ? moduleId : ids[0];
      buildUI(d);
      switchModule(d, S.moduleId);
      S.open = true;
      var lp = $('labPoints');
      if (lp && window.Progress) lp.textContent = window.Progress._state.points;
      $('lab3d').classList.remove('hidden');
      showGuide();
      if (!S.raf) {
        S.lastT = performance.now();
        S.raf = requestAnimationFrame(tick);
      }
    });
  }

  function close() {
    S.open = false;
    S.auto = false;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    clearTimeout(guideTimer);
    var g = $('labGuide');
    if (g) { g.classList.add('hidden'); g.classList.remove('fading'); }
    if (S.renderer) {
      S.renderer.dispose();
      S.renderer = null;
    }
    S.scene = null; S.camera = null; S.rig = null;
    $('lab3d').classList.add('hidden');
    if (typeof onCloseCb === 'function') {
      var cb = onCloseCb; onCloseCb = null; cb();
    }
  }

  var onCloseCb = null;

  /* 进入实验室时的操作引导（5.5 秒后淡出） */
  var guideTimer = 0;
  function showGuide() {
    var g = $('labGuide');
    if (!g) return;
    g.classList.remove('hidden', 'fading');
    clearTimeout(guideTimer);
    guideTimer = setTimeout(function () {
      g.classList.add('fading');
      guideTimer = setTimeout(function () {
        g.classList.add('hidden');
        g.classList.remove('fading');
      }, 700);
    }, 5500);
  }

  /* 非阻塞提示（避免 alert 阻塞主线程） */
  function showNotice(msg) {
    var tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:1300;' +
      'max-width:560px;padding:12px 20px;border-radius:10px;' +
      'border:1px solid rgba(239,83,80,.5);background:rgba(40,12,12,.94);' +
      'color:#ffcdd2;font-size:13.5px;line-height:1.8;text-align:center;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.5)';
    tip.textContent = msg;
    document.body.appendChild(tip);
    setTimeout(function () {
      tip.style.transition = 'opacity .4s ease';
      tip.style.opacity = '0';
      setTimeout(function () { tip.remove(); }, 450);
    }, 3200);
  }

  /* ============================================================
   *  二、界面构建
   * ============================================================ */
  function buildUI(d) {
    var nav = $('labModules');
    nav.innerHTML = '';
    d.modules.forEach(function (m) {
      var b = document.createElement('button');
      b.className = 'lab-mod-btn';
      b.dataset.mid = m.id;
      b.innerHTML = '<span class="lab-mod-ic">' + esc(m.icon) + '</span>' +
        '<span class="lab-mod-tx"><strong>' + esc(m.name) + '</strong>' +
        '<small>' + esc(m.bodyPart) + '</small></span>';
      b.addEventListener('click', function () { switchModule(d, m.id); });
      nav.appendChild(b);
    });

    $('labDisclaimer').textContent = d.meta.disclaimer || '';
    $('labAnatomy').classList.toggle('on', S.anatomy);

    if (!$('lab3d').dataset.bound) {
      $('lab3d').dataset.bound = '1';
      $('labClose').addEventListener('click', function () {
        // 与视频模块「首页」一致：返回模块选择页
        if (typeof window.goHome === 'function') window.goHome();
        close();
      });
      $('labPlay').addEventListener('click', function () { playDemo(); });
      $('labReset').addEventListener('click', function () { resetModule(); });
      $('labAnatomy').addEventListener('click', function () {
        S.anatomy = !S.anatomy;
        this.classList.toggle('on', S.anatomy);
        applyAnatomy();
      });
      var labArch = $('labArchive');
      if (labArch) labArch.addEventListener('click', function () {
        if (typeof window.showGlobalArchive === 'function') window.showGlobalArchive();
        else if (window.Progress) window.Progress.showArchive();
      });
      $('labSlider').addEventListener('input', function () {
        S.auto = false;
        setValue(parseFloat(this.value));
      });
      bindOrbit($('labCanvas'));
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && S.open) {
          e.stopPropagation();
          if (typeof window.goHome === 'function') window.goHome();
          close();
        }
      }, true);
    }
  }

  function switchModule(d, mid) {
    var m = d.modules.filter(function (x) { return x.id === mid; })[0];
    if (!m) return;
    S.moduleId = mid;
    S.def = m.control.def;
    Array.prototype.forEach.call($('labModules').children, function (b) {
      b.classList.toggle('active', b.dataset.mid === mid);
    });

    /* 信息面板 */
    $('labModName').textContent = m.name;
    $('labMechanism').textContent = m.mechanism;
    $('labRisk').textContent = m.risk || '';
    $('labPrevention').innerHTML = (m.prevention || []).map(function (p) {
      return '<li>' + esc(p) + '</li>';
    }).join('');
    var refMap = {};
    (window.__APP_DATA__ && window.__APP_DATA__.content ? window.__APP_DATA__.content.refs : []).forEach(function (r) { refMap[r.id] = r.text; });
    $('labRefs').innerHTML = (m.refs || []).map(function (id) {
      return '<div class="lab-ref-item">· ' + esc(refMap[id] || id) + '</div>';
    }).join('');

    /* 控制面板 */
    $('labCtrlLabel').textContent = m.control.label;
    var slider = $('labSlider');
    slider.min = m.control.min;
    slider.max = m.control.max;
    slider.value = m.control.def;
    var safeW = m.control.safeMax, dangerW = m.control.dangerAt;
    $('labZones').innerHTML =
      '<div class="lab-zone safe" style="width:' + safeW + '%">安全区</div>' +
      '<div class="lab-zone warn" style="width:' + (dangerW - safeW) + '%">临界</div>' +
      '<div class="lab-zone danger" style="flex:1">损伤区</div>' +
      '<div id="labMarker" class="lab-marker"></div>';

    buildScene(d, m);
    setValue(m.control.def);

    /* 统一积分：模块首次探索 +10；刷新顶栏积分 */
    if (window.Progress) {
      window.Progress.award('lab-open:' + mid, 'lab', '探索「' + m.name + '」机理', 10);
      window.Progress._state.lab.opened[mid] = true;
      var lp = $('labPoints');
      if (lp) lp.textContent = window.Progress._state.points;
    }
  }

  /* ============================================================
   *  三、Three.js 场景
   * ============================================================ */
  var MATS = null;

  function buildScene(d, m) {
    var canvas = $('labCanvas');
    var wrap = $('labCanvasWrap');
    var w = Math.max(320, wrap.clientWidth), h = Math.max(240, wrap.clientHeight);

    if (S.renderer) { S.renderer.dispose(); }
    S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.setSize(w, h, false);

    S.scene = new THREE.Scene();
    S.camera = new THREE.PerspectiveCamera(40, w / h, 0.05, 60);

    MATS = {
      suit: new THREE.MeshStandardMaterial({ color: 0x33517a, roughness: .75, metalness: .05 }),
      suit2: new THREE.MeshStandardMaterial({ color: 0x24395e, roughness: .8, metalness: .05 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xe8b289, roughness: .85 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0xef5350, roughness: .45, metalness: .1 }),
      goggle: new THREE.MeshStandardMaterial({ color: 0x101a26, roughness: .25, metalness: .4 }),
      boot: new THREE.MeshStandardMaterial({ color: 0x181c22, roughness: .7 }),
      ski: new THREE.MeshStandardMaterial({ color: 0xffb300, roughness: .5 }),
      pole: new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: .4, metalness: .3 }),
      bone: new THREE.MeshStandardMaterial({ color: 0xf2e7d5, roughness: .6 }),
      boneDim: null,
      lig: new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: .7 }),
      ligHot: new THREE.MeshStandardMaterial({ color: 0xff5252, roughness: .6, emissive: 0x7f0000 }),
      vessel: new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: .6 }),
      ground: new THREE.MeshStandardMaterial({ color: 0xdbe7f2, roughness: 1 })
    };
    MATS.boneDim = MATS.bone.clone();

    /* 灯光 */
    S.scene.add(new THREE.HemisphereLight(0xbcd6f5, 0x5b6b7d, .95));
    var dir = new THREE.DirectionalLight(0xffffff, .85); dir.position.set(2.5, 4, 2.5);
    S.scene.add(dir);
    var fill = new THREE.DirectionalLight(0x9fc0ee, .35); fill.position.set(-2.5, 1.5, -1.5);
    S.scene.add(fill);

    /* 地面 */
    var ground = new THREE.Mesh(new THREE.CircleGeometry(3.2, 48), MATS.ground);
    ground.rotation.x = -Math.PI / 2;
    S.scene.add(ground);
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(1.16, 1.185, 64),
      new THREE.MeshBasicMaterial({ color: 0x9db8cf, transparent: true, opacity: .5, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002;
    S.scene.add(ring);

    /* 滑雪者模型 */
    var rig = buildSkier();
    S.rig = rig;
    S.scene.add(rig.group);

    /* 模块解剖结构 + 相机预设（dist 兼顾"看清部位"与"可见全身轮廓"） */
    S.focus = new THREE.Vector3();
    if (m.id === 'knee') {
      buildKneeAnatomy(rig);
      focusJoint(rig, 'knee', 1.55, 0.6, 0.12);
    } else if (m.id === 'wrist') {
      buildWristAnatomy(rig);
      focusJoint(rig, 'wrist', 1.3, 0.85, 0.18);
    } else if (m.id === 'ankle') {
      buildAnkleAnatomy(rig);
      focusJoint(rig, 'ankle', 1.2, 0.55, 0.14);
    } else if (m.id === 'frostbite') {
      buildFrostbiteAnatomy(rig);
      focusJoint(rig, 'head', 1.4, 0.35, 0.04);
    }

    /* 力度箭头 */
    if (m.id !== 'frostbite') {
      rig.arrow = makeArrow();
      rig.arrow.position.copy(S.focus);
      rig.group.add(rig.arrow);
      rig.arrowDir = { knee: new THREE.Vector3(1, 0, 0), wrist: new THREE.Vector3(0, 1, 0.4), ankle: new THREE.Vector3(-1, 0, 0) }[m.id];
    }

    applyAnatomy();
    updateCamera(true);
  }

  /* ---------- 滑雪者模型（程序化） ---------- */
  function buildSkier() {
    var G = { group: new THREE.Group(), joints: {}, dimParts: [], anaParts: [], flashParts: [] };
    var M = MATS;

    function mesh(geo, mat, x, y, z) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      return m;
    }

    /* 骨盆 / 躯干 / 头 */
    var pelvis = new THREE.Group(); pelvis.position.set(0, 0.96, 0); G.group.add(pelvis);
    pelvis.add(mesh(new THREE.SphereGeometry(0.14, 20, 16), M.suit));

    var torso = new THREE.Group(); torso.rotation.x = 0.10; pelvis.add(torso);
    var torsoMesh = mesh(new THREE.CylinderGeometry(0.155, 0.135, 0.5, 18), M.suit, 0, 0.25, 0);
    torso.add(torsoMesh);
    torso.add(mesh(new THREE.SphereGeometry(0.15, 20, 16), M.suit2, 0, 0.48, 0));
    torso.add(mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 10), M.skin, 0, 0.54, 0));
    var head = new THREE.Group(); head.position.set(0, 0.62, 0.01); torso.add(head);
    head.add(mesh(new THREE.SphereGeometry(0.115, 24, 18), M.skin));
    var helmet = mesh(new THREE.SphereGeometry(0.127, 24, 18), M.helmet, 0, 0.02, -0.005);
    helmet.scale.set(1, 0.92, 1); head.add(helmet);
    var gog = mesh(new THREE.BoxGeometry(0.2, 0.06, 0.05), M.goggle, 0, 0.015, 0.095);
    head.add(gog);
    torso.add(mesh(new THREE.BoxGeometry(0.22, 0.26, 0.1), M.suit2, 0, 0.32, -0.13)); // 背包
    G.joints.head = head;

    /* 右臂（抬起至面部附近；材质克隆后进入 dimParts，
       解剖透视时半透明，露出前臂骨骼——手腕模块的关键可见性） */
    var armSuit = M.suit.clone(), armSuit2 = M.suit2.clone(), armSkin = M.skin.clone();
    var shoulderR = new THREE.Group(); shoulderR.position.set(0.185, 0.44, 0.02); torso.add(shoulderR);
    var shMesh = mesh(new THREE.SphereGeometry(0.062, 14, 12), armSuit); shoulderR.add(shMesh);
    var uaMesh = mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.28, 12), armSuit, 0, -0.14, 0); shoulderR.add(uaMesh);
    var elbowR = new THREE.Group(); elbowR.position.set(0, -0.28, 0); elbowR.rotation.x = -1.9; shoulderR.add(elbowR);
    var elMesh = mesh(new THREE.SphereGeometry(0.05, 12, 10), armSuit); elbowR.add(elMesh);
    var faMesh = mesh(new THREE.CylinderGeometry(0.05, 0.042, 0.26, 12), armSuit, 0, -0.13, 0); elbowR.add(faMesh);
    var wristR = new THREE.Group(); wristR.position.set(0, -0.26, 0); elbowR.add(wristR);
    var wrMesh = mesh(new THREE.SphereGeometry(0.055, 16, 12), armSkin); wristR.add(wrMesh);
    for (var f = 0; f < 4; f++) {
      var fg = mesh(new THREE.CylinderGeometry(0.011, 0.009, 0.075, 6), armSkin,
        0.012 * (f % 2 ? 1 : -1) + 0.006 * (f > 1 ? 1 : -1), -0.055, 0.012 * (f < 2 ? 1 : -1));
      fg.rotation.x = -0.5; wristR.add(fg);
    }
    G.dimParts.push(armSuit, armSuit2, armSkin);
    G.joints.wrist = wristR; G.joints.elbow = elbowR;

    /* 左臂（持雪杖） */
    var shoulderL = new THREE.Group(); shoulderL.position.set(-0.185, 0.44, 0.02); torso.add(shoulderL);
    shoulderL.rotation.x = -0.55;
    shoulderL.add(mesh(new THREE.SphereGeometry(0.062, 14, 12), M.suit));
    shoulderL.add(mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.28, 12), M.suit, 0, -0.14, 0));
    var elbowL = new THREE.Group(); elbowL.position.set(0, -0.28, 0); elbowL.rotation.x = -0.55; shoulderL.add(elbowL);
    elbowL.add(mesh(new THREE.CylinderGeometry(0.05, 0.042, 0.26, 12), M.suit, 0, -0.13, 0));
    var handL = mesh(new THREE.SphereGeometry(0.055, 12, 10), M.skin, 0, -0.27, 0);
    elbowL.add(handL);
    var pole = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.95, 8), M.pole, 0, -0.75, 0.05);
    pole.rotation.x = 0.12; elbowL.add(pole);
    var basket = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.01, 12), M.pole, 0, -1.22, 0.08);
    elbowL.add(basket);

    /* 双腿（右腿带关节组，供解剖与动画） */
    G.joints.legs = { R: buildLeg(1), L: buildLeg(-1) };

    function buildLeg(side) {
      var hip = new THREE.Group(); hip.position.set(0.10 * side, -0.02, 0); pelvis.add(hip);
      hip.rotation.x = -0.32;
      var dim = side === 1 ? M.suit.clone() : M.suit;
      var dim2 = side === 1 ? M.suit2.clone() : M.suit2;
      hip.add(mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.46, 14), dim, 0, -0.23, 0));
      var knee = new THREE.Group(); knee.position.set(0, -0.46, 0); hip.add(knee);
      knee.rotation.x = -0.30;
      knee.add(mesh(new THREE.SphereGeometry(0.075, 14, 12), dim2));
      knee.add(mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.44, 14), dim, 0, -0.22, 0));
      var ankle = new THREE.Group(); ankle.position.set(0, -0.44, 0); knee.add(ankle);
      var foot = mesh(new THREE.BoxGeometry(0.095, 0.085, 0.26), M.boot, 0, -0.02, 0.07);
      ankle.add(foot);
      var ski = mesh(new THREE.BoxGeometry(0.115, 0.022, 1.45), M.ski, 0, -0.075, 0.28);
      ski.rotation.x = -0.06; ankle.add(ski);
      if (side === 1) G.dimParts.push(dim, dim2);
      return { hip: hip, knee: knee, ankle: ankle, foot: foot, ski: ski };
    }
    G.joints.legR = G.joints.legs.R;
    return G;
  }

  /* ---------- 模块一：膝关节 · 前交叉韧带 ---------- */
  function buildKneeAnatomy(rig) {
    var M = MATS, knee = rig.joints.legs.R.knee, hip = rig.joints.legs.R.hip;

    /* 股骨（静态，挂 hip，不随胫骨移动） */
    var femur = meshOf(new THREE.CylinderGeometry(0.052, 0.044, 0.34, 14), M.bone, 0.015, 0.14, 0);
    hip.add(femur);
    rig.anaParts.push(femur);

    /* 胫骨 + 腓骨（随胫骨平移动画，挂 knee） */
    var tibiaG = new THREE.Group(); knee.add(tibiaG);
    var tibia = meshOf(new THREE.CylinderGeometry(0.048, 0.036, 0.4, 14), M.bone, 0, -0.2, 0);
    tibiaG.add(tibia); rig.anaParts.push(tibia);
    var fibula = meshOf(new THREE.CylinderGeometry(0.016, 0.013, 0.38, 8), M.bone, -0.045, -0.19, 0);
    tibiaG.add(fibula); rig.anaParts.push(fibula);
    /* 髌骨（静态，挂 knee） */
    var patella = meshOf(new THREE.SphereGeometry(0.032, 12, 10), M.bone, 0.03, 0.01, 0.075);
    knee.add(patella); rig.anaParts.push(patella);

    /* 半月板（两片扁平椭球） */
    [0.012, -0.012].forEach(function (dx) {
      var men = meshOf(new THREE.SphereGeometry(0.038, 12, 8), M.bone, dx, -0.035, 0.01);
      men.scale.set(1, 0.35, 1.05); knee.add(men); rig.anaParts.push(men);
    });

    /* 前交叉韧带：股骨后上 → 胫骨前上（p2 随胫骨动） */
    var acl = meshOf(new THREE.CylinderGeometry(0.009, 0.009, 1, 8), M.lig.clone(), 0, 0, 0);
    knee.add(acl);
    rig.acl = { mesh: acl, p1: new THREE.Vector3(0.02, 0.03, -0.02), p2: new THREE.Vector3(0.0, -0.28, 0.03) };
    rig.anaParts.push(acl);
    /* 断裂残端 */
    rig.aclBroken = new THREE.Group(); knee.add(rig.aclBroken);
    var stub1 = meshOf(new THREE.CylinderGeometry(0.009, 0.006, 0.05, 8), M.ligHot.clone(), 0, 0, 0);
    stub1.position.copy(rig.acl.p1); rig.aclBroken.add(stub1);
    var stub2 = meshOf(new THREE.CylinderGeometry(0.006, 0.009, 0.05, 8), M.ligHot.clone(), 0, 0, 0);
    stub2.position.copy(rig.acl.p2); rig.aclBroken.add(stub2);
    rig.aclBroken.visible = false;
    rig.anaParts.push(rig.aclBroken);

    rig.tibiaG = tibiaG;
    rig.flashParts.push(acl);

    /* 标签 */
    addLabel('右膝关节', new THREE.Vector3(0.16, 0.02, 0), knee);
    addLabel('前交叉韧带', new THREE.Vector3(-0.15, -0.17, 0.05), knee);
  }

  /* ---------- 模块二：手腕 · 桡骨远端骨折 ---------- */
  function buildWristAnatomy(rig) {
    var M = MATS, elbow = rig.joints.elbow, wrist = rig.joints.wrist;

    /* 桡骨 / 尺骨（前臂内） */
    var radius = meshOf(new THREE.CylinderGeometry(0.03, 0.024, 0.24, 12), M.bone, 0.022, -0.12, 0);
    elbow.add(radius); rig.anaParts.push(radius);
    var ulna = meshOf(new THREE.CylinderGeometry(0.022, 0.018, 0.23, 10), M.bone, -0.028, -0.115, 0);
    elbow.add(ulna); rig.anaParts.push(ulna);
    /* 腕骨 cluster */
    for (var i = 0; i < 5; i++) {
      var c = meshOf(new THREE.SphereGeometry(0.016, 8, 8), M.bone,
        0.02 * (i % 2 ? 1 : -1), -0.01, 0.01 * (i < 2 ? 1 : -1));
      wrist.add(c); rig.anaParts.push(c);
    }
    /* 掌骨 */
    for (var f = 0; f < 4; f++) {
      var mc = meshOf(new THREE.CylinderGeometry(0.011, 0.01, 0.075, 6), M.bone,
        0.016 * (f % 2 ? 1 : -1), -0.05, 0.012 * (f < 2 ? 1 : -1));
      mc.rotation.x = -0.5; wrist.add(mc); rig.anaParts.push(mc);
    }

    /* 骨折标记（桡骨远端） */
    var fx = new THREE.Group(); elbow.add(fx);
    var fxBall = meshOf(new THREE.SphereGeometry(0.03, 12, 10), M.ligHot.clone(), 0.022, -0.235, 0);
    fx.add(fxBall);
    rig.fracture = { group: fx, ball: fxBall };
    rig.flashParts.push(fxBall);
    rig.anaParts.push(fx);

    addLabel('右腕', new THREE.Vector3(0.16, 0.03, 0.02), wrist);
    addLabel('桡骨远端', new THREE.Vector3(-0.15, -0.26, 0), elbow);
  }

  /* ---------- 模块三：踝关节 · 内翻扭伤 ---------- */
  function buildAnkleAnatomy(rig) {
    var M = MATS, knee = rig.joints.legs.R.knee, ankle = rig.joints.legs.R.ankle;

    /* 胫骨 / 腓骨（小腿下段，静态） */
    var tibia = meshOf(new THREE.CylinderGeometry(0.05, 0.042, 0.3, 12), M.bone, 0, -0.14, 0);
    knee.add(tibia); rig.anaParts.push(tibia);
    var fibula = meshOf(new THREE.CylinderGeometry(0.018, 0.015, 0.28, 8), M.bone, -0.05, -0.13, 0);
    knee.add(fibula); rig.anaParts.push(fibula);
    /* 距骨 + 跟骨（随足动） */
    var talus = meshOf(new THREE.SphereGeometry(0.04, 12, 10), M.bone, 0, -0.005, 0.01);
    ankle.add(talus); rig.anaParts.push(talus);
    var calcaneus = meshOf(new THREE.BoxGeometry(0.05, 0.045, 0.075), M.bone, 0, -0.02, -0.045);
    ankle.add(calcaneus); rig.anaParts.push(calcaneus);

    /* 距腓前韧带：腓骨下端 → 跟骨外侧（拉伸对象） */
    var lat = meshOf(new THREE.CylinderGeometry(0.007, 0.007, 1, 8), M.lig.clone(), 0, 0, 0);
    knee.add(lat);
    rig.ankleLig = { mesh: lat, p1: new THREE.Vector3(-0.05, -0.26, -0.01), p2: new THREE.Vector3(-0.045, -0.03, -0.05) };
    rig.flashParts.push(lat);
    rig.anaParts.push(lat);

    addLabel('右踝', new THREE.Vector3(0.13, 0, 0), ankle);
    addLabel('距腓前韧带', new THREE.Vector3(-0.14, -0.12, 0), knee);
  }

  /* ---------- 模块四：冻伤 · 血管收缩 ---------- */
  function buildFrostbiteAnatomy(rig) {
    var M = MATS, head = rig.joints.head, wrist = rig.joints.wrist;

    /* 面部血管（数条小管） */
    var faceVessels = [];
    var vp = [
      [[-0.05, 0.03, 0.10], [-0.06, -0.01, 0.09]],
      [[0.05, 0.03, 0.10], [0.06, -0.01, 0.09]],
      [[0, 0.06, 0.10], [0, 0.0, 0.115]],
      [[-0.08, 0.0, 0.06], [-0.09, -0.03, 0.07]],
      [[0.08, 0.0, 0.06], [0.09, -0.03, 0.07]]
    ];
    vp.forEach(function (pair) {
      var v = meshOf(new THREE.CylinderGeometry(0.005, 0.005, 1, 6), M.vessel.clone(), 0, 0, 0);
      head.add(v);
      faceVessels.push({ mesh: v, p1: new THREE.Vector3().fromArray(pair[0]), p2: new THREE.Vector3().fromArray(pair[1]) });
      rig.anaParts.push(v);
    });
    /* 手部血管 */
    var handVessels = [];
    for (var f = 0; f < 4; f++) {
      var v = meshOf(new THREE.CylinderGeometry(0.004, 0.004, 1, 6), M.vessel.clone(), 0, 0, 0);
      wrist.add(v);
      handVessels.push({
        mesh: v,
        p1: new THREE.Vector3(0.012 * (f % 2 ? 1 : -1), -0.02, 0.005),
        p2: new THREE.Vector3(0.02 * (f % 2 ? 1 : -1), -0.062, 0.016 * (f < 2 ? 1 : -1))
      });
      rig.anaParts.push(v);
    }
    rig.vessels = faceVessels.concat(handVessels);

    /* 冰晶粒子（面部 + 手部） */
    var pts = [];
    for (var i = 0; i < 90; i++) {
      var a = Math.random() * Math.PI * 2, b = Math.acos(2 * Math.random() - 1), r = 0.122;
      pts.push(new THREE.Vector3(
        r * Math.sin(b) * Math.cos(a), r * Math.cos(b), r * Math.sin(b) * Math.sin(a)));
    }
    for (var j = 0; j < 40; j++) {
      var a2 = Math.random() * Math.PI * 2, r2 = 0.06;
      pts.push(new THREE.Vector3(r2 * Math.cos(a2), -0.06 + (Math.random() - 0.5) * 0.06, r2 * Math.sin(a2)));
    }
    var pGeo = new THREE.BufferGeometry().setFromPoints(pts);
    var pMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.011, transparent: true, opacity: 0, depthWrite: false });
    var frostFace = new THREE.Points(pGeo, pMat); head.add(frostFace);
    var frostHand = new THREE.Points(pGeo.clone(), pMat.clone()); wrist.add(frostHand);
    rig.frost = { face: frostFace, hand: frostHand };
    rig.anaParts.push(frostFace, frostHand);

    addLabel('面部末梢', new THREE.Vector3(0.17, 0.05, 0), head);
    addLabel('手指末梢', new THREE.Vector3(0.11, -0.06, 0), wrist);
  }

  /* ---------- 通用小工具 ---------- */
  function meshOf(geo, mat, x, y, z) {
    var m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    return m;
  }

  function addLabel(text, pos, parent) {
    var c = document.createElement('canvas');
    c.width = 320; c.height = 96;
    var ctx = c.getContext('2d');
    ctx.font = 'bold 44px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(8,20,34,0.72)';
    ctx.fillRect(0, 22, 320, 52);
    ctx.fillStyle = '#bfe3ff';
    ctx.fillText(text, 160, 50);
    var tex = new THREE.CanvasTexture(c);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(0.27, 0.081, 1);
    sp.position.copy(pos);
    parent.add(sp);
    return sp;
  }

  function makeArrow() {
    var g = new THREE.Group();
    var m = new THREE.MeshBasicMaterial({ color: 0x69f0ae, transparent: true, opacity: .9 });
    var shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 1, 8), m);
    shaft.position.y = 0.5;
    var tip = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.06, 12), m);
    tip.position.y = 1.02;
    g.add(shaft); g.add(tip);
    g.userData.mat = m;
    return g;
  }

  function focusJoint(rig, key, dist, yaw, pitch) {
    var wp = new THREE.Vector3();
    if (key === 'knee') rig.joints.legs.R.knee.getWorldPosition(wp);
    else if (key === 'wrist') rig.joints.wrist.getWorldPosition(wp);
    else if (key === 'ankle') rig.joints.legs.R.ankle.getWorldPosition(wp);
    else if (key === 'head') rig.joints.head.getWorldPosition(wp);
    S.focus.copy(wp);
    S.orbit.tDist = S.orbit.dist = clamp(dist, S.orbit.minDist, S.orbit.maxDist);
    S.orbit.tYaw = S.orbit.yaw = yaw;
    S.orbit.tPitch = S.orbit.pitch = pitch;
  }

  /* 在两个点之间拉伸一个单位高度圆柱 */
  var _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _q = new THREE.Quaternion();
  function stretch(mesh, p1, p2, scaleY) {
    _d.subVectors(p2, p1);
    var len = _d.length() || 0.0001;
    mesh.position.copy(p1).addScaledVector(_d, 0.5);
    mesh.scale.set(1, len * (scaleY || 1), 1);
    mesh.quaternion.setFromUnitVectors(_up, _d.normalize());
  }

  /* ============================================================
   *  四、数值驱动（核心动画）
   * ============================================================ */
  function setValue(v) {
    v = clamp(v, 0, 100);
    S.value = v;
    var mod = currentModule();
    if (!mod) return;

    /* 阶段判定 */
    var st = 0;
    for (var i = 0; i < mod.stages.length; i++) {
      if (v <= mod.stages[i].max) { st = i; break; }
      st = i;
    }
    S.stage = st;

    /* 面板读数 */
    var disp = (DISPLAY[mod.id] || DISPLAY.knee)(v);
    $('labCtrlValue').textContent = disp;
    var marker = $('labMarker');
    if (marker) marker.style.left = v + '%';
    var stageEl = $('labStageText');
    stageEl.className = 'lab-stage-text stage-' + st;
    stageEl.innerHTML = '<strong>' + esc(mod.stages[st].title) + '</strong> · ' + esc(disp) +
      '<p>' + esc(mod.stages[st].desc) + '</p>';

    applyValue(mod, v);
  }

  function currentModule() {
    if (!labData) return null;
    return labData.modules.filter(function (m) { return m.id === S.moduleId; })[0] || null;
  }

  function applyValue(mod, v) {
    var t = v / 100;
    var rig = S.rig;
    if (!rig) return;
    var danger = v > mod.control.dangerAt;

    /* 统一积分：首次触发损伤阶段 +10（理解"损伤如何发生"） */
    if (danger && window.Progress && !window.Progress._state.lab.danger[mod.id]) {
      window.Progress._state.lab.danger[mod.id] = true;
      window.Progress.award('lab-danger:' + mod.id, 'lab', '触发「' + mod.name + '」损伤阶段', 10);
    }

    if (mod.id === 'knee') {
      /* 胫骨前移 + 韧带拉伸 */
      rig.tibiaG.position.x = 0.075 * t;
      var acl = rig.acl;
      var p2 = _tmp1.copy(acl.p2).add(_tmp2.set(0.075 * t, 0, 0));
      stretch(acl.mesh, acl.p1, p2, 1);
      /* 颜色：白 → 琥珀 → 红 */
      var c = acl.mesh.material.color;
      if (danger) c.setHex(0xd32f2f);
      else if (t > 0.55) c.setHex(0xffb300);
      else c.setHex(0xf5f5f5);
      acl.mesh.material.emissive.setRGB(danger ? 0.4 + S.flash * 0.4 : 0, 0, 0);
      acl.mesh.visible = !danger;
      rig.aclBroken.visible = danger;
      /* 整机轻微响应 */
      rig.joints.legs.R.knee.position.x = 0.02 * t;
    } else if (mod.id === 'wrist') {
      /* 手掌背屈（手腕向后折） */
      rig.joints.wrist.rotation.x = t * 1.5;
      var fx = rig.fracture;
      fx.group.visible = danger;
      fx.ball.material.emissive.setRGB(danger ? 0.5 + S.flash * 0.5 : 0, 0, 0);
      fx.ball.scale.setScalar(danger ? 1 + 0.25 * Math.sin(S.flash * Math.PI * 2) * 0.5 + 0.5 : 1);
    } else if (mod.id === 'ankle') {
      /* 足内翻 */
      rig.joints.legs.R.ankle.rotation.z = t * 0.7;
      var lig = rig.ankleLig;
      stretch(lig.mesh, lig.p1, lig.p2, 1);
      var lc = lig.mesh.material.color;
      if (danger) lc.setHex(0xd32f2f);
      else if (t > 0.5) lc.setHex(0xffb300);
      else lc.setHex(0xf5f5f5);
      lig.mesh.material.emissive.setRGB(danger ? 0.4 + S.flash * 0.4 : 0, 0, 0);
    } else if (mod.id === 'frostbite') {
      /* 肤色：正常 → 苍白 → 蜡白 */
      var skin = MATS.skin.color;
      if (danger) skin.setHex(0xdfe7ee);
      else if (t > 0.45) skin.lerpColors(_c1.setHex(0xe8b289), _c2.setHex(0xd9c3b0), (t - 0.45) / 0.25);
      else skin.setHex(0xe8b289);
      /* 血管收缩 */
      rig.vessels.forEach(function (v) {
        var m = v.mesh.material;
        m.color.setHex(danger ? 0x5d1a1a : (t > 0.45 ? 0x8e2f2f : 0xc62828));
        var rr = danger ? 0.35 : (1 - t * 0.5);
        stretch(v.mesh, v.p1, v.p2, rr);
      });
      /* 冰晶 */
      rig.frost.face.material.opacity = clamp((t - 0.25) * 1.4, 0, 0.95);
      rig.frost.hand.material.opacity = clamp((t - 0.35) * 1.6, 0, 0.95);
    }

    /* 力度箭头 */
    if (rig.arrow) {
      rig.arrow.visible = true;
      rig.arrow.scale.set(1, 0.12 + 0.55 * t, 1);
      rig.arrow.quaternion.setFromUnitVectors(_up, rig.arrowDir);
      var am = rig.arrow.userData.mat;
      am.color.setHex(danger ? 0xff5252 : (t > 0.55 ? 0xffd54f : 0x69f0ae));
      am.opacity = 0.55 + 0.4 * t;
    }

    /* 危险脉冲 */
    if (danger) S.flash = (S.flash + 0.03) % 1;
  }

  var _tmp1 = new THREE.Vector3(), _tmp2 = new THREE.Vector3();
  var _c1 = new THREE.Color(), _c2 = new THREE.Color();

  /* 解剖透视开关 */
  function applyAnatomy() {
    var rig = S.rig;
    if (!rig) return;
    var mod = currentModule();
    var danger = mod ? (S.value > mod.control.dangerAt) : false;
    rig.dimParts.forEach(function (m) {
      m.transparent = S.anatomy;
      m.opacity = S.anatomy ? 0.22 : 1;
      m.depthWrite = !S.anatomy;
    });
    rig.anaParts.forEach(function (o) { o.visible = S.anatomy; });
    /* 断裂/骨折标记只在损伤阶段显示 */
    if (rig.aclBroken) rig.aclBroken.visible = S.anatomy && danger;
    if (rig.fracture) rig.fracture.group.visible = S.anatomy && danger;
  }

  /* ============================================================
   *  五、主循环 / 相机 / 输入
   * ============================================================ */
  function tick(now) {
    S.raf = requestAnimationFrame(tick);
    var dt = Math.min(0.05, (now - S.lastT) / 1000);
    S.lastT = now;

    /* 自动演示 */
    if (S.auto) {
      S.autoT += dt;
      var v = clamp(S.autoT / 4.5 * 100, 0, 100);
      setValue(v);
      $('labSlider').value = v;
      if (S.autoT > 7.5) {
        S.auto = false;
        setValue(S.def);
        $('labSlider').value = S.def;
        $('labPlay').textContent = '▶ 播放演示';
      }
    } else {
      applyValue(currentModule(), S.value);
    }

    /* 空闲缓慢自转 */
    if (!S.orbit.dragging) {
      S.orbit.idle += dt;
      if (S.orbit.idle > 2.5) S.orbit.tYaw += dt * 0.06;
    }

    updateCamera(false);
    if (S.renderer && S.scene) S.renderer.render(S.scene, S.camera);
  }

  function updateCamera(immediate) {
    var o = S.orbit, k = immediate ? 1 : 0.12;
    o.yaw += (o.tYaw - o.yaw) * k;
    o.pitch += (o.tPitch - o.pitch) * k;
    o.dist += (o.tDist - o.dist) * k;
    var cp = Math.cos(o.pitch), sp = Math.sin(o.pitch);
    S.camera.position.set(
      S.focus.x + o.dist * cp * Math.sin(o.yaw),
      S.focus.y + o.dist * sp + 0.04,
      S.focus.z + o.dist * cp * Math.cos(o.yaw)
    );
    S.camera.lookAt(S.focus);
  }

  function bindOrbit(canvas) {
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', function (e) {
      S.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(S.pointers).length === 1) {
        S.orbit.dragging = true;
        S.orbit.lastX = e.clientX;
        S.orbit.lastY = e.clientY;
      } else if (Object.keys(S.pointers).length === 2) {
        var ks = Object.keys(S.pointers);
        S.pinchDist = Math.hypot(S.pointers[ks[0]].x - S.pointers[ks[1]].x,
          S.pointers[ks[0]].y - S.pointers[ks[1]].y);
      }
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', function (e) {
      if (!S.pointers[e.pointerId]) return;
      S.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(S.pointers);
      if (ids.length >= 2) {
        var d = Math.hypot(S.pointers[ids[0]].x - S.pointers[ids[1]].x,
          S.pointers[ids[0]].y - S.pointers[ids[1]].y);
        if (S.pinchDist > 0) {
          S.orbit.tDist = clamp(S.orbit.tDist * (S.pinchDist / d), S.orbit.minDist, S.orbit.maxDist);
        }
        S.pinchDist = d;
        return;
      }
      if (!S.orbit.dragging) return;
      var dx = e.clientX - S.orbit.lastX, dy = e.clientY - S.orbit.lastY;
      S.orbit.lastX = e.clientX; S.orbit.lastY = e.clientY;
      S.orbit.tYaw -= dx * 0.008;
      S.orbit.tPitch = clamp(S.orbit.tPitch + dy * 0.006, -0.85, 0.95);
      S.orbit.idle = 0;
    });

    function endPtr(e) {
      delete S.pointers[e.pointerId];
      if (Object.keys(S.pointers).length < 2) S.pinchDist = 0;
      if (Object.keys(S.pointers).length === 0) S.orbit.dragging = false;
    }
    canvas.addEventListener('pointerup', endPtr);
    canvas.addEventListener('pointercancel', endPtr);

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      S.orbit.tDist = clamp(S.orbit.tDist * (1 + e.deltaY * 0.0012), S.orbit.minDist, S.orbit.maxDist);
      S.orbit.idle = 0;
    }, { passive: false });

    window.addEventListener('resize', function () {
      if (!S.open || !S.renderer) return;
      var wrap = $('labCanvasWrap');
      var w = Math.max(320, wrap.clientWidth), h = Math.max(240, wrap.clientHeight);
      S.renderer.setSize(w, h, false);
      S.camera.aspect = w / h;
      S.camera.updateProjectionMatrix();
    });
  }

  /* ---------- 演示 / 重置 ---------- */
  function playDemo() {
    S.auto = true;
    S.autoT = 0;
    $('labPlay').textContent = '⏸ 演示中…';
    /* 统一积分：首次播放演示 +5 */
    if (window.Progress) {
      window.Progress.award('lab-demo:' + S.moduleId, 'lab', '播放「' +
        (currentModule() ? currentModule().name : '') + '」自动演示', 5);
      window.Progress._state.lab.demo[S.moduleId] = true;
    }
  }

  function resetModule() {
    S.auto = false;
    $('labPlay').textContent = '▶ 播放演示';
    setValue(S.def);
    $('labSlider').value = S.def;
  }

  /* ---------- 暴露 ---------- */
  window.Lab3D = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    onClose: function (cb) { onCloseCb = cb; }
  };
})();
