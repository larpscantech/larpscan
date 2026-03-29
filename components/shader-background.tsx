'use client';

import { useEffect, useRef } from 'react';
import { createShaderPreset } from 'horsestudiowebgl';

const LIVE_CONTROLS = {
  rotation: 0,
  cursorMovement: 1,
  cursorReaction: 0.6,
  effectSize: 1,
  scale: 1,
  positionX: 0,
  positionY: 0,
  cursorOffsetX: 0,
  cursorOffsetY: 0,
  speed: 0.5,
  curves: 0.5,
  turbulence: 0.5,
  softness: 0.5,
  blur: 0,
  brightness: 0.45,
  contrast: 1,
  saturation: 0.7,
  hueShift: 122,
  opacity: 1,
  grain: 0.3,
  colorA: '#0b2fff',
  colorB: '#6ecbff',
  colorC: '#ffffff',
  shapePreset: 'default',
  blendMode: 'screen',
};

const basePreset = createShaderPreset('dynamic-opengl-gradient');
const SHADER_CONFIG = {
  ...basePreset,
  defaultControls: { ...basePreset.defaultControls, ...LIVE_CONTROLS },
};

function hexToVec3(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

const VERTEX_SRC = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SRC = `
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;
uniform vec2  u_mouse;
uniform float u_speed;
uniform float u_hueShift;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_grain;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform vec3  u_colorC;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p  = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;

  vec2 m  = u_mouse * 2.0 - 1.0;
  m.x *= u_resolution.x / u_resolution.y;

  float t = u_time * 0.25 * u_speed;

  float k    = p.x * 1.5 + t;
  float wave = sin(k) * cos(k * 0.4 - t * 0.5) * 0.8;

  vec2  dirToMouse = m - p;
  float distToMouse = length(dirToMouse);
  float influence   = exp(-distToMouse * distToMouse * 2.5);
  wave += influence * (m.y * 0.8 + sin(p.x * 4.0 - t * 2.0) * 0.2);

  float d        = p.y - wave;
  float sideDist = abs(uv.x - 0.5) * 2.0;
  float blur     = mix(0.015, 1.8, pow(sideDist, 2.5));

  float core         = smoothstep(blur * 0.15, 0.0, abs(d));
  float innerGlow    = smoothstep(blur * 0.8, 0.0, abs(d));
  float ambientGlow  = exp(-abs(d) * mix(6.0, 0.8, sideDist));
  float topLight     = smoothstep(0.0, blur * 2.5, d);
  float bottomShadow = smoothstep(0.0, blur * 4.0, -d);

  vec3 bgDark = vec3(0.01, 0.01, 0.02);
  vec3 color  = bgDark;
  color  = mix(color, u_colorA, ambientGlow * 0.7);
  color += u_colorA * topLight * 0.4;
  color  = mix(color, u_colorB, innerGlow * 0.85);
  color  = mix(color, u_colorC, core);
  color -= bottomShadow * vec3(0.1, 0.08, 0.06) * 0.8;

  float vignette = length(uv - 0.5) * 1.6;
  color *= 1.0 - pow(vignette, 1.8);

  // hue shift
  vec3 hsv = rgb2hsv(color);
  hsv.x = fract(hsv.x + u_hueShift / 360.0);
  color = hsv2rgb(hsv);

  // brightness / contrast / saturation
  color *= u_brightness;
  color = (color - 0.5) * u_contrast + 0.5;
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(lum), color, u_saturation);

  // film grain
  float noise = hash(gl_FragCoord.xy + u_time);
  color += (noise - 0.5) * u_grain * 0.07;

  gl_FragColor = vec4(max(color, 0.0), 1.0);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

export function ShaderBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const ctrl = SHADER_CONFIG.defaultControls;
    const [cA_r, cA_g, cA_b] = hexToVec3(ctrl.colorA);
    const [cB_r, cB_g, cB_b] = hexToVec3(ctrl.colorB);
    const [cC_r, cC_g, cC_b] = hexToVec3(ctrl.colorC);

    const uTime       = gl.getUniformLocation(prog, 'u_time');
    const uRes        = gl.getUniformLocation(prog, 'u_resolution');
    const uMouse      = gl.getUniformLocation(prog, 'u_mouse');
    const uSpeed      = gl.getUniformLocation(prog, 'u_speed');
    const uHueShift   = gl.getUniformLocation(prog, 'u_hueShift');
    const uBrightness = gl.getUniformLocation(prog, 'u_brightness');
    const uContrast   = gl.getUniformLocation(prog, 'u_contrast');
    const uSaturation = gl.getUniformLocation(prog, 'u_saturation');
    const uGrain      = gl.getUniformLocation(prog, 'u_grain');
    const uColorA     = gl.getUniformLocation(prog, 'u_colorA');
    const uColorB     = gl.getUniformLocation(prog, 'u_colorB');
    const uColorC     = gl.getUniformLocation(prog, 'u_colorC');

    gl.uniform1f(uSpeed, ctrl.speed);
    gl.uniform1f(uHueShift, ctrl.hueShift);
    gl.uniform1f(uBrightness, ctrl.brightness);
    gl.uniform1f(uContrast, ctrl.contrast);
    gl.uniform1f(uSaturation, ctrl.saturation);
    gl.uniform1f(uGrain, ctrl.grain);
    gl.uniform3f(uColorA, cA_r, cA_g, cA_b);
    gl.uniform3f(uColorB, cB_r, cB_g, cB_b);
    gl.uniform3f(uColorC, cC_r, cC_g, cC_b);

    let mouseX = 0.5;
    let mouseY = 0.5;
    let targetX = 0.5;
    let targetY = 0.5;

    const onMove = (e: MouseEvent) => {
      targetX = e.clientX / window.innerWidth;
      targetY = 1.0 - e.clientY / window.innerHeight;
    };
    window.addEventListener('mousemove', onMove);

    const dpr = Math.min(window.devicePixelRatio, 2);
    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    const start = performance.now();
    let raf = 0;
    const lerp = SHADER_CONFIG.mouseLerp;

    const render = () => {
      const t = (performance.now() - start) / 1000;
      mouseX += (targetX - mouseX) * lerp;
      mouseY += (targetY - mouseY) * lerp;

      gl.uniform1f(uTime, t);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform2f(uMouse, mouseX, mouseY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', resize);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0"
      style={{ pointerEvents: 'none', zIndex: -1, opacity: 0.55 }}
    />
  );
}
