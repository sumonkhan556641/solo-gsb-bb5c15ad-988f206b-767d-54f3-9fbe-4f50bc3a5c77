'use strict';

/* ================= 全局状态 ================= */
const $ = id => document.getElementById(id);
const PALETTE = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292', '#ba68c8',
                 '#4db6ac', '#fff176', '#ff8a65', '#90a4ae', '#e57373'];
const ALT_H = 330;        // 高度曲线区高度(px)
const GANTT_TOP = 348;    // 计划甘特条区顶部
const GANTT_H = 48;
const ACT_TOP = 412;      // 实际执行条区顶部
const ACT_H = 48;
const CHART_H = 500;

let targets = [];                       // {name, ra, dec, expMin}
let horizon = new Array(72).fill(0);    // 每 5° 方位一个遮挡角
let planData = null;                    // /api/plan 返回
let lastPlanBody = null;                // 最近一次规划请求（执行记录提交时复用）
let obsForms = {};                      // index -> {status, start, end} 录入中的表单值
let obsResult = null;                   // /api/observations 返回 {night, items, summary}
let selected = -1;                      // 当前选中目标下标
const view = { start: 0, end: 1 };      // 时间轴可视范围(ms)

/* ================= 工具 ================= */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function lonHours() { return (parseFloat($('lon').value) || 0) / 15; }
function lonOffsetMs() { return lonHours() * 3600000; }
/** 以地方平时（UTC + 经度/15）格式化时刻 */
function fmtTime(ms) {
  const d = new Date(ms + lonOffsetMs());
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function fmtDur(ms) { return Math.round(ms / 60000) + ' 分'; }
function color(i) { return PALETTE[i % PALETTE.length]; }

/* datetime-local（地方平时）与 UTC 毫秒互转 */
function msToLocalInput(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms + lonOffsetMs());
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function localInputToMs(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - lonOffsetMs();
}
function fmtDev(min) {
  if (min == null) return '—';
  const v = Math.round(min * 10) / 10;
  const cls = v > 0 ? 'dev-pos' : (v < 0 ? 'dev-neg' : 'dev-zero');
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v} 分</span>`;
}
function obsItemOf(index) {
  return obsResult && obsResult.items.find(it => it.index === index) || null;
}
/** 计划顺序：已排目标按计划序，未排目标附后 */
function orderedIndices() {
  const ord = planData.plan.map(p => p.index);
  planData.targets.forEach((t, i) => { if (!ord.includes(i)) ord.push(i); });
  return ord;
}

/* ================= 地平线编辑器 ================= */
const hcv = $('horizon');
let hDrawing = false, hLastBin = null, hLastAlt = 0;

function renderHorizon() {
  const ctx = hcv.getContext('2d');
  const W = hcv.width, H = hcv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px sans-serif';
  ctx.strokeStyle = '#22304f';
  ctx.fillStyle = '#8fa3c8';
  const azName = { 0: '北', 90: '东', 180: '南', 270: '西', 360: '北' };
  for (let az = 0; az <= 360; az += 30) {
    const x = az / 360 * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(azName[az] || az + '°', x + 3, 12);
  }
  for (let a = 0; a <= 45; a += 15) {
    const y = H - a / 45 * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(a + '°', 3, y - 3);
  }
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < 72; i++) {
    ctx.lineTo((i * 5 + 2.5) / 360 * W, H - horizon[i] / 45 * H);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(110, 170, 110, 0.30)';
  ctx.fill();
  ctx.strokeStyle = '#7fc97f';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function horizonSet(e) {
  const r = hcv.getBoundingClientRect();
  const az = (e.clientX - r.left) / r.width * 360;
  const alt = Math.max(0, Math.min(45, (1 - (e.clientY - r.top) / r.height) * 45));
  const bin = ((Math.round(az / 5) % 72) + 72) % 72;
  if (hLastBin !== null) {
    let d = bin - hLastBin;
    if (d > 36) d -= 72;
    if (d < -36) d += 72;
    const steps = Math.abs(d);
    for (let s = 1; s <= steps; s++) {
      const b = ((hLastBin + Math.sign(d) * s) % 72 + 72) % 72;
      horizon[b] = hLastAlt + (alt - hLastAlt) * (s / steps);
    }
  }
  horizon[bin] = alt;
  hLastBin = bin;
  hLastAlt = alt;
  renderHorizon();
}

hcv.addEventListener('pointerdown', e => {
  hDrawing = true; hLastBin = null;
  hcv.setPointerCapture(e.pointerId);
  horizonSet(e);
});
hcv.addEventListener('pointermove', e => { if (hDrawing) horizonSet(e); });
hcv.addEventListener('pointerup', () => { hDrawing = false; hLastBin = null; });

function horizonPreset(name) {
  const H = new Array(72).fill(0);
  if (name === 'trees') {
    for (let i = 0; i < 72; i++) H[i] = Math.round((7 + 6 * Math.abs(Math.sin(i * 1.7)) + (i % 5)) * 10) / 10;
  } else if (name === 'hill') {
    for (let i = 0; i < 72; i++) {
      const az = i * 5;
      H[i] = az > 120 && az < 240 ? Math.round((16 + 10 * Math.sin((az - 120) / 120 * Math.PI)) * 10) / 10 : 3;
    }
  } else if (name === 'dome') {
    H.fill(12);
  }
  horizon = H;
  renderHorizon();
}
document.querySelectorAll('[data-preset]').forEach(b => {
  b.addEventListener('click', () => horizonPreset(b.dataset.preset));
});

/* ================= 目标列表 ================= */
function renderTargets() {
  const tb = $('targetTable').querySelector('tbody');
  tb.innerHTML = '';
  targets.forEach((t, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="sw" style="background:${color(i)}"></span></td>` +
      `<td>${esc(t.name)}</td><td>${esc(t.ra)}</td><td>${esc(t.dec)}</td><td>${t.expMin}</td>` +
      `<td><button class="del" data-i="${i}">✕</button></td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('.del').forEach(b => {
    b.addEventListener('click', () => { targets.splice(Number(b.dataset.i), 1); renderTargets(); });
  });
}

$('addTarget').addEventListener('click', () => {
  const ra = $('tRa').value.trim();
  const dec = $('tDec').value.trim();
  if (!ra || !dec) { $('status').textContent = '请填写赤经与赤纬'; return; }
  targets.push({
    name: $('tName').value.trim() || `目标 ${targets.length + 1}`,
    ra, dec,
    expMin: Math.max(1, Number($('tExp').value) || 30),
  });
  $('tName').value = $('tRa').value = $('tDec').value = '';
  $('status').textContent = '';
  renderTargets();
});

$('clearTargets').addEventListener('click', () => { targets = []; renderTargets(); });

$('loadSamples').addEventListener('click', async () => {
  const r = await fetch('/api/samples');
  targets = await r.json();
  renderTargets();
});

/* ================= 请求规划 ================= */
$('planBtn').addEventListener('click', async () => {
  $('status').textContent = '计算中…';
  const body = {
    lat: Number($('lat').value),
    lon: Number($('lon').value),
    date: $('date').value,
    minAlt: Number($('minAlt').value),
    slewMin: Number($('slewMin').value),
    flipMin: Number($('flipMin').value),
    horizon,
    targets,
  };
  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '计算失败');
    planData = data;
    lastPlanBody = body;
    obsForms = {};
    obsResult = null;
    selected = -1;
    view.start = data.night.start - 30 * 60000;
    view.end = data.night.end + 30 * 60000;
    $('results').hidden = false;
    $('obsSummary').hidden = true;
    $('obsStatus').textContent = '';
    const off = lonHours();
    $('nightInfo').textContent =
      `${data.night.label}：${fmtTime(data.night.start)} → ${fmtTime(data.night.end)}` +
      `（地方平时 UTC${off >= 0 ? '+' : ''}${off.toFixed(1)}）`;
    renderAll();
    $('status').textContent = '';
    $('results').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    $('status').textContent = '错误：' + e.message;
  }
});

function renderAll() {
  renderTimeline();
  renderLegend();
  renderDetail();
  renderPlanTables();
  renderObsTable();
  renderObsSummary();
}

/* ================= 时间轴 ================= */
const tlc = $('timeline');

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderTimeline() {
  if (!planData) return;
  const W = tlc.clientWidth || 900;
  const dpr = window.devicePixelRatio || 1;
  tlc.width = W * dpr;
  tlc.height = CHART_H * dpr;
  const ctx = tlc.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, CHART_H);

  const x = t => (t - view.start) / (view.end - view.start) * W;
  const y = a => ALT_H - ((a + 10) / 100) * ALT_H; // 显示 -10°..90°

  // 甘特区背景（计划 + 实际两条泳道）
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, GANTT_TOP - 6, W, GANTT_H + 8);
  ctx.fillRect(0, ACT_TOP - 6, W, ACT_H + 12);

  // 高度网格
  ctx.font = '11px sans-serif';
  for (let a = 0; a <= 90; a += 15) {
    ctx.strokeStyle = a === 0 ? '#31436e' : '#1c2742';
    ctx.beginPath(); ctx.moveTo(0, y(a)); ctx.lineTo(W, y(a)); ctx.stroke();
    ctx.fillStyle = '#8fa3c8';
    ctx.fillText(a + '°', 4, y(a) - 3);
  }

  // 时间网格
  const spanMin = (view.end - view.start) / 60000;
  const stepMin = [10, 15, 30, 60, 120, 240, 360].find(s => spanMin / s <= 12) || 720;
  const t0 = Math.ceil(view.start / (stepMin * 60000)) * stepMin * 60000;
  ctx.textAlign = 'center';
  for (let t = t0; t <= view.end; t += stepMin * 60000) {
    const px = x(t);
    ctx.strokeStyle = '#1c2742';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ALT_H); ctx.stroke();
    ctx.fillStyle = '#8fa3c8';
    ctx.fillText(fmtTime(t), px, ALT_H + 14);
  }
  ctx.textAlign = 'left';

  // 最低高度线
  ctx.strokeStyle = 'rgba(244,67,54,0.55)';
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(0, y(planData.minAlt)); ctx.lineTo(W, y(planData.minAlt)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,138,128,0.9)';
  ctx.fillText(`最低高度 ${planData.minAlt}°`, W - 96, y(planData.minAlt) - 4);

  // 各目标高度曲线
  planData.targets.forEach((tg, i) => {
    const c = tg.curve;
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < c.alts.length; k++) {
      if (c.alts[k] < -9) { started = false; continue; }
      const px = x(c.t0 + k * c.stepMin * 60000);
      const py = y(c.alts[k]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color(i);
    ctx.globalAlpha = selected === -1 ? 0.55 : (selected === i ? 1 : 0.14);
    ctx.lineWidth = selected === i ? 2.5 : 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  // 沿曲线描粗：选中目标的可见窗口；所有目标的已排观测段
  const drawSpan = (c, s, e, width, alpha, style) => {
    ctx.beginPath();
    let started = false;
    for (let k = 0; k < c.alts.length; k++) {
      const t = c.t0 + k * c.stepMin * 60000;
      if (t < s - c.stepMin * 60000 || t > e + c.stepMin * 60000) continue;
      const px = x(t), py = y(c.alts[k]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  };
  planData.targets.forEach((tg, i) => {
    if (selected === i) {
      tg.windows.forEach(w => drawSpan(tg.curve, w.start, w.end, 6, 0.9, color(i)));
    }
    if (tg.scheduled) {
      drawSpan(tg.curve, tg.scheduled.start, tg.scheduled.end, 5, 1, '#ffffff');
    }
  });

  // 实际执行区间沿高度曲线叠加：窗内绿色，超出窗口红色
  if (obsResult) {
    obsResult.items.forEach(it => {
      if (it.actualStart == null) return;
      const tg = planData.targets[it.index];
      const bad = it.outOfWindow;
      drawSpan(tg.curve, it.actualStart, it.actualEnd, 3.5, 0.95, bad ? '#ef5350' : '#66bb6a');
      if (bad) {
        // 逐分钟找出落在窗口外的片段，在曲线上描红粗段
        const inWin = t => tg.windows.some(w => t >= w.start && t <= w.end);
        let runS = null, prevT = null, prevIn = null;
        const c = tg.curve;
        for (let ms = it.actualStart; ms <= it.actualEnd; ms += 60000) {
          const inside = inWin(ms);
          if (runS === null) { runS = ms; prevIn = inside; }
          else if (inside !== prevIn) {
            if (!prevIn) drawSpan(c, runS, prevT, 8, 0.9, '#ef5350');
            runS = ms; prevIn = inside;
          }
          prevT = ms;
        }
        if (runS !== null && !prevIn) drawSpan(c, runS, it.actualEnd, 8, 0.9, '#ef5350');
      }
    });
  }

  // 子午线翻转点 ◆
  planData.targets.forEach((tg, i) => {
    if (tg.flipTime == null) return;
    if (selected !== -1 && selected !== i) return;
    const px = x(tg.flipTime), py = y(tg.flipAlt);
    if (px < -20 || px > W + 20) return;
    const s = selected === i ? 7 : 4.5;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = selected === i ? '#ff5252' : 'rgba(255,82,82,0.45)';
    ctx.fillRect(-s, -s, 2 * s, 2 * s);
    ctx.restore();
    if (selected === i) {
      ctx.fillStyle = '#ff8a80';
      ctx.fillText(`翻转 ${fmtTime(tg.flipTime)}`, px + 10, py - 8);
    }
  });

  // 计划甘特条（含转台/换向的灰色前置段）
  const gy = GANTT_TOP + 8, gh = GANTT_H - 16;
  planData.plan.forEach(p => {
    const col = color(p.index);
    const xSetup = x(p.start - (p.setupMs || 0));
    const x0 = x(p.start), x1 = x(p.end);
    if (p.setupMs > 0) {
      ctx.fillStyle = 'rgba(160,160,160,0.35)';
      ctx.fillRect(xSetup, gy, Math.max(1, x0 - xSetup), gh);
    }
    ctx.fillStyle = col;
    roundRectPath(ctx, x0, gy, Math.max(2, x1 - x0), gh, 4);
    ctx.fill();
    if (selected === p.index) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      roundRectPath(ctx, x0, gy, Math.max(2, x1 - x0), gh, 4);
      ctx.stroke();
    }
    const label = planData.targets[p.index].name;
    ctx.fillStyle = '#0b1020';
    if (x1 - x0 > ctx.measureText(label).width + 10) {
      ctx.fillText(label, x0 + 5, gy + gh / 2 + 4);
    } else {
      ctx.fillStyle = '#c8d4ee';
      ctx.fillText(label, x0, gy - 4);
    }
    p._x0 = xSetup; p._x1 = x1; // 命中测试用
  });

  // 图例
  ctx.fillStyle = '#5f6f92';
  ctx.fillText('计划序列（灰段 = 转台/换向）', 6, GANTT_TOP - 10);

  // 实际执行甘特条：窗内实色，窗口外部分红色，跳过以虚框 + ⏭ 标记
  const ay = ACT_TOP + 8, ah = ACT_H - 16;
  if (obsResult) {
    obsResult.items.forEach(it => {
      const col = color(it.index);
      if (it.status === 'skipped') {
        const tg = planData.targets[it.index];
        if (tg.scheduled) {
          const px0 = x(tg.scheduled.start), px1 = x(tg.scheduled.end);
          it._ax0 = px0; it._ax1 = px1;
          ctx.strokeStyle = 'rgba(180,190,210,0.7)';
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(px0, ay, Math.max(2, px1 - px0), ah);
          ctx.setLineDash([]);
          ctx.fillStyle = '#b0bec5';
          ctx.fillText('⏭ 跳过', px0 + 4, ay + ah / 2 + 4);
        }
        return;
      }
      const x0 = x(it.actualStart), x1 = x(it.actualEnd);
      it._ax0 = x0; it._ax1 = x1;
      // 底色条
      ctx.fillStyle = it.status === 'partial' ? 'rgba(255,183,77,0.75)' : col;
      roundRectPath(ctx, x0, ay, Math.max(2, x1 - x0), ah, 4);
      ctx.fill();
      // 窗口外的子区间描红
      if (it.outOfWindow) {
        const tg = planData.targets[it.index];
        ctx.fillStyle = 'rgba(229,83,80,0.85)';
        const markOutside = (a, b) => {
          const xa = x(a), xb = x(b);
          if (xb - xa > 0.5) ctx.fillRect(xa, ay, Math.max(1.5, xb - xa), ah);
        };
        let cur = it.actualStart;
        const segs = tg.windows.filter(w => w.end > it.actualStart && w.start < it.actualEnd)
          .sort((a, b2) => a.start - b2.start);
        for (const w of segs) {
          if (w.start > cur) markOutside(cur, Math.min(w.start, it.actualEnd));
          cur = Math.max(cur, Math.min(w.end, it.actualEnd));
        }
        if (cur < it.actualEnd) markOutside(cur, it.actualEnd);
      }
      if (it.underexposed) {
        ctx.strokeStyle = '#ffb74d';
        ctx.lineWidth = 2;
        roundRectPath(ctx, x0, ay, Math.max(2, x1 - x0), ah, 4);
        ctx.stroke();
      }
      if (selected === it.index) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        roundRectPath(ctx, x0, ay, Math.max(2, x1 - x0), ah, 4);
        ctx.stroke();
      }
      ctx.fillStyle = '#0b1020';
      ctx.font = '11px sans-serif';
      const glyph = it.status === 'partial' ? '◐' : '●';
      ctx.fillText(glyph, Math.max(2, x0 - 12), ay + ah / 2 + 4);
      ctx.font = '11px sans-serif';
    });
  }
  ctx.fillStyle = '#5f6f92';
  ctx.fillText('实际执行（绿=窗内 · 红=窗口外 · ◐部分 · ⏭跳过 · 橙框=曝光不足）', 6, ACT_TOP - 10);
}

/* ---- 时间轴交互：拖动平移 / 滚轮缩放 / 点击选中 ---- */
let drag = null;
tlc.addEventListener('pointerdown', e => {
  drag = { x: e.clientX, moved: false };
  tlc.setPointerCapture(e.pointerId);
});
tlc.addEventListener('pointermove', e => {
  if (!drag || !planData) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 3) drag.moved = true;
  const W = tlc.clientWidth;
  const dt = dx / W * (view.end - view.start);
  view.start -= dt;
  view.end -= dt;
  drag.x = e.clientX;
  renderTimeline();
});
tlc.addEventListener('pointerup', e => {
  if (drag && !drag.moved && planData) {
    const r = tlc.getBoundingClientRect();
    const my = e.clientY - r.top, mx = e.clientX - r.left;
    if (my >= GANTT_TOP - 6 && my < GANTT_TOP + GANTT_H + 4) {
      for (const p of planData.plan) {
        if (mx >= (p._x0 ?? 0) - 2 && mx <= (p._x1 ?? 0) + 2) { selectTarget(p.index); break; }
      }
    } else if (obsResult && my >= ACT_TOP - 6 && my < ACT_TOP + ACT_H + 6) {
      for (const it of obsResult.items) {
        if (it._ax0 != null && mx >= it._ax0 - 2 && mx <= (it._ax1 ?? it._ax0) + 2) {
          selectTarget(it.index); break;
        }
      }
    }
  }
  drag = null;
});
tlc.addEventListener('wheel', e => {
  if (!planData) return;
  e.preventDefault();
  const r = tlc.getBoundingClientRect();
  const f = (e.clientX - r.left) / r.width;
  const t = view.start + f * (view.end - view.start);
  const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
  view.start = t - (t - view.start) * k;
  view.end = t + (view.end - t) * k;
  if (view.end - view.start < 10 * 60000) view.end = view.start + 10 * 60000;
  renderTimeline();
}, { passive: false });

/* ================= 图例 / 详情 / 结果表 ================= */
function renderLegend() {
  const el = $('legend');
  el.innerHTML = '';
  planData.targets.forEach((tg, i) => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (selected === i ? ' sel' : '');
    const it = obsItemOf(i);
    let mark = tg.scheduled ? '' : ' ⚠';
    if (it) mark = it.status === 'skipped' ? ' ⏭' : (it.outOfWindow ? ' 🔴' : ' ✅');
    chip.innerHTML = `<span class="sw" style="background:${color(i)}"></span>${esc(tg.name)}${mark}`;
    chip.title = it && it.outOfWindow ? `窗口外 ${it.outsideMin} 分钟` : (tg.scheduled ? '已排入' : tg.reason);
    chip.addEventListener('click', () => selectTarget(i));
    el.appendChild(chip);
  });
  const reset = document.createElement('button');
  reset.className = 'chip';
  reset.textContent = '重置视图';
  reset.addEventListener('click', () => {
    view.start = planData.night.start - 30 * 60000;
    view.end = planData.night.end + 30 * 60000;
    renderTimeline();
  });
  el.appendChild(reset);
}

function selectTarget(i) {
  selected = selected === i ? -1 : i;
  renderTimeline();
  renderLegend();
  renderDetail();
}

function renderDetail() {
  const el = $('detail');
  if (selected < 0 || !planData) {
    el.innerHTML = '<p class="hint">点击图例、甘特条或表格中的目标，查看其可见窗口与子午线翻转点。</p>';
    return;
  }
  const tg = planData.targets[selected];
  let html = `<h3><span class="sw" style="background:${color(selected)}"></span> ${esc(tg.name)}</h3>`;
  html += `<p>赤经 ${esc(tg.ra)} · 赤纬 ${esc(tg.dec)} · 曝光 ${tg.expMin} 分钟 · ` +
          `最高高度 ${tg.maxAlt.toFixed(1)}°（${fmtTime(tg.maxAltTime)}）</p>`;
  html += tg.flipTime != null
    ? `<p>🔁 子午线翻转点：<b>${fmtTime(tg.flipTime)}</b>（高度 ${tg.flipAlt.toFixed(1)}°）</p>`
    : '<p>本夜不经过子午线（无翻转点）</p>';
  if (tg.windows.length) {
    html += '<p>连续可见窗口：</p><ul>' + tg.windows.map(w =>
      `<li>${fmtTime(w.start)} – ${fmtTime(w.end)}（${w.side === 'E' ? '东升侧' : '西落侧'}，${fmtDur(w.end - w.start)}）</li>`
    ).join('') + '</ul>';
  } else {
    html += '<p>夜间无满足高度条件的窗口。</p>';
  }
  html += tg.scheduled
    ? `<p class="ok">✅ 计划排入：${fmtTime(tg.scheduled.start)} – ${fmtTime(tg.scheduled.end)}（${tg.scheduled.side === 'E' ? '东升侧' : '西落侧'}）</p>`
    : `<p class="bad">❌ 未排入：${esc(tg.reason)}</p>`;

  const it = obsItemOf(selected);
  if (it) {
    html += '<p>📝 执行记录：';
    if (it.status === 'skipped') {
      html += `<b>${it.statusLabel}</b>（已跳过）</p>`;
    } else {
      html += `<b>${it.statusLabel}</b> · 实际 ${fmtTime(it.actualStart)} – ${fmtTime(it.actualEnd)}` +
              `（${it.actualMin} 分钟） · 开始偏差 ${fmtDev(it.startDevMin)} · 结束偏差 ${fmtDev(it.endDevMin)}</p>`;
      const flags = [];
      if (it.outOfWindow) flags.push(`<span class="badge out">超出可见窗口 ${it.outsideMin} 分钟</span>`);
      if (it.underexposed) flags.push(`<span class="badge under">曝光不足（计划 ${it.plannedExpMin} 分钟）</span>`);
      if (!flags.length) flags.push('<span class="badge ok">窗口内且曝光达标</span>');
      html += '<p>' + flags.join('') + '</p>';
    }
  }
  el.innerHTML = html;
}

function renderPlanTables() {
  const pb = $('planTable').querySelector('tbody');
  pb.innerHTML = '';
  planData.plan.forEach((p, n) => {
    const tg = planData.targets[p.index];
    const setup = [];
    if (p.slewMin) setup.push(`转台 ${p.slewMin} 分`);
    if (p.flipBefore) setup.push(`换向 ${planData.flipMin} 分`);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${n + 1}</td><td><span class="sw" style="background:${color(p.index)}"></span>${esc(tg.name)}</td>` +
      `<td>${fmtTime(p.start)}</td><td>${fmtTime(p.end)}</td><td>${fmtDur(p.end - p.start)}</td>` +
      `<td>${p.side === 'E' ? '东升侧' : '西落侧'}</td><td>${setup.join(' + ') || '—'}</td>`;
    tr.addEventListener('click', () => selectTarget(p.index));
    pb.appendChild(tr);
  });
  if (!planData.plan.length) pb.innerHTML = '<tr><td colspan="7">无目标可排入</td></tr>';

  const fb = $('failTable').querySelector('tbody');
  fb.innerHTML = '';
  const fails = planData.targets.filter(t => !t.scheduled);
  if (!fails.length) {
    fb.innerHTML = '<tr><td colspan="2">🎉 全部目标均已排入</td></tr>';
  } else {
    fails.forEach(tg => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><span class="sw" style="background:${color(tg.index)}"></span>${esc(tg.name)}</td>` +
        `<td>${esc(tg.reason)}</td>`;
      tr.addEventListener('click', () => selectTarget(tg.index));
      fb.appendChild(tr);
    });
  }
}

/* ================= 执行记录录入 / 偏差分析 ================= */
function ensureForm(index) {
  if (!obsForms[index]) obsForms[index] = { status: 'completed', start: '', end: '' };
  return obsForms[index];
}

function renderObsTable() {
  const tb = $('obsTable').querySelector('tbody');
  tb.innerHTML = '';
  let seq = 0;
  orderedIndices().forEach(index => {
    const tg = planData.targets[index];
    const f = ensureForm(index);
    const it = obsItemOf(index);
    const tr = document.createElement('tr');
    if (it && it.outOfWindow) tr.className = 'row-bad';
    else if (it && it.underexposed) tr.className = 'row-warn';

    const seqCell = tg.scheduled ? ++seq : '—';
    const statusOpts = [['completed', '完成'], ['partial', '部分完成'], ['skipped', '跳过']]
      .map(([v, l]) => `<option value="${v}"${f.status === v ? ' selected' : ''}>${l}</option>`).join('');
    const liveMs = (() => {
      const s = localInputToMs(f.start), e = localInputToMs(f.end);
      return Number.isFinite(s) && Number.isFinite(e) && e > s ? Math.round((e - s) / 60000) : null;
    })();
    const actualMin = it ? it.actualMin : liveMs;
    const disabled = f.status === 'skipped' ? ' disabled' : '';

    const flags = [];
    if (it) {
      if (it.status === 'skipped') flags.push('<span class="badge under">已跳过</span>');
      else {
        if (it.outOfWindow) flags.push(`<span class="badge out">窗口外 ${it.outsideMin} 分</span>`);
        if (it.underexposed) flags.push(`<span class="badge under">曝光不足</span>`);
        if (!it.plannedStart) flags.push('<span class="badge under">计划外目标</span>');
        if (!flags.length) flags.push('<span class="badge ok">达标</span>');
      }
    }

    tr.innerHTML =
      `<td>${seqCell}</td>` +
      `<td class="tname"><span class="sw" style="background:${color(index)}"></span>${esc(tg.name)}</td>` +
      `<td><select data-k="status" data-i="${index}">${statusOpts}</select></td>` +
      `<td><input type="datetime-local" step="60" data-k="start" data-i="${index}" value="${esc(f.start)}"${disabled}></td>` +
      `<td><input type="datetime-local" step="60" data-k="end" data-i="${index}" value="${esc(f.end)}"${disabled}></td>` +
      `<td class="livemin">${actualMin != null ? actualMin + ' 分' : '—'}</td>` +
      `<td>${it ? fmtDev(it.startDevMin) : '—'}</td>` +
      `<td>${it ? fmtDev(it.endDevMin) : '—'}</td>` +
      `<td>${flags.join('') || '<span class="hint">未提交</span>'}</td>`;
    tr.querySelector('.tname').addEventListener('click', () => selectTarget(index));
    tr.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('input', () => {
        obsForms[el.dataset.i][el.dataset.k] = el.value;
        if (el.dataset.k === 'status') { renderObsTable(); return; } // 切换跳过需禁用时间框
        if (!it) { // 未提交记录时在时长列实时预览
          const s = localInputToMs(f.start), e = localInputToMs(f.end);
          tr.querySelector('.livemin').textContent =
            Number.isFinite(s) && Number.isFinite(e) && e > s ? Math.round((e - s) / 60000) + ' 分' : '—';
        }
      });
    });
    tb.appendChild(tr);
  });
}

function renderObsSummary() {
  const el = $('obsSummary');
  if (!obsResult) { el.hidden = true; el.innerHTML = ''; return; }
  const s = obsResult.summary;
  const pct = (s.completionRate * 100).toFixed(0);
  const bad = s.outOfWindowCount + s.underexposedCount;
  el.innerHTML =
    `<span class="stat">完成率 <b>${pct}%</b>（完成 ${s.completed}/${s.totalTargets}${s.recorded ? `，已记录 ${s.recorded}` : ''}）</span>` +
    `<span class="stat">部分完成 <b>${s.partial}</b> · 跳过 <b>${s.skipped}</b></span>` +
    `<span class="stat${s.outOfWindowCount ? ' bad' : ''}">窗口外 <b>${s.outOfWindowCount}</b> 条</span>` +
    `<span class="stat${s.underexposedCount ? ' warn' : ''}">曝光不足 <b>${s.underexposedCount}</b> 条</span>` +
    `<span class="stat">实际总曝光 <b>${s.totalActualMin}</b> 分 / 计划 ${s.totalPlannedExpMin} 分</span>` +
    `<span class="stat${bad ? ' warn' : ''}">总绝对偏差 <b>${s.totalAbsDevMin}</b> 分（开始 ${s.totalAbsStartDevMin} + 结束 ${s.totalAbsEndDevMin}）</span>`;
  el.hidden = false;
}

$('fillPlanned').addEventListener('click', () => {
  if (!planData) return;
  planData.plan.forEach(p => {
    const f = ensureForm(p.index);
    f.status = 'completed';
    f.start = msToLocalInput(p.start);
    f.end = msToLocalInput(p.end);
  });
  renderObsTable();
});

$('clearObsForm').addEventListener('click', () => {
  obsForms = {};
  $('obsStatus').textContent = '';
  renderObsTable();
});

$('submitObs').addEventListener('click', async () => {
  if (!planData || !lastPlanBody) return;
  const observations = [];
  for (const index of orderedIndices()) {
    const f = obsForms[index];
    if (!f) continue;
    const tg = planData.targets[index];
    if (f.status === 'skipped') {
      observations.push({ index, status: 'skipped' });
      continue;
    }
    const empty = !f.start && !f.end;
    if (empty) continue;
    const s = localInputToMs(f.start), e = localInputToMs(f.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      $('obsStatus').innerHTML = `<span class="bad">「${esc(tg.name)}」时间格式不完整</span>`;
      return;
    }
    if (e <= s) {
      $('obsStatus').innerHTML = `<span class="bad">「${esc(tg.name)}」结束时间需晚于开始时间</span>`;
      return;
    }
    observations.push({ index, status: f.status, actualStart: s, actualEnd: e });
  }
  if (!observations.length) {
    $('obsStatus').innerHTML = '<span class="warn">请先至少录入一条执行记录</span>';
    return;
  }
  $('obsStatus').textContent = '提交中…';
  try {
    const r = await fetch('/api/observations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...lastPlanBody, observations }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '提交失败');
    obsResult = data;
    $('obsStatus').innerHTML = '<span class="ok">✅ 已保存（重复提交自动覆盖）</span>';
    renderTimeline();
    renderLegend();
    renderDetail();
    renderObsTable();
    renderObsSummary();
  } catch (e) {
    $('obsStatus').innerHTML = '<span class="bad">错误：' + esc(e.message) + '</span>';
  }
});

/* ================= 初始化 ================= */
window.addEventListener('resize', () => { renderHorizon(); renderTimeline(); });

(async function init() {
  $('date').value = new Date().toISOString().slice(0, 10);
  renderHorizon();
  try {
    const r = await fetch('/api/samples');
    targets = await r.json();
    renderTargets();
  } catch (e) {
    $('status').textContent = '示例目标载入失败：' + e.message;
  }
})();
