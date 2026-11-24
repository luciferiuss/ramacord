import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Тест берёт воркл ет прямо из public/index.html, чтобы он всегда проверял
// ровно тот код, который уезжает в браузер.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const m = html.match(/const MIC_WORKLET = `([\s\S]*?)`;/);
assert.ok(m, "в public/index.html не найден MIC_WORKLET");

const SR = 48000;
const MicGate = new Function(
  "AudioWorkletProcessor",
  "sampleRate",
  "registerProcessor",
  `${m[1]}\nreturn MicGate;`
)(class { constructor() { this.port = { postMessage() {} }; } }, SR, () => {});

function make(cfg = {}) {
  const p = new MicGate();
  p.meters = [];
  p.port.postMessage = (v) => p.meters.push(v);
  Object.assign(p, cfg);
  return p;
}

// Прогоняет n блоков по 128 сэмплов через process()
function run(p, gen, n = 1) {
  const out = [];
  for (let b = 0; b < n; b++) {
    const input = new Float32Array(128);
    const chunk = new Float32Array(128);
    for (let i = 0; i < 128; i++) input[i] = gen(b * 128 + i);
    p.process([[input]], [[chunk]]);
    out.push(chunk);
  }
  return out;
}

const sine = (amp, freq = 200) => (i) => amp * Math.sin((2 * Math.PI * freq * i) / SR);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const peak = (a) => a.reduce((mx, x) => Math.max(mx, Math.abs(x)), 0);

test("режим без ns_pro повторяет старое поведение (пропускает сигнал)", () => {
  const p = make({ pro: false, th: 0, vol: 1, mute: false });
  const out = run(p, () => 0.3, 10);
  assert.ok(Math.abs(rms(out[9]) - 0.3) < 0.02, `rms=${rms(out[9]).toFixed(3)}`);
});

test("pro: high-pass убирает постоянную составляющую", () => {
  const p = make({ pro: true, th: 0, strength: 0.5, vol: 1 });
  const out = run(p, () => 0.5, 40);
  assert.ok(peak(out[39]) < 0.01, `peak=${peak(out[39]).toFixed(4)}`);
});

test("pro: гистерезис держит ворота открытыми между порогами", () => {
  const p = make({ pro: true, th: 0.1, strength: 0.5, vol: 1 });
  run(p, () => 0, 2);
  run(p, sine(0.2), 2);
  const mid = run(p, sine(0.12), 20);
  assert.ok(rms(mid[19]) > 0.05, `rms=${rms(mid[19]).toFixed(3)}`);
});

test("pro: ворота закрываются ниже close-порога", () => {
  const p = make({ pro: true, th: 0.1, strength: 0.5, vol: 1 });
  run(p, () => 0, 2);
  run(p, sine(0.2), 2);
  const low = run(p, sine(0.05), 300);
  assert.ok(rms(low[299]) < 0.01, `rms=${rms(low[299]).toFixed(4)}`);
});

test("pro: de-click ослабляет короткий щелчок", () => {
  const measure = (strength) => {
    const p = make({ pro: true, th: 0, strength, vol: 1 });
    run(p, sine(0.05), 20);
    const out = run(p, (i) => 0.05 * Math.sin((2 * Math.PI * 200 * i) / SR) + (i === 10 ? 0.9 : 0), 1);
    return peak(out[0]);
  };
  const withClick = measure(1);
  const without = measure(0);
  assert.ok(withClick < without * 0.5, `with=${withClick.toFixed(3)} without=${without.toFixed(3)}`);
});

test("pro: mute глушит звук полностью", () => {
  const p = make({ pro: true, th: 0, strength: 0.5, vol: 1, mute: true });
  const out = run(p, sine(0.4), 10);
  assert.ok(peak(out[9]) < 0.01, `peak=${peak(out[9]).toFixed(4)}`);
});

test("pro: громкость микрофона применяется", () => {
  const p = make({ pro: true, th: 0, strength: 0.5, vol: 0.5 });
  const out = run(p, sine(0.4), 20);
  // 0.4 / √2 ≈ 0.283 → на 0.5 это ≈ 0.14 с учётом HPF
  assert.ok(Math.abs(rms(out[19]) - 0.13) < 0.03, `rms=${rms(out[19]).toFixed(3)}`);
});

test("pro: воркл ет отправляет уровень для индикатора", () => {
  const p = make({ pro: true, th: 0, strength: 0.5, vol: 1 });
  run(p, sine(0.3), 20);
  assert.ok(p.meters.length > 0, "не было postMessage");
  assert.ok(p.meters.at(-1) > 0.1, `level=${p.meters.at(-1)}`);
});

test("pro: при пустом входе воркл ет не падает и отдаёт тишину", () => {
  const p = make({ pro: true, th: 0, strength: 0.5, vol: 1 });
  const out = new Float32Array(128);
  const alive = p.process([[]], [[out]]);
  assert.equal(alive, true);
  assert.equal(peak(out), 0);
});
