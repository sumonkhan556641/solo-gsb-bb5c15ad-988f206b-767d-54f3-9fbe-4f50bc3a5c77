'use strict';

/* ================= 全局状态 ================= */
const $ = id => document.getElementById(id);
const PALETTE = ['#4fc3f7', '#ffb74d', '#aed581', '#f06292', '#ba68c8',
                 '#4db6ac', '#fff176', '#ff8a65', '#90a4ae', '#e57373'];
const ALT_H = 330;          // 高度曲线区高度(px)
const GANTT_TOP = 348;      // 甘特区顶部
const PLAN_GH = 22;         // 计划段高度
const ACT_GAP = 4;
const ACT_GH = 16;          // 实际段高度
const CHART_H = 420;

let targets = [];                       // {name, ra, dec, expMin}
let horizon = new Array(72).fill(0);    // 每 5° 方位一个遮挡角
let planData = null;                    // /api/plan 返回
let planRequestBody = null;             // 生成当前计划时使用的请求体（提交记录时原样回传）
let obsMap = new Map();                 // targetIndex -> 存储记录 {index,name,rec,analysis}
let obsSummary = null;
let selected = -1;                      // 当前选中目标下标
const view = { start: 0, end: 1 };      // 时间轴可视范围(ms)

/* ================= 工具 ================= */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function lonHours() { return (parseFloat($('lon').value) || 0) / 15; }
/** 以地方平时（UTC + 经度/15）格式化时刻 */
function fmtTime(ms) {
  const d = new Date(ms + lonHours() * 3600000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}
function fmtDur(ms) { return Math.round(ms / 60000) + ' 分'; }
function color(i) { return PALETTE[i % PALETTE.length]; }

/** 偏差分钟格式化：+为推迟，-为提前 */
function fmtOff(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  return `${sign}${Math.abs(v)} 分`;
}
function offClass(v) {
  if (v == null) return '';
  if (Math.abs(v) >= 10) return 'off-big';
  if (Math.abs(v) >= 3) return 'off-mid';
  return 'off-ok';
}

/**
 * 地方平时 HH:MM → UTC 毫秒。观测夜跨日：≥12:00 取观测日期当天晚上，
 * <12:00 取次日凌晨（与后端 night 的日期口径一致）。
 */
function solarToMs(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const dateStr = $('date').value;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const localMidnight = Date.UTC(y, mo - 1, d) - lonHours() * 3600000;
  const addDays = hh >= 12 ? 0 : 1;
  return localMidnight + addDays * 86400000 + hh * 3600000 + mm * 60000;
}
/** UTC 毫秒 → 地方平时 HH:MM */
function msToSolar(ms) {
  const d = new Date(ms + lonHours() * 3600000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
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
function planBody() {
  return {
    lat: Number($('lat').value),
    lon: Number($('lon').value),
    date: $('date').value,
    minAlt: Number($('minAlt').value),
    slewMin: Number($('slewMin').value),
    flipMin: Number($('flipMin').value),
    horizon,
    targets,
  };
}

$('planBtn').addEventListener('click', async () => {
  $('status').textContent = '计算中…';
  const body = planBody();
  try {
    const r = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '计算失败');
    planData = data;
    planRequestBody = body;
    obsMap = new Map();
    obsSummary = null;
    selected = -1;
    view.start = data.night.start - 30 * 60000;
    view.end = data.night.end + 30 * 60000;
    $('results').hidden = false;
    const off = lonHours();
    $('nightInfo').textContent =
      `${data.night.label}：${fmtTime(data.night.start)} → ${fmtTime(data.night.end)}` +
      `（地方平时 UTC${off >= 0 ? '+' : ''}${off.toFixed(1)}）`;
    renderAll();
    $('status').textContent = '';
    $('results').scrollIntoView({ behavior: 'smooth' });
    // 拉取此前为同一计划录入过的执行记录（同参数计划指纹一致）
    loadObservations();
  } catch (e) {
    $('status').textContent = '错误：' + e.message;
  }
});

/** 从后端恢复同计划的历史执行记录 */
async function loadObservations() {
  if (!planData) return;
  try {
    const r = await fetch(`/api/observations?planKey=${encodeURIComponent(planData.planKey)}`);
    if (!r.ok) return;
    const data = await r.json();
    obsMap = new Map((data.records || []).map(e => [e.index, e]));
    obsSummary = data.summary;
    renderAll();
  } catch (e) { /* 无历史记录时忽略 */ }
}

function renderAll() {
  renderTimeline();
  renderLegend();
  renderDetail();
  renderPlanTables();
  renderObsTable();
  renderExecSummary();
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

  // 甘特区背景
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, GANTT_TOP - 6, W, PLAN_GH + ACT_GAP + ACT_GH + 18);

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

  // 实际区间沿高度曲线叠加：窗内按状态着色，越窗段红色描粗
  planData.targets.forEach((tg, i) => {
    if (selected !== -1 && selected !== i) return;
    const e = obsMap.get(i);
    if (!e) return;
    const a = e.analysis;
    if (a.actualStart == null) return;
    drawSpan(tg.curve, a.actualStart, a.actualEnd, 3, 0.95,
      a.status === 'done' ? '#7fc97f' : '#ffb74d');
    (a.outsideIntervals || []).forEach(([s, en]) =>
      drawSpan(tg.curve, s, en, 4, 1, '#ff5252'));
  });

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

  // 甘特条：上排计划（含转台/换向灰色前置段），下排实际
  const py0 = GANTT_TOP + 6;
  const ay0 = py0 + PLAN_GH + ACT_GAP;
  const hitsPlan = [];
  const hitsAct = [];
  planData.plan.forEach(p => {
    const col = color(p.index);
    const xSetup = x(p.start - (p.setupMs || 0));
    const x0 = x(p.start), x1 = x(p.end);
    if (p.setupMs > 0) {
      ctx.fillStyle = 'rgba(160,160,160,0.35)';
      ctx.fillRect(xSetup, py0, Math.max(1, x0 - xSetup), PLAN_GH);
    }
    ctx.fillStyle = col;
    roundRectPath(ctx, x0, py0, Math.max(2, x1 - x0), PLAN_GH, 4);
    ctx.fill();
    if (selected === p.index) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      roundRectPath(ctx, x0, py0, Math.max(2, x1 - x0), PLAN_GH, 4);
      ctx.stroke();
    }
    const label = planData.targets[p.index].name;
    ctx.fillStyle = '#0b1020';
    if (x1 - x0 > ctx.measureText(label).width + 10) {
      ctx.fillText(label, x0 + 5, py0 + PLAN_GH / 2 + 4);
    }
    hitsPlan.push({ index: p.index, x0: xSetup, x1 });

    drawActualBar(ctx, x, p.index, x0, x1, py0, ay0, hitsAct);
  });
  // 未排入但有实际记录的目标（如补拍），仍在下排显示
  planData.targets.forEach((tg, i) => {
    if (tg.scheduled || !obsMap.has(i)) return;
    drawActualBar(ctx, x, i, -1e9, -1e9, py0, ay0, hitsAct);
  });

  // 图例
  ctx.fillStyle = '#5f6f92';
  ctx.fillText('计划序列（灰段 = 转台/换向）', 6, GANTT_TOP - 10);
  ctx.fillText('实际执行（绿=完成 / 橙=部分 / 红框=越窗 / ✕=跳过）', 6, ay0 + ACT_GH + 12);

  tlc._hitsPlan = hitsPlan;
  tlc._hitsAct = hitsAct;
}

/** 在下排绘制单条实际记录；返回命中区间 */
function drawActualBar(ctx, x, idx, planX0, planX1, py0, ay0, hitsAct) {
  const e = obsMap.get(idx);
  if (!e) return;
  const a = e.analysis;
  const col = color(idx);

  // 跳过：在计划段上画 ✕
  if (a.status === 'skipped' || a.actualStart == null) {
    if (planX0 > -1e8) {
      const cx0 = planX0 + 3, cx1 = Math.max(cx0 + 2, planX1 - 3);
      ctx.strokeStyle = '#ff5252';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx0, py0 + 3);
      ctx.lineTo(cx1, py0 + PLAN_GH - 3);
      ctx.moveTo(cx1, py0 + 3);
      ctx.lineTo(cx0, py0 + PLAN_GH - 3);
      ctx.stroke();
    }
    return;
  }

  const ax0 = x(a.actualStart), ax1 = x(a.actualEnd);
  ctx.fillStyle = a.status === 'done'
    ? 'rgba(127,201,127,0.85)' : 'rgba(255,183,77,0.85)';
  roundRectPath(ctx, ax0, ay0, Math.max(2, ax1 - ax0), ACT_GH, 3);
  ctx.fill();

  // 越窗子区间：红框 + 斜纹
  (a.outsideIntervals || []).forEach(([s, en]) => {
    const ox = x(s), ow = Math.max(1.5, x(en) - ox);
    ctx.save();
    ctx.beginPath();
    roundRectPath(ctx, ox, ay0, ow, ACT_GH, 3);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,82,82,0.9)';
    ctx.lineWidth = 1;
    for (let hx = ox - ACT_GH; hx < ox + ow + ACT_GH; hx += 5) {
      ctx.beginPath();
      ctx.moveTo(hx, ay0 + ACT_GH);
      ctx.lineTo(hx + ACT_GH, ay0);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, ox, ay0, ow, ACT_GH, 3);
    ctx.stroke();
  });

  if (selected === idx) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, ax0, ay0, Math.max(2, ax1 - ax0), ACT_GH, 3);
    ctx.stroke();
  }
  // 计划段边框残影（便于对比起止偏差）
  if (planX0 > -1e8 && (Math.abs(ax0 - planX0) > 2 || Math.abs(ax1 - planX1) > 2)) {
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(planX0 + 0.5, ay0 - 0.5, Math.max(2, planX1 - planX0), ACT_GH + 1);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  hitsAct.push({ index: idx, x0: ax0 - 2, x1: ax1 + 2 });
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
    if (my > GANTT_TOP - 6) {
      const ay0 = GANTT_TOP + 6 + PLAN_GH + ACT_GAP;
      let hit = null;
      if (my >= ay0 - 2) {
        for (const h of (tlc._hitsAct || [])) {
          if (mx >= h.x0 - 2 && mx <= h.x1 + 2) { hit = h.index; break; }
        }
      }
      if (hit == null) {
        for (const h of (tlc._hitsPlan || [])) {
          if (mx >= (h.x0 ?? 0) - 2 && mx <= (h.x1 ?? 0) + 2) { hit = h.index; break; }
        }
      }
      if (hit != null) selectTarget(hit);
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
    const mark = obsMap.has(i) ? markFor(obsMap.get(i).analysis) : '';
    chip.innerHTML = `<span class="sw" style="background:${color(i)}"></span>${esc(tg.name)}${tg.scheduled ? '' : ' ⚠'}${mark}`;
    chip.title = obsMap.get(i) ? `执行：${obsMap.get(i).analysis.statusLabel}` : (tg.scheduled ? '已排入' : tg.reason);
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

function markFor(a) {
  if (a.status === 'skipped') return ' ✕';
  if (a.outsideWindow) return ' ⛔';
  if (a.underexposed) return ' ◐';
  if (a.status === 'partial') return ' ◐';
  if (a.status === 'done') return ' ✅';
  return '';
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
    ? `<p class="ok">✅ 已排入：${fmtTime(tg.scheduled.start)} – ${fmtTime(tg.scheduled.end)}（${tg.scheduled.side === 'E' ? '东升侧' : '西落侧'}）</p>`
    : `<p class="bad">❌ 未排入：${esc(tg.reason)}</p>`;

  // 执行记录块
  const e = obsMap.get(selected);
  if (e) {
    const a = e.analysis;
    html += '<p>📝 执行记录：</p><ul>';
    if (a.status === 'skipped' || a.actualStart == null) {
      html += '<li class="bad">已跳过，未执行</li>';
    } else {
      html += `<li>实际：${fmtTime(a.actualStart)} – ${fmtTime(a.actualEnd)}，曝光 ${a.actualMin} 分钟（${esc(a.statusLabel)}）</li>`;
      if (tg.scheduled) {
        html += `<li class="${offClass(a.startOffsetMin)}">开始偏差 ${fmtOff(a.startOffsetMin)} · 结束偏差 ${fmtOff(a.endOffsetMin)}</li>`;
      }
      if (a.outsideWindow) {
        const iv = (a.outsideIntervals || []).map(([s, en]) =>
          `${fmtTime(s)}–${fmtTime(en)}`).join('，');
        html += `<li class="bad">⛔ 有 ${a.outsideMin} 分钟超出可见窗口（${iv}）</li>`;
      }
      if (a.underexposed) html += `<li class="warn">◐ 曝光不足：较计划少 ${a.shortMin} 分钟</li>`;
    }
    html += '</ul>';
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
    const a = obsMap.get(p.index)?.analysis;
    const tr = document.createElement('tr');
    tr.className = a
      ? a.outsideWindow ? 'row-outside'
        : a.underexposed ? 'row-underexposed'
        : a.status === 'skipped' ? 'row-skipped'
        : a.status === 'partial' ? 'row-partial' : 'row-done'
      : '';
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

/* ================= 执行记录表 ================= */
function obsRows() {
  // 计划序列中的目标在前，未排入目标附后
  const order = planData.plan.map(p => p.index);
  planData.targets.forEach((tg, i) => { if (!order.includes(i)) order.push(i); });
  return order;
}

function renderObsTable() {
  const tb = $('obsTable').querySelector('tbody');
  tb.innerHTML = '';
  obsRows().forEach(idx => {
    const tg = planData.targets[idx];
    const seqNo = planData.plan.findIndex(p => p.index === idx) + 1;
    const e = obsMap.get(idx);
    const a = e?.analysis;
    const tr = document.createElement('tr');
    tr.dataset.index = idx;
    tr.className = a
      ? [
          a.status === 'skipped' ? 'row-skipped'
            : a.status === 'done' ? 'row-done'
            : a.status === 'partial' ? 'row-partial' : '',
          a.outsideWindow ? 'row-outside' : '',
          a.underexposed ? 'row-underexposed' : '',
        ].filter(Boolean).join(' ')
      : '';

    const rec = e?.rec;
    const startVal = rec && rec.actualStart != null ? msToSolar(rec.actualStart)
      : tg.scheduled ? msToSolar(tg.scheduled.start) : '';
    const endVal = rec && rec.actualEnd != null ? msToSolar(rec.actualEnd)
      : tg.scheduled ? msToSolar(tg.scheduled.end) : '';
    const disabled = a?.status === 'skipped' ? 'disabled' : '';

    tr.innerHTML =
      `<td>${seqNo || '—'}</td>` +
      `<td class="tgname"><span class="sw" style="background:${color(idx)}"></span>${esc(tg.name)}</td>` +
      `<td><select class="ostatus">
          <option value="">未记录</option>
          <option value="done"${a?.status === 'done' ? ' selected' : ''}>完成</option>
          <option value="partial"${a?.status === 'partial' ? ' selected' : ''}>部分完成</option>
          <option value="skipped"${a?.status === 'skipped' ? ' selected' : ''}>跳过</option>
        </select></td>` +
      `<td><input class="ostart" type="time" step="60" value="${startVal}" ${disabled}></td>` +
      `<td><input class="oend" type="time" step="60" value="${endVal}" ${disabled}></td>` +
      `<td class="cell-actual">${actualCell(a)}</td>` +
      `<td class="cell-soff ${offClass(a?.startOffsetMin)}">${a ? fmtOff(a.startOffsetMin) : '—'}</td>` +
      `<td class="cell-eoff ${offClass(a?.endOffsetMin)}">${a ? fmtOff(a.endOffsetMin) : '—'}</td>` +
      `<td class="cell-outside">${outsideCell(a)}</td>` +
      `<td class="cell-verdict">${verdictCell(a, tg)}</td>` +
      `<td><button class="osave">提交</button></td>`;
    tb.appendChild(tr);
  });
}

function actualCell(a) {
  if (!a) return '—';
  if (a.status === 'skipped') return '<span class="bad">0（跳过）</span>';
  return String(a.actualMin ?? '—');
}
function outsideCell(a) {
  if (!a || a.actualStart == null) return '—';
  return a.outsideWindow
    ? `<span class="bad">⛔ ${a.outsideMin} 分</span>`
    : '<span class="ok">窗内</span>';
}
function verdictCell(a, tg) {
  if (!a) return '<span class="hint">待录入</span>';
  if (a.status === 'skipped') return '<span class="bad">已跳过</span>';
  const notes = [];
  if (a.outsideWindow) notes.push('<span class="bad">超出可见窗口</span>');
  if (a.underexposed) notes.push(`<span class="warn">曝光不足 −${a.shortMin} 分</span>`);
  if (a.status === 'partial') {
    const gap = Math.round((tg.expMin - (a.actualMin || 0)) * 10) / 10;
    notes.push(gap > 0
      ? `<span class="warn">部分完成，少 ${gap} 分</span>`
      : '<span class="ok">部分完成</span>');
  }
  if (!notes.length) notes.push(`<span class="ok">${esc(a.statusLabel)}·正常</span>`);
  return notes.join('<br>');
}

/** 状态下拉即时切换：跳过时禁用时间输入并清空 */
$('obsTable').addEventListener('change', ev => {
  const sel = ev.target.closest('.ostatus');
  if (!sel) return;
  const tr = sel.closest('tr');
  const disabled = sel.value === 'skipped';
  tr.querySelector('.ostart').disabled = disabled;
  tr.querySelector('.oend').disabled = disabled;
});

/** 提交单行记录；同一目标再次提交即覆盖 */
$('obsTable').addEventListener('click', async ev => {
  const btn = ev.target.closest('.osave');
  if (!btn) return;
  const tr = btn.closest('tr');
  const idx = Number(tr.dataset.index);
  const status = tr.querySelector('.ostatus').value;
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '…';
  try {
    const record = { index: idx };
    if (status === '') {
      record.status = ''; // 清除该目标记录
    } else {
      record.status = status;
      if (status !== 'skipped') {
        const sMs = solarToMs(tr.querySelector('.ostart').value);
        const eMs = solarToMs(tr.querySelector('.oend').value);
        if (sMs == null || eMs == null) throw new Error('请填写合法的实际开始/结束时间（HH:MM）');
        if (eMs <= sMs) throw new Error('结束时间需晚于开始时间（凌晨时间请确认跨日）');
        record.actualStart = sMs;
        record.actualEnd = eMs;
      }
    }
    await submitObservations([record]);
  } catch (e) {
    $('status').textContent = '提交失败：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
});

async function submitObservations(records) {
  $('status').textContent = '保存执行记录…';
  const r = await fetch('/api/observations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...planRequestBody, planKey: planData?.planKey, records }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '保存失败');
  obsMap = new Map((data.records || []).map(e => [e.index, e]));
  obsSummary = data.summary;
  $('status').textContent = '';
  // 保留表格中未提交行的输入：只重建一次（其他行本就与存储一致）
  renderAll();
}

/* ================= 汇总 ================= */
function renderExecSummary() {
  const el = $('execSummary');
  if (!planData || !obsSummary || !obsSummary.recordedCount) { el.hidden = true; return; }
  const s = obsSummary;
  const rate = s.completionRate == null ? '—' : (s.completionRate * 100).toFixed(0) + '%';
  const avg = s.avgAbsOffsetMin == null ? '—' : s.avgAbsOffsetMin + ' 分';
  const warnings = [];
  if (s.outsideCount) warnings.push(`<span class="bad">⛔ ${s.outsideCount} 条越窗</span>`);
  if (s.underexposedCount) warnings.push(`<span class="warn">◐ ${s.underexposedCount} 条曝光不足</span>`);
  if (s.unrecorded > 0) warnings.push(`<span class="hint">${s.unrecorded} 个已排目标待录入</span>`);
  el.innerHTML =
    `<span>完成率 <b>${rate}</b> <small class="hint">（完成 ${s.done} · 部分 ${s.partial} · 跳过 ${s.skipped}，部分按 0.5 计，基数 ${s.scheduledCount} 个已排目标）</small></span>` +
    `<span>总偏差 <b>${s.totalAbsOffsetMin} 分</b></span>` +
    `<span>平均偏差 <b>${avg}</b></span>` +
    `<span>累计实际曝光 <b>${s.actualExposureMin} 分</b></span>` +
    (warnings.length ? `<span>${warnings.join(' · ')}</span>` : '');
  el.hidden = false;
}

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
