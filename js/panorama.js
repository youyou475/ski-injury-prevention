/**
 * PanoramaPlayer —— 零依赖 WebGL 等距柱状全景（equirectangular）视频播放器
 *
 * 渲染思路：不使用球体网格，而是绘制一个全屏 quad，在 fragment shader 中
 * 对每个像素反算视线方向，再查表 equirect 纹理。相比球体网格，
 * 该方案无极点畸变、无网格接缝，且着色器开销极小。
 *
 * 依赖：无（原生 WebGL 1.0），视频由调用方以 HTMLVideoElement 传入。
 */
(function (global) {
  'use strict';

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = aPos * 0.5 + 0.5;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform float uYaw;',      // 水平旋转（弧度）
    'uniform float uPitch;',    // 俯仰（弧度）
    'uniform float uTanHalf;',  // tan(垂直半 FOV)
    'uniform float uAspect;',
    'uniform float uOpacity;',  // 片段淡入淡出
    'uniform float uVignette;', // 暗角强度
    'const float PI = 3.141592653589793;',
    'const float TWO_PI = 6.283185307179586;',

    // 先绕 X 轴俯仰，再绕 Y 轴偏航
    'vec3 rotateView(vec3 p, float yaw, float pitch) {',
    '  float cp = cos(pitch), sp = sin(pitch);',
    '  vec3 q = vec3(p.x, cp * p.y - sp * p.z, sp * p.y + cp * p.z);',
    '  float cy = cos(yaw), sy = sin(yaw);',
    '  return vec3(cy * q.x + sy * q.z, q.y, -sy * q.x + cy * q.z);',
    '}',

    'void main() {',
    '  vec2 p = vUv * 2.0 - 1.0;',
    '  vec3 dirCam = normalize(vec3(p.x * uTanHalf * uAspect, p.y * uTanHalf, -1.0));',
    '  vec3 d = rotateView(dirCam, uYaw, -uPitch);',
    '  float u = 0.5 + atan(d.x, -d.z) / TWO_PI;',
    '  float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / PI;',
    '  vec3 col = texture2D(uTex, vec2(u, v)).rgb;',
    // 轻微暗角，提升沉浸感
    '  float r = length(p);',
    '  col *= 1.0 - uVignette * smoothstep(0.55, 1.35, r);',
    '  gl_FragColor = vec4(col, uOpacity);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  function createProgram(gl) {
    var vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts { fov: 垂直视角(度), minFov, maxFov, autoRotate: 弧度/秒 }
   */
  function PanoramaPlayer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.video = null;
    this.yaw = 0;
    this.pitch = 0;
    this.tYaw = 0;
    this.tPitch = 0;
    this.fov = opts.fov || 78;
    this.minFov = opts.minFov || 45;
    this.maxFov = opts.maxFov || 110;
    this.maxPitch = (opts.maxPitch || 80) * Math.PI / 180;
    this.autoRotate = opts.autoRotate || 0;
    this.opacity = 1;
    this.targetOpacity = 1;
    this._raf = null;
    this._texReady = false;
    this._dirty = true;
    this._lastVideoTime = -1;
    this.onError = opts.onError || null;
    this.hotspots = [];
    this.onHotspotClick = opts.onHotspotClick || null;
    this._hotspotEls = [];

    var attrs = { alpha: false, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
    var gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('WEBGL_UNAVAILABLE');
    this.gl = gl;

    this.prog = createProgram(gl);
    gl.useProgram(this.prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      tex: gl.getUniformLocation(this.prog, 'uTex'),
      yaw: gl.getUniformLocation(this.prog, 'uYaw'),
      pitch: gl.getUniformLocation(this.prog, 'uPitch'),
      tanHalf: gl.getUniformLocation(this.prog, 'uTanHalf'),
      aspect: gl.getUniformLocation(this.prog, 'uAspect'),
      opacity: gl.getUniformLocation(this.prog, 'uOpacity'),
      vignette: gl.getUniformLocation(this.prog, 'uVignette')
    };

    gl.uniform1i(this.u.tex, 0);
    gl.uniform1f(this.u.vignette, opts.vignette != null ? opts.vignette : 0.28);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._bindInput();
    this.resize();
  }

  PanoramaPlayer.prototype.attachVideo = function (videoEl) {
    var self = this;
    this.video = videoEl;
    videoEl.addEventListener('timeupdate', function () { self._dirty = true; });
    videoEl.addEventListener('seeked', function () { self._dirty = true; });
    videoEl.addEventListener('play', function () { self._dirty = true; });
    this._dirty = true;
    this._texReady = false;
  };

  /** 切换纹理源视频（用于双缓冲无缝切换片段） */
  PanoramaPlayer.prototype.setSource = function (videoEl) {
    this.video = videoEl;
    this._lastVideoTime = -1;
    this._texReady = false;
    this._dirty = true;
  };

  PanoramaPlayer.prototype._bindInput = function () {
    var self = this;
    var c = this.canvas;
    var dragging = false, lastX = 0, lastY = 0, moved = 0;

    function down(x, y) { dragging = true; lastX = x; lastY = y; moved = 0; self.autoRotate = 0; }
    function move(x, y) {
      if (!dragging) return;
      var dx = x - lastX, dy = y - lastY;
      lastX = x; lastY = y;
      moved += Math.abs(dx) + Math.abs(dy);
      var k = 2.2 * (self.fov / 78) / self.canvas.clientWidth;
      self.tYaw -= dx * k;
      self.tPitch += dy * k;
      self.tPitch = clamp(self.tPitch, -self.maxPitch, self.maxPitch);
      self._dirty = true;
    }
    function up() { dragging = false; }

    c.addEventListener('mousedown', function (e) { down(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { move(e.clientX, e.clientY); });
    window.addEventListener('mouseup', up);

    c.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) { down(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: true });
    c.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1) { move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }
    }, { passive: false });
    c.addEventListener('touchend', up);

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.fov = clamp(self.fov + (e.deltaY > 0 ? 4 : -4), self.minFov, self.maxFov);
      self._dirty = true;
    }, { passive: false });

    // 键盘：方向键转视角，+/- 缩放
    window.addEventListener('keydown', function (e) {
      var step = 0.12;
      if (e.key === 'ArrowLeft') self.tYaw += step;
      else if (e.key === 'ArrowRight') self.tYaw -= step;
      else if (e.key === 'ArrowUp') self.tPitch = clamp(self.tPitch + step, -self.maxPitch, self.maxPitch);
      else if (e.key === 'ArrowDown') self.tPitch = clamp(self.tPitch - step, -self.maxPitch, self.maxPitch);
      else if (e.key === '+' || e.key === '=') self.fov = clamp(self.fov - 5, self.minFov, self.maxFov);
      else if (e.key === '-' || e.key === '_') self.fov = clamp(self.fov + 5, self.minFov, self.maxFov);
      else return;
      self.autoRotate = 0;
      self._dirty = true;
    });

    // 陀螺仪（移动端）
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', function (e) {
        if (e.alpha == null || !self._gyro) return;
        var rad = Math.PI / 180;
        self.tYaw = -(e.alpha * rad);
        self.tPitch = clamp((e.beta - 45) * rad, -self.maxPitch, self.maxPitch);
        self._dirty = true;
      });
    }
    this._gyro = false;
  };

  PanoramaPlayer.prototype.enableGyro = function () {
    var self = this;
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      DeviceOrientationEvent.requestPermission().then(function (r) {
        self._gyro = (r === 'granted');
      }).catch(function () { self._gyro = false; });
    } else {
      this._gyro = true;
    }
  };

  PanoramaPlayer.prototype.resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    var h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._dirty = true;
  };

  PanoramaPlayer.prototype.setOpacity = function (v) {
    this.targetOpacity = v;
    this._dirty = true;
  };

  /** 设置热点：数组 [{yaw, pitch(度), label, text}] */
  PanoramaPlayer.prototype.setHotspots = function (list) {
    this.hotspots = list || [];
    this._syncHotspotEls();
    this._dirty = true;
  };

  PanoramaPlayer.prototype._syncHotspotEls = function () {
    var layer = this._hotspotLayer;
    if (!layer) return;
    while (this._hotspotEls.length < this.hotspots.length) {
      var el = document.createElement('button');
      el.className = 'hotspot';
      el.type = 'button';
      (function (self, idx, el) {
        el.addEventListener('click', function (e) {
          e.stopPropagation();
          if (self.onHotspotClick) self.onHotspotClick(self.hotspots[idx], idx);
        });
      })(this, this._hotspotEls.length, el);
      layer.appendChild(el);
      this._hotspotEls.push(el);
    }
    for (var i = 0; i < this._hotspotEls.length; i++) {
      this._hotspotEls[i].style.display = i < this.hotspots.length ? '' : 'none';
    }
  };

  PanoramaPlayer.prototype.attachHotspotLayer = function (layer) {
    this._hotspotLayer = layer;
    this._syncHotspotEls();
  };

  /** 世界方向 → 屏幕坐标（返回 null 表示在视野背后） */
  PanoramaPlayer.prototype._project = function (yawDeg, pitchDeg) {
    var rad = Math.PI / 180;
    var ya = yawDeg * rad, pa = pitchDeg * rad;
    var dirW = [Math.sin(ya) * Math.cos(pa), Math.sin(pa), -Math.cos(ya) * Math.cos(pa)];
    // R^T * dirW  （等价于反向旋转）
    var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // 正向 rotateView = Ry(yaw)*Rx(-pitch)；此处求逆：Rx(pitch)*Ry(-yaw)
    var x1 = cy * dirW[0] - sy * dirW[2];
    var y1 = dirW[1];
    var z1 = sy * dirW[0] + cy * dirW[2];
    var y2 = cp * y1 - sp * z1;
    var z2 = sp * y1 + cp * z1;
    if (z2 >= -0.05) return null; // 在身后
    var tanHalf = Math.tan(this.fov * rad / 2);
    var aspect = this.canvas.width / this.canvas.height;
    var px = (x1 / (-z2)) / (tanHalf * aspect);
    var py = (y2 / (-z2)) / tanHalf;
    return {
      x: (px * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (1 - (py * 0.5 + 0.5)) * this.canvas.clientHeight
    };
  };

  PanoramaPlayer.prototype._updateHotspots = function () {
    if (!this._hotspotLayer) return;
    for (var i = 0; i < this.hotspots.length; i++) {
      var h = this.hotspots[i];
      var el = this._hotspotEls[i];
      if (!el) continue;
      var p = this._project(h.yaw || 0, h.pitch || 0);
      if (!p || this.opacity < 0.5) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; continue; }
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      el.setAttribute('aria-label', h.label || '视角提示');
      el.title = h.label || '';
    }
  };

  PanoramaPlayer.prototype.start = function () {
    var self = this;
    function loop() {
      self._raf = requestAnimationFrame(loop);
      self._frame();
    }
    if (!this._raf) this._raf = requestAnimationFrame(loop);
  };

  PanoramaPlayer.prototype.stop = function () {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  };

  PanoramaPlayer.prototype._frame = function () {
    var gl = this.gl;
    var v = this.video;

    // 平滑插值视角
    this.yaw += (this.tYaw - this.yaw) * 0.16;
    this.pitch += (this.tPitch - this.pitch) * 0.16;
    this.opacity += (this.targetOpacity - this.opacity) * 0.12;
    if (this.autoRotate && !v.paused) this.tYaw += this.autoRotate / 60;

    if (v && v.readyState >= 2) {
      if (v.currentTime !== this._lastVideoTime) { this._lastVideoTime = v.currentTime; this._dirty = true; }
    }

    var moving = Math.abs(this.tYaw - this.yaw) > 0.0005 || Math.abs(this.tPitch - this.pitch) > 0.0005 ||
      Math.abs(this.targetOpacity - this.opacity) > 0.005;

    if (this._dirty || moving) {
      if (v && v.readyState >= 2) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        try {
          // 经 2D canvas 中转上传纹理：
          // 1) 规避部分 ANGLE/Metal 后端下 video 直传纹理静默失败（画面全黑）的问题
          // 2) 规避 file:// 协议下 video 纹理的跨域污染限制
          // 3) 顺带把 2560×1280 缩到 1024×512，显著降低纹理带宽与显存占用
          if (!this._texCanvas) {
            this._texCanvas = document.createElement('canvas');
            this._texCanvas.width = 1024;
            this._texCanvas.height = 512;
            this._texCtx = this._texCanvas.getContext('2d', { alpha: false });
          }
          this._texCtx.drawImage(v, 0, 0, 1024, 512);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._texCanvas);
          this._texReady = true;
        } catch (err) {
          this._texReady = false;
          if (this.onError) this.onError(err);
        }
      }
      if (this._texReady) {
        var rad = Math.PI / 180;
        gl.uniform1f(this.u.yaw, this.yaw);
        gl.uniform1f(this.u.pitch, this.pitch);
        gl.uniform1f(this.u.tanHalf, Math.tan(this.fov * rad / 2));
        gl.uniform1f(this.u.aspect, this.canvas.width / this.canvas.height);
        gl.uniform1f(this.u.opacity, this.opacity);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      this._dirty = moving;
      this._updateHotspots();
    }
  };

  global.PanoramaPlayer = PanoramaPlayer;
})(window);
