/* ============================================================
 * ski3d.js — 全景滑雪场（3D 沉浸式学习模块）
 *
 * 基于 Blender 构建的低多边形雪场（assets/models/ski_slope.glb），
 * 第三人称跟随视角，沿雪道滑行并经过 5 个学习站点，
 * 融合视频模块的知识卡、测验模块的答题与 3D 实验室的损伤机理。
 *
 * 坐标系（与 Blender 构建脚本严格一致）：
 *   Blender: X=横向, Y=顺坡向下, Z=高度
 *   本模块 three.js 世界: x=bx, y=bz(高度), z=-by
 *
 * 依赖：js/vendor/three.min.js + js/vendor/GLTFLoader.js
 * 数据：data/ski3d.json（HTTP 优先，file:// 回退 data.js 内联）
 * 积分：window.Progress（站点 +15，通关 +50）
 * ============================================================ */
(function () {
  'use strict';

  var DATA_URL = 'data/ski3d.json';
  var MODEL_URL = 'assets/models/ski_slope.glb';

  /* ============================================================
   * 一、地形函数（与 Blender build_ski_scene.py 完全一致）
   * ========================================================== */
  var BUMPS = [[-6.0, -18.0, 0.55, 5.0], [9.0, 6.0, 0.65, 6.0],
               [-11.0, 26.0, 0.5, 5.5], [4.0, -40.0, 0.45, 4.5]];

  function pathX(by) { return 5.5 * Math.sin((by + 60.0) * 0.045); }

  function elevB(bx, by) {
    var h = 2.8 * (1.0 - (by + 60.0) / 100.0);
    h += 0.38 * Math.sin(by * 0.21) + 0.20 * Math.sin(by * 0.52 + 1.7);
    h += 0.14 * Math.sin(bx * 0.85 + by * 0.08);
    h += 0.07 * Math.sin(bx * 2.1 + by * 1.05) * Math.cos(bx * 1.2 - by * 0.6);
    for (var i = 0; i < BUMPS.length; i++) {
      var b = BUMPS[i];
      var d2 = (bx - b[0]) * (bx - b[0]) + (by - b[1]) * (by - b[1]);
      h += b[2] * Math.exp(-d2 / (2 * b[3] * b[3]));
    }
    return h;
  }

  /** three.js 世界坐标 → 地形高度 */
  function elev(x, z) { return elevB(x, -z); }

  /** 地形法线（有限差分） */
  var _n = { x: 0, y: 1, z: 0 };
  function normalAt(x, z) {
    var e = 0.6;
    var hL = elev(x - e, z), hR = elev(x + e, z);
    var hD = elev(x, z - e), hU = elev(x, z + e);
    var nx = hL - hR, ny = 2 * e, nz = hD - hU;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    _n.x = nx / len; _n.y = ny / len; _n.z = nz / len;
    return _n;
  }

  /* ============================================================
   * 二、状态
   * ========================================================== */
  var S = {
    open: false,
    data: null,
    scene: null, camera: null, renderer: null,
    skier: null,
    stationObjs: [],
    snow: null, snowGeo: null,
    pos: { x: 0, z: 60 },
    yaw: Math.PI,
    speed: 0,
    steer: 0, throttle: 0,
    maxSpeed: 15,
    camPos: null, camLook: null,
    atStation: -1,
    stationDone: {},
    suppressStation: -1,   // 刚关闭面板的站点：离开半径前不再触发
    fall: null,
    finished: false,
    startAt: 0,
    keys: {},
    touchSteer: 0, touchThrottle: false,
    raf: 0, lastT: 0,
    clock: 0,
    warnUntil: 0
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ============================================================
   * 三、数据装载
   * ========================================================== */
  function loadData(cb) {
    if (S.data) { cb(S.data); return; }
    fetch(DATA_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) { S.data = d; cb(d); })
      .catch(function () {
        var d = window.__APP_DATA__ && window.__APP_DATA__.ski3d;
        if (d) { S.data = d; cb(d); } else { cb(null); }
      });
  }

  /* ============================================================
   * 四、界面骨架
   * ========================================================== */
  function buildShell() {
    var root = $('ski3d');
    root.innerHTML =
      '<div id="skiCanvasWrap" class="ski-canvas-wrap">' +
      '  <canvas id="skiCanvas"></canvas>' +
      '  <div id="skiWarn" class="ski-warn hidden">已滑出雪道范围，请往雪道方向回正</div>' +
      '</div>' +
      '<header class="ski-top">' +
      '  <div class="ski-title"><span class="ski-title-ic">🏔️</span>' +
      '    <span><strong>全景滑雪场</strong><small>第三人称 · 5 个学习站点</small></span></div>' +
      '  <div id="skiStationDots" class="ski-dots"></div>' +
      '  <div class="ski-top-right">' +
      '    <div class="score-chip" title="统一积分">' +
      '      <span class="score-label">积分</span><span id="skiPoints">0</span>' +
      '    </div>' +
      '    <button id="skiArchive" class="btn btn-sm">📊 学习档案</button>' +
      '    <button id="skiClose" class="btn btn-sm btn-ghost">首页</button>' +
      '  </div>' +
      '</header>' +
      '<div class="ski-speed"><span id="skiSpeedVal">0</span><small>km/h</small></div>' +
      '<div id="skiCtrlHint" class="ski-ctrl-hint">⌨ A / D 或 ← / → 转向 · W / ↑ 加速 · S / ↓ 减速 · 触屏：左右半屏转向（自动前进）· Esc 退出</div>' +
      '<div id="skiHint" class="ski-hint hidden"></div>' +
      '<canvas id="skiMinimap" class="ski-minimap" width="150" height="180"></canvas>' +
      '<div id="skiPanel" class="ski-panel hidden"></div>' +
      '<div id="skiIntro" class="ski-intro hidden"></div>';
  }

  function buildDots() {
    var box = $('skiStationDots');
    box.innerHTML = '';
    (S.data ? S.data.stations : []).forEach(function (st) {
      var d = document.createElement('span');
      d.className = 'ski-dot';
      d.id = 'skiDot' + st.id;
      d.textContent = st.icon;
      d.title = st.name;
      box.appendChild(d);
    });
  }

  function refreshHUD() {
    var P = window.Progress;
    if (P) $('skiPoints').textContent = P._state.points;
    (S.data ? S.data.stations : []).forEach(function (st) {
      var d = $('skiDot' + st.id);
      if (d) d.classList.toggle('done', !!S.stationDone[st.id]);
    });
  }

  /* ============================================================
   * 五、Three.js 场景
   * ========================================================== */
  var MATS = null;

  function initScene() {
    var canvas = $('skiCanvas');
    var wrap = $('skiCanvasWrap');
    var w = wrap.clientWidth || window.innerWidth;
    var h = wrap.clientHeight || window.innerHeight;

    S.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.setSize(w, h, false);

    S.scene = new THREE.Scene();
    S.scene.background = new THREE.Color(0xa8d4f0);
    S.scene.fog = new THREE.FogExp2(0xcfe4f5, 0.011);

    S.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 400);
    S.camPos = new THREE.Vector3();
    S.camLook = new THREE.Vector3();

    MATS = {
      suit: new THREE.MeshStandardMaterial({ color: 0x33517a, roughness: .75 }),
      suit2: new THREE.MeshStandardMaterial({ color: 0x24395e, roughness: .8 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xe8b289, roughness: .85 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0xef5350, roughness: .45 }),
      goggle: new THREE.MeshStandardMaterial({ color: 0x101a26, roughness: .25, metalness: .4 }),
      boot: new THREE.MeshStandardMaterial({ color: 0x181c22, roughness: .7 }),
      ski: new THREE.MeshStandardMaterial({ color: 0xffb300, roughness: .5 }),
      pole: new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: .4, metalness: .3 })
    };

    S.scene.add(new THREE.HemisphereLight(0xffffff, 0x8fb3d9, 0.95));
    var sun = new THREE.DirectionalLight(0xfff2dd, 0.85);
    sun.position.set(40, 60, 30);
    S.scene.add(sun);

    /* 雪花粒子 */
    var N = 900;
    var pos = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 1] = Math.random() * 26;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
    }
    S.snowGeo = new THREE.BufferGeometry();
    S.snowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    S.snow = new THREE.Points(S.snowGeo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.16, transparent: true, opacity: 0.9,
      depthWrite: false, sizeAttenuation: true
    }));
    S.scene.add(S.snow);

    S.skier = buildSkier();
    S.scene.add(S.skier.group);

    if (typeof THREE.GLTFLoader === 'undefined') {
      showNotice('3D 模型加载器缺失：请确认 js/vendor/GLTFLoader.js 存在。');
      return;
    }
    var loader = new THREE.GLTFLoader();
    loader.load(MODEL_URL, function (gltf) {
      var model = gltf.scene;
      model.traverse(function (o) {
        if (o.isMesh) { o.frustumCulled = true; }
      });
      S.scene.add(model);
      S.stationObjs = [];
      for (var i = 0; i < 5; i++) {
        var st = model.getObjectByName('Station_' + i);
        if (st) S.stationObjs.push(st);
      }
      placeSkierAtStart();
    }, undefined, function () {
      showNotice('雪场模型加载失败（' + MODEL_URL + '）。若通过 file:// 打开，请改用「启动预览.command」运行本地服务。');
    });
  }

  /* ---------- 滑雪者模型（程序化，含关节） ---------- */
  function buildSkier() {
    var M = MATS;
    var G = { group: new THREE.Group(), joints: {} };

    function mesh(geo, mat, x, y, z) {
      var m = new THREE.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      return m;
    }

    var pelvis = new THREE.Group(); pelvis.position.y = 0.92; G.group.add(pelvis);
    pelvis.add(mesh(new THREE.SphereGeometry(0.13, 14, 10), M.suit));
    var torso = new THREE.Group(); torso.rotation.x = 0.28; pelvis.add(torso);
    torso.add(mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.5, 14), M.suit, 0, 0.25, 0));
    torso.add(mesh(new THREE.SphereGeometry(0.14, 14, 12), M.suit2, 0, 0.48, 0));
    var head = new THREE.Group(); head.position.set(0, 0.62, 0.01); torso.add(head);
    head.add(mesh(new THREE.SphereGeometry(0.11, 18, 14), M.skin));
    var helmet = mesh(new THREE.SphereGeometry(0.122, 18, 14), M.helmet, 0, 0.02, -0.005);
    helmet.scale.set(1, 0.92, 1); head.add(helmet);
    head.add(mesh(new THREE.BoxGeometry(0.19, 0.055, 0.05), M.goggle, 0, 0.015, 0.09));
    G.joints.head = head; G.joints.torso = torso; G.joints.pelvis = pelvis;

    [-1, 1].forEach(function (side) {
      var sh = new THREE.Group(); sh.position.set(0.17 * side, 0.44, 0.02); torso.add(sh);
      sh.add(mesh(new THREE.SphereGeometry(0.058, 10, 8), M.suit));
      sh.add(mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.26, 10), M.suit, 0, -0.13, 0));
      var el = new THREE.Group(); el.position.set(0, -0.26, 0); el.rotation.x = -0.85; sh.add(el);
      el.add(mesh(new THREE.SphereGeometry(0.045, 10, 8), M.suit));
      el.add(mesh(new THREE.CylinderGeometry(0.045, 0.038, 0.24, 10), M.suit, 0, -0.12, 0));
      var wr = new THREE.Group(); wr.position.set(0, -0.24, 0); el.add(wr);
      wr.add(mesh(new THREE.SphereGeometry(0.05, 12, 10), M.skin));
      var pole = mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.0, 6), M.pole, 0, -0.5, 0.16);
      wr.add(pole);
      wr.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 10), M.pole, 0, -1.0, 0.2));
    });

    G.joints.legs = [];
    [-1, 1].forEach(function (side) {
      var hip = new THREE.Group(); hip.position.set(0.10 * side, -0.02, 0); pelvis.add(hip);
      hip.rotation.x = -0.55;
      hip.add(mesh(new THREE.CylinderGeometry(0.082, 0.068, 0.44, 12), M.suit, 0, -0.22, 0));
      var knee = new THREE.Group(); knee.position.set(0, -0.44, 0); hip.add(knee);
      knee.rotation.x = -0.75;
      knee.add(mesh(new THREE.SphereGeometry(0.07, 12, 10), M.suit2));
      knee.add(mesh(new THREE.CylinderGeometry(0.068, 0.05, 0.42, 12), M.suit, 0, -0.21, 0));
      var ankle = new THREE.Group(); ankle.position.set(0, -0.42, 0); knee.add(ankle);
      ankle.add(mesh(new THREE.BoxGeometry(0.09, 0.08, 0.24), M.boot, 0, -0.02, 0.06));
      var ski = mesh(new THREE.BoxGeometry(0.11, 0.02, 1.5), M.ski, 0, -0.07, 0.3);
      ski.rotation.x = -0.05; ankle.add(ski);
      G.joints.legs.push({ hip: hip, knee: knee, ankle: ankle, side: side });
    });

    return G;
  }

  function placeSkierAtStart() {
    S.pos.x = pathX(-60); S.pos.z = 60;
    S.yaw = Math.PI;
    S.speed = 0;
    S.atStation = -1;
    S.fall = null;
    S.finished = false;
    S.startAt = performance.now();
    var g = S.skier.group;
    g.position.set(S.pos.x, elev(S.pos.x, S.pos.z), S.pos.z);
    g.rotation.set(0, S.yaw, 0);
    updateCameraTransform(1);
  }

  /* ============================================================
   * 六、输入
   * ========================================================== */
  function bindInput() {
    window.addEventListener('keydown', function (e) {
      if (!S.open) return;
      S.keys[e.key.toLowerCase()] = true;
      if (e.key === 'Escape' && S.atStation < 0) {
        e.stopPropagation();
        if (typeof window.goHome === 'function') window.goHome();
        close();
      }
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(e.key.toLowerCase()) >= 0) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', function (e) {
      S.keys[e.key.toLowerCase()] = false;
    });

    var wrap = $('skiCanvasWrap');
    function ts(e) {
      if (!S.open || S.atStation >= 0) return;
      S.touchThrottle = true;
      S.touchSteer = (e.touches[0].clientX < window.innerWidth / 2) ? -1 : 1;
    }
    function tm(e) {
      if (!S.touchThrottle) return;
      S.touchSteer = (e.touches[0].clientX < window.innerWidth / 2) ? -1 : 1;
    }
    function te() { S.touchThrottle = false; S.touchSteer = 0; }
    wrap.addEventListener('touchstart', ts, { passive: true });
    wrap.addEventListener('touchmove', tm, { passive: true });
    wrap.addEventListener('touchend', te);
    wrap.addEventListener('touchcancel', te);

    window.addEventListener('resize', function () {
      if (!S.open || !S.renderer) return;
      var w = wrap.clientWidth, h = wrap.clientHeight;
      S.renderer.setSize(w, h, false);
      S.camera.aspect = w / h;
      S.camera.updateProjectionMatrix();
    });
  }

  function readInput() {
    var k = S.keys;
    var steer = 0, throttle = 0;
    if (k['a'] || k['arrowleft']) steer -= 1;
    if (k['d'] || k['arrowright']) steer += 1;
    if (k['w'] || k['arrowup'] || k[' ']) throttle += 1;
    if (k['s'] || k['arrowdown']) throttle -= 1;
    if (S.touchThrottle) { throttle = 1; steer = S.touchSteer; }
    S.steer = clamp(steer, -1, 1);
    S.throttle = clamp(throttle, -1, 1);
  }

  /* ============================================================
   * 七、运动与相机
   * ========================================================== */
  function updateMotion(dt) {
    if (S.fall) { updateFall(dt); return; }
    if (S.atStation >= 0) {
      S.speed *= Math.max(0, 1 - dt * 6);
      return;
    }

    var accel = 7.5, brake = 14, drag = 1.6;
    if (S.throttle > 0) S.speed += S.throttle * accel * dt;
    else if (S.throttle < 0) S.speed += S.throttle * brake * dt;
    else S.speed -= drag * dt * (S.speed > 0.2 ? 1 : 0);
    var n = normalAt(S.pos.x, S.pos.z);
    var slopeFactor = clamp(-n.z, -1, 1);
    S.speed += slopeFactor * 2.2 * dt;
    S.speed = clamp(S.speed, 0, S.maxSpeed);

    var turnRate = 1.5 * (0.35 + 0.65 * (S.speed / S.maxSpeed));
    S.yaw += S.steer * turnRate * dt;

    var fx = Math.sin(S.yaw), fz = Math.cos(S.yaw);
    S.pos.x += fx * S.speed * dt;
    S.pos.z += fz * S.speed * dt;

    var by = -S.pos.z;
    var off = S.pos.x - pathX(by);
    if (Math.abs(off) > 24) {
      S.pos.x -= (Math.abs(off) - 24) * Math.sign(off) * Math.min(1, dt * 3);
      if (performance.now() > S.warnUntil) {
        S.warnUntil = performance.now() + 2500;
        $('skiWarn').classList.remove('hidden');
        setTimeout(function () { $('skiWarn').classList.add('hidden'); }, 2200);
      }
    }
    S.pos.x = clamp(S.pos.x, -40, 40);
    S.pos.z = clamp(S.pos.z, -48, 62);

    applySkierTransform(dt);
    checkStations();
    checkFinish();
  }

  function applySkierTransform(dt) {
    var g = S.skier.group;
    g.position.set(S.pos.x, elev(S.pos.x, S.pos.z), S.pos.z);
    var dy = S.yaw - g.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    g.rotation.y += dy * Math.min(1, dt * 8);

    var n = normalAt(S.pos.x, S.pos.z);
    g.rotation.x = Math.atan2(n.z, n.y) * 0.8;
    g.rotation.z = -Math.atan2(n.x, n.y) * 0.8;

    var v = S.speed / S.maxSpeed;
    var legs = S.skier.joints.legs;
    for (var i = 0; i < legs.length; i++) {
      legs[i].hip.rotation.x = -0.55 - v * 0.25;
      legs[i].knee.rotation.x = -0.75 - v * 0.35;
    }
    S.skier.joints.pelvis.position.y = 0.92 - v * 0.12;
    S.skier.joints.torso.rotation.x = 0.28 + v * 0.22;

    var plowing = (S.throttle < 0 || S.speed < 3) ? 1 : 0;
    for (var j = 0; j < legs.length; j++) {
      legs[j].ankle.rotation.y = legs[j].side * plowing * 0.45;
    }

    updateCameraTransform(0);
  }

  var _tv = new THREE.Vector3();
  function updateCameraTransform(immediate) {
    var g = S.skier.group;
    var fx = Math.sin(S.yaw), fz = Math.cos(S.yaw);
    var dist = 6.2 + S.speed * 0.16;
    var height = 2.6 + S.speed * 0.05;
    var tx = g.position.x - fx * dist;
    var tz = g.position.z - fz * dist;
    var ty = elev(tx, tz) + height;
    var k = immediate ? 1 : 0.06;
    _tv.set(tx, ty, tz);
    S.camPos.lerp(_tv, k);
    S.camera.position.copy(S.camPos);
    _tv.set(g.position.x + fx * 3.5, g.position.y + 1.15, g.position.z + fz * 3.5);
    S.camLook.lerp(_tv, k);
    S.camera.lookAt(S.camLook);
  }

  /* ---------- 摔倒动画（站点 3） ---------- */
  function startFall() { S.fall = { t: 0, dur: 4.2 }; }

  function updateFall(dt) {
    var f = S.fall;
    f.t += dt;
    var g = S.skier.group;
    S.speed *= Math.max(0, 1 - dt * 4);
    var t = f.t;

    if (t < 1.2) {
      var p = t / 1.2;
      g.rotation.x = 1.15 * p;
      S.skier.joints.pelvis.position.y = 0.92 - 0.55 * p;
      S.skier.joints.torso.rotation.x = 0.28 + 0.9 * p;
      var legs = S.skier.joints.legs;
      for (var i = 0; i < legs.length; i++) {
        legs[i].hip.rotation.x = -0.55 - 0.5 * p;
        legs[i].knee.rotation.x = -0.75 - 0.8 * p;
      }
    } else {
      var gx = g.position.x + Math.cos(S.yaw) * 0.1;
      var gz = g.position.z - Math.sin(S.yaw) * 0.1;
      _tv.set(gx, g.position.y + 0.42, gz);
      S.camLook.lerp(_tv, Math.min(1, dt * 3));
      _tv.set(_tv.x + Math.cos(S.yaw) * 1.5, _tv.y + 0.75, _tv.z - Math.sin(S.yaw) * 1.5);
      S.camPos.lerp(_tv, Math.min(1, dt * 3));
      S.camera.position.copy(S.camPos);
      S.camera.lookAt(S.camLook);
      S.camera.position.x += (Math.random() - 0.5) * 0.012;
      S.camera.position.y += (Math.random() - 0.5) * 0.012;
    }

    if (t >= f.dur) {
      S.fall = null;
      g.rotation.x = 0;
      S.skier.joints.pelvis.position.y = 0.92;
      S.skier.joints.torso.rotation.x = 0.28;
      openStationPanel(3);
    }
  }

  /* ============================================================
   * 八、站点逻辑
   * ========================================================== */
  function checkStations() {
    if (!S.data) return;
    for (var i = 0; i < S.data.stations.length; i++) {
      var st = S.data.stations[i];
      var bx = pathX(st.bz), bz = -st.bz;
      var dx = S.pos.x - bx, dz = S.pos.z - bz;
      var d2 = dx * dx + dz * dz;
      // 冷却中的站点：需离开 6m 后才恢复触发
      if (S.suppressStation === st.id) {
        if (d2 < 36) continue;
        S.suppressStation = -1;
      }
      if (d2 < 12.25) {
        S.atStation = st.id;
        if (st.interaction && st.interaction.type === 'injury') startFall();
        else openStationPanel(st.id);
        return;
      }
    }
  }

  function checkFinish() {
    if (S.finished) return;
    if (S.pos.z < -43) {
      S.finished = true;
      showFinishPanel();
    }
  }

  /* ---------- 站点面板 ---------- */
  function openStationPanel(id) {
    var st = S.data.stations.filter(function (s) { return s.id === id; })[0];
    if (!st) return;
    var doneCount = Object.keys(S.stationDone).length;
    var panel = $('skiPanel');
    panel.classList.remove('hidden');

    var k = st.knowledge;
    var html =
      '<div class="sp-head">' +
      '  <span class="sp-icon">' + st.icon + '</span>' +
      '  <div class="sp-title"><strong>' + esc(st.name) + '</strong>' +
      '    <small>站点 ' + (id + 1) + ' / ' + S.data.stations.length + ' · 已完成 ' + doneCount + ' 个</small></div>' +
      '  <button class="sp-skip" id="spSkip">稍后再学</button>' +
      '</div>' +
      '<div class="sp-body">' +
      '  <p class="sp-welcome">' + esc(st.welcome) + '</p>' +
      '  <div class="sp-know">' +
      '    <div class="sp-know-sum">' + esc(k.summary) + '</div>' +
      '    <ul class="sp-know-list">' + k.points.map(function (p) {
            return '<li>' + esc(p) + '</li>';
          }).join('') + '</ul>' +
      '  </div>' +
      '  <div class="sp-inter" id="spInter"></div>' +
      '  <div class="sp-quiz" id="spQuiz"></div>' +
      '  <div class="sp-actions" id="spActions"></div>' +
      '</div>';
    panel.innerHTML = html;
    $('spSkip').addEventListener('click', closeStationPanel);

    renderInteraction(st);
    refreshHUD();
  }

  function renderInteraction(st) {
    var box = $('spInter');
    var it = st.interaction;
    if (!it) { finishInteraction(st); return; }

    var html = '<h4 class="sp-sec-title">🎯 ' + esc(it.title) + '</h4>';
    if (it.type === 'checklist') {
      html += '<div class="sp-checklist">' + it.items.map(function (item, i) {
        return '<button class="sp-check-item" data-i="' + i + '">' +
          '<span class="sp-check-box"></span><span>' + esc(item.label) + '</span></button>';
      }).join('') + '</div><div class="sp-fb" id="spFb"></div>';
    } else if (it.type === 'order') {
      html += '<div class="sp-order">' + it.steps.map(function (s, i) {
        return '<button class="sp-order-item" data-i="' + i + '">' +
          '<span class="sp-order-no">' + (i + 1) + '</span><span>' + esc(s.label) + '</span></button>';
      }).join('') + '</div><div class="sp-fb" id="spFb"></div>';
    } else if (it.type === 'decision') {
      html += '<div class="sp-decisions">' + it.options.map(function (o, i) {
        return '<button class="sp-decision-item" data-i="' + i + '">' +
          '<span class="sp-decision-key">' + 'ABC'[i] + '</span><span>' + esc(o.text) + '</span></button>';
      }).join('') + '</div><div class="sp-fb" id="spFb"></div>';
    } else if (it.type === 'injury') {
      html += '<p class="sp-fall-text">' + esc(it.fallText) + '</p>' +
        '<div class="sp-injury-actions">' +
        '<button class="btn btn-primary" id="spOpenLab">🔬 在 3D 实验室深看前交叉韧带</button>' +
        '</div>' +
        '<div class="sp-fb" id="spFb"></div>';
    }
    box.innerHTML = html;

    if (it.type === 'checklist') bindChecklist(st, it);
    else if (it.type === 'order') bindOrder(st, it);
    else if (it.type === 'decision') bindDecision(st, it);
    else if (it.type === 'injury') {
      var lb = $('spOpenLab');
      if (lb) lb.addEventListener('click', function () {
        if (typeof window.Lab3D !== 'undefined') window.Lab3D.open('knee');
      });
      finishInteraction(st);
    }
  }

  function bindChecklist(st, it) {
    var picked = {};
    var items = Array.prototype.slice.call($('spInter').querySelectorAll('.sp-check-item'));
    items.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('locked')) return;
        var i = +btn.getAttribute('data-i');
        picked[i] = !picked[i];
        btn.classList.toggle('picked', picked[i]);
      });
    });
    var checkBtn = document.createElement('button');
    checkBtn.className = 'btn btn-primary sp-next-btn';
    checkBtn.textContent = '提交我的选择';
    checkBtn.addEventListener('click', function () {
      var allClicked = it.items.every(function (_, i) { return picked[i]; });
      if (!allClicked) {
        $('spFb').innerHTML = '<div class="sp-fb-warn">还有装备没有判断，请把每一项都点一遍。</div>';
        return;
      }
      items.forEach(function (btn) {
        var i = +btn.getAttribute('data-i');
        var item = it.items[i];
        btn.classList.add('locked');
        btn.classList.remove('picked');
        var ok = picked[i] === item.must;
        btn.classList.add(ok ? 'right' : 'wrong');
        btn.innerHTML = '<span class="sp-check-box">' + (ok ? '✓' : '✗') + '</span>' +
          '<span>' + esc(item.label) + '<small>' + esc(item.why) + '</small></span>';
      });
      checkBtn.remove();
      finishInteraction(st);
    });
    $('spInter').appendChild(checkBtn);
  }

  function bindOrder(st, it) {
    var next = 1;
    var correct = it.steps.filter(function (s) { return s.order > 0; }).length;
    var done = 0;
    var items = Array.prototype.slice.call($('spInter').querySelectorAll('.sp-order-item'));
    items.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('locked')) return;
        var i = +btn.getAttribute('data-i');
        var s = it.steps[i];
        var fb = $('spFb');
        if (s.wrong) {
          fb.innerHTML = '<div class="sp-fb-warn">✗ ' + esc(s.label) + ' —— ' + esc(s.why || '这一步不正确') + '</div>';
          btn.classList.add('shake');
          setTimeout(function () { btn.classList.remove('shake'); }, 400);
          return;
        }
        if (s.order === next) {
          btn.classList.add('right', 'locked');
          btn.querySelector('.sp-order-no').textContent = '✓';
          next++;
          done++;
          fb.innerHTML = '<div class="sp-fb-ok">✓ 第 ' + s.order + ' 步正确</div>';
          if (done >= correct) finishInteraction(st);
        } else {
          fb.innerHTML = '<div class="sp-fb-warn">顺序不对：现在应该选第 ' + next + ' 步。</div>';
          btn.classList.add('shake');
          setTimeout(function () { btn.classList.remove('shake'); }, 400);
        }
      });
    });
  }

  function bindDecision(st, it) {
    var items = Array.prototype.slice.call($('spInter').querySelectorAll('.sp-decision-item'));
    items.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('locked')) return;
        var i = +btn.getAttribute('data-i');
        var o = it.options[i];
        items.forEach(function (b) { b.classList.add('locked'); });
        btn.classList.add(o.verdict === 'safe' ? 'right' : 'wrong');
        $('spFb').innerHTML = '<div class="sp-fb-' + o.verdict + '">' +
          (o.verdict === 'safe' ? '✓ 安全选择' : '✗ 高危选择') + ' —— ' + esc(o.feedback) + '</div>';
        finishInteraction(st);
      });
    });
  }

  function finishInteraction(st) {
    var quizBox = $('spQuiz');
    var q = st.quiz;
    if (!q) { renderStationDone(st); return; }
    quizBox.innerHTML =
      '<h4 class="sp-sec-title">📝 随堂测验</h4>' +
      '<p class="sp-quiz-q">' + esc(q.question) + '</p>' +
      '<div class="sp-quiz-opts">' + q.options.map(function (o, i) {
        return '<button class="sp-quiz-opt" data-i="' + i + '">' +
          '<span class="sp-decision-key">' + 'ABCD'[i] + '</span><span>' + esc(o) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="sp-fb" id="spQuizFb"></div>';
    var opts = Array.prototype.slice.call(quizBox.querySelectorAll('.sp-quiz-opt'));
    opts.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('locked')) return;
        var i = +btn.getAttribute('data-i');
        var ok = (i === q.answer);
        opts.forEach(function (b) { b.classList.add('locked'); });
        btn.classList.add(ok ? 'right' : 'wrong');
        if (!ok) opts[q.answer].classList.add('right');
        $('spQuizFb').innerHTML =
          '<div class="' + (ok ? 'sp-fb-ok' : 'sp-fb-warn') + '">' +
          (ok ? '✓ 答对了！' : '✗ 答错了，看看解析') + '</div>' +
          '<div class="sp-quiz-explain">' + esc(q.explain) + '</div>';
        renderStationDone(st);
      });
    });
  }

  function renderStationDone(st) {
    var box = $('spActions');
    if (!box || box.querySelector('[data-done]')) return;
    var already = S.stationDone[st.id];
    box.innerHTML =
      '<button class="btn btn-primary" data-done>' +
      (already ? '继续滑行 ▶' : '完成站点，获得 ' + (S.data.meta.stationPoints || 15) + ' 分 ▶') +
      '</button>';
    box.querySelector('[data-done]').addEventListener('click', function () {
      if (!already) {
        S.stationDone[st.id] = true;
        if (window.Progress) {
          window.Progress.award('slope-station:' + st.id, 'slope',
            '完成站点「' + st.name + '」', S.data.meta.stationPoints || 15);
          window.Progress._state.slope.stations[st.id] = true;
        }
      }
      closeStationPanel();
    });
  }

  function closeStationPanel() {
    $('skiPanel').classList.add('hidden');
    if (S.atStation >= 0) S.suppressStation = S.atStation;
    S.atStation = -1;
    refreshHUD();
  }

  /* ---------- 通关面板 ---------- */
  function showFinishPanel() {
    var P = window.Progress;
    var doneCount = Object.keys(S.stationDone).length;
    var total = S.data ? S.data.stations.length : 5;
    var allDone = doneCount >= total;
    var secs = Math.round((performance.now() - S.startAt) / 1000);

    if (allDone && P) {
      P.award('slope-finish', 'slope', '通关全景滑雪场（5/5 站点）', S.data.meta.finishBonus || 50);
      P._state.slope.finished = true;
    }

    var panel = $('skiPanel');
    panel.classList.remove('hidden');
    panel.innerHTML =
      '<div class="sp-head">' +
      '  <span class="sp-icon">🏁</span>' +
      '  <div class="sp-title"><strong>滑完全程！</strong><small>用时 ' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒</small></div>' +
      '</div>' +
      '<div class="sp-body">' +
      '  <div class="sp-finish-grid">' +
      '    <div class="sp-finish-cell"><div class="sp-finish-num">' + doneCount + '/' + total + '</div><div class="sp-finish-lab">学习站点</div></div>' +
      '    <div class="sp-finish-cell"><div class="sp-finish-num">' + (P ? P._state.points : 0) + '</div><div class="sp-finish-lab">总积分</div></div>' +
      '  </div>' +
      (allDone
        ? '<div class="sp-fb-ok">🎉 全部站点完成，获得通关奖励 ' + (S.data.meta.finishBonus || 50) + ' 分！<br>' +
          '装备、热身、控速、防摔、冻伤急救——滑雪安全的关键一课已经完成。</div>'
        : '<div class="sp-fb-warn">还有 ' + (total - doneCount) + ' 个站点没有学习。回到雪道上方重新滑过错过站点的位置即可补学，集齐 5 站后回来可获通关奖励。</div>') +
      '  <div class="sp-actions">' +
      '    <button class="btn btn-primary" data-again>重新滑一次</button>' +
      (P ? '<button class="btn" data-archive>查看学习档案</button>' : '') +
      '    <button class="btn btn-ghost" data-close>返回首页</button>' +
      '  </div>' +
      '</div>';
    panel.querySelector('[data-again]').addEventListener('click', function () {
      panel.classList.add('hidden');
      placeSkierAtStart();
    });
    var arch = panel.querySelector('[data-archive]');
    if (arch) arch.addEventListener('click', function () {
      panel.classList.add('hidden');
      if (window.Progress) window.Progress.showArchive();
    });
    panel.querySelector('[data-close]').addEventListener('click', function () {
      if (typeof window.goHome === 'function') window.goHome();
      close();
    });
    refreshHUD();
  }

  /* ============================================================
   * 九、HUD / 小地图 / 提示
   * ========================================================== */
  function updateHUD() {
    $('skiSpeedVal').textContent = Math.round(S.speed * 3.6);

    if (S.atStation < 0 && !S.fall && S.data) {
      var best = null, bestD = 1e9;
      for (var i = 0; i < S.data.stations.length; i++) {
        var st = S.data.stations[i];
        if (S.stationDone[st.id]) continue;
        var bx = pathX(st.bz), bz = -st.bz;
        var d = Math.hypot(S.pos.x - bx, S.pos.z - bz);
        if (d < bestD) { bestD = d; best = st; }
      }
      var hint = $('skiHint');
      if (best && bestD < 26) {
        hint.textContent = best.icon + ' 前方 ' + Math.round(bestD) + 'm：' + best.name;
        hint.classList.remove('hidden');
      } else if (best && bestD < 70) {
        hint.textContent = '沿雪道向下滑，前往 ' + best.icon + ' ' + best.name;
        hint.classList.remove('hidden');
      } else {
        hint.classList.add('hidden');
      }
    } else {
      $('skiHint').classList.add('hidden');
    }

    drawMinimap();
  }

  function drawMinimap() {
    var cv = $('skiMinimap');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    function mx(x) { return 10 + (x + 30) / 60 * (W - 20); }
    // 前进方向（z 减小）对应地图向上：起点 z=62 在底部，终点 z=-48 在顶部
    function mz(z) { return 10 + (z + 48) / 110 * (H - 20); }

    // 方向标注：底部=山顶（出发），顶部=终点
    ctx.font = '10px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(219,234,244,.75)';
    ctx.fillText('⛰ 山顶', W / 2, H - 4);
    ctx.fillText('🏁 终点', W / 2, 13);

    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var by = -60; by <= 45; by += 4) {
      var px = pathX(by), pz = -by;
      if (by === -60) ctx.moveTo(mx(px), mz(pz));
      else ctx.lineTo(mx(px), mz(pz));
    }
    ctx.stroke();

    if (S.data) {
      S.data.stations.forEach(function (st) {
        var x = mx(pathX(st.bz)), y = mz(-st.bz);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = S.stationDone[st.id] ? '#4db6ac' : 'rgba(255,255,255,.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,30,50,.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    ctx.save();
    ctx.translate(mx(S.pos.x), mz(S.pos.z));
    ctx.rotate(-S.yaw + Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fillStyle = '#ff7043';
    ctx.fill();
    ctx.restore();
  }

  function showNotice(msg) {
    var n = document.createElement('div');
    n.className = 'ski-notice';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function () {
      n.style.transition = 'opacity .4s';
      n.style.opacity = '0';
      setTimeout(function () { n.remove(); }, 450);
    }, 3600);
  }

  /* ============================================================
   * 十、主循环
   * ========================================================== */
  function tick(now) {
    S.raf = requestAnimationFrame(tick);
    var dt = Math.min(0.05, (now - S.lastT) / 1000);
    S.lastT = now;
    S.clock += dt;

    readInput();
    updateMotion(dt);
    updateHUD();

    for (var i = 0; i < S.stationObjs.length; i++) {
      var st = S.stationObjs[i];
      if (!st) continue;
      var orb = st.getObjectByName('Station_' + i + '_Orb');
      var beacon = st.getObjectByName('Station_' + i + '_Beacon');
      if (orb) orb.position.y = 1.05 + Math.sin(S.clock * 2 + i) * 0.14;
      if (beacon) beacon.rotation.y += dt * 1.6;
    }

    if (S.snow) {
      var pos = S.snowGeo.attributes.position;
      var cam = S.camera.position;
      for (var j = 0; j < pos.count; j++) {
        var y = pos.getY(j) - dt * (1.6 + (j % 5) * 0.25);
        var x = pos.getX(j) + dt * 0.7;
        if (y < cam.y - 12) y = cam.y + 14;
        if (x > cam.x + 35) x = cam.x - 35;
        pos.setY(j, y);
        pos.setX(j, x);
      }
      pos.needsUpdate = true;
    }

    if (S.renderer && S.scene) S.renderer.render(S.scene, S.camera);
  }

  /* ============================================================
   * 十一、打开 / 关闭
   * ========================================================== */
  function open() {
    loadData(function (d) {
      if (!d) { showNotice('滑雪场数据加载失败，请确认 data/ski3d.json 存在。'); return; }
      if (typeof THREE === 'undefined') { showNotice('3D 引擎未加载。'); return; }

      S.open = true;
      S.stationDone = {};
      var P = window.Progress;
      if (P && P._state.slope && P._state.slope.stations) {
        Object.keys(P._state.slope.stations).forEach(function (k) {
          S.stationDone[k] = true;
        });
      }

      buildShell();
      buildDots();
      refreshHUD();
      $('ski3d').classList.remove('hidden');

      var intro = $('skiIntro');
      intro.innerHTML =
        '<div class="ski-intro-panel">' +
        '<div class="ski-intro-ic">🏔️</div>' +
        '<h3>欢迎来到全景滑雪场</h3>' +
        '<p>你将从山顶出发，沿雪道滑下，途中经过 <strong>5 个学习站点</strong>：<br>' +
        '装备检查 → 热身提醒 → 滑行技术 → 摔倒与损伤 → 冻伤与急救</p>' +
        '<p class="ski-intro-ctrl">' + esc(d.meta.controls) + '</p>' +
        '<p class="ski-intro-tip">' + esc(d.meta.disclaimer) + '</p>' +
        '<button class="btn btn-primary" id="skiIntroBtn">开始滑雪 ▶</button>' +
        '</div>';
      intro.classList.remove('hidden');
      $('skiIntroBtn').addEventListener('click', function () {
        intro.classList.add('hidden');
      });

      if (!S.renderer) {
        initScene();
        bindInput();
      } else {
        placeSkierAtStart();
      }

      $('skiClose').addEventListener('click', function () {
        // 与视频模块「首页」一致：返回模块选择页
        if (typeof window.goHome === 'function') window.goHome();
        close();
      });
      var skiArch = $('skiArchive');
      if (skiArch) skiArch.addEventListener('click', function () {
        if (typeof window.showGlobalArchive === 'function') window.showGlobalArchive();
        else if (window.Progress) window.Progress.showArchive();
      });

      if (!S.raf) {
        S.lastT = performance.now();
        S.raf = requestAnimationFrame(tick);
      }
    });
  }

  function close() {
    S.open = false;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    $('ski3d').classList.add('hidden');
    if (window.Progress) window.Progress.renderHub();
  }

  window.Ski3D = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    _state: S
  };
})();
