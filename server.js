'use strict';

const path = require('path');
const express = require('express');
const { findNight, makeHorizonFn, computeTarget, parseRa, parseDec } = require('./src/astro');
const { schedule } = require('./src/scheduler');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** 内置示例目标（J2000），随服务启动提供给前端自动载入 */
const SAMPLE_TARGETS = [
  { name: 'M31 仙女座星系',     ra: '00:42:44', dec: '+41:16:09', expMin: 45 },
  { name: 'M33 三角座星系',     ra: '01:33:51', dec: '+30:39:37', expMin: 40 },
  { name: 'M45 昴星团',         ra: '03:47:24', dec: '+24:07:00', expMin: 30 },
  { name: 'M42 猎户座大星云',   ra: '05:35:17', dec: '-05:23:28', expMin: 35 },
  { name: 'M13 武仙座球状星团', ra: '16:41:41', dec: '+36:27:36', expMin: 30 },
  { name: 'M57 环状星云',       ra: '18:53:35', dec: '+33:01:45', expMin: 25 },
  { name: 'M27 哑铃星云',       ra: '19:59:36', dec: '+22:43:16', expMin: 25 },
  { name: 'NGC 6960 面纱星云',  ra: '20:45:38', dec: '+30:42:30', expMin: 40 },
  { name: 'NGC 5128 半人马A',   ra: '13:25:28', dec: '-43:00:58', expMin: 30 },
];

app.get('/api/samples', (req, res) => res.json(SAMPLE_TARGETS));

/**
 * 规划计算核心：/api/plan 与 /api/observations 共用。
 * 校验请求、计算黑夜/窗口并执行调度，返回供接口序列化与偏差分析的完整上下文。
 */
function evaluatePlan(b) {
  const lat = Number(b.lat);
  const lon = Number(b.lon || 0);
  const date = String(b.date || '');
  const minAlt = Number(b.minAlt ?? 20);
  const slewMin = Math.max(0, Number(b.slewMin ?? 2));
  const flipMin = Math.max(0, Number(b.flipMin ?? 5));

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('纬度需在 -90..90 之间');
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('经度需在 -180..180 之间');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式应为 YYYY-MM-DD');
  if (!Number.isFinite(minAlt) || minAlt < 0 || minAlt > 89) throw new Error('最低高度需在 0..89 之间');

  const list = Array.isArray(b.targets) ? b.targets : [];
  if (!list.length) throw new Error('请至少添加一个目标');
  if (list.length > 60) throw new Error('目标数量过多（上限 60）');

  const night = findNight(date, lat, lon);
  if (!night) {
    const e = new Error('该日期与纬度下太阳始终不落（极昼），无夜间可排');
    e.status = 422;
    throw e;
  }

  const horizonArr = Array.isArray(b.horizon) && b.horizon.length === 72
    ? b.horizon.map(v => Math.max(0, Math.min(89, Number(v) || 0)))
    : new Array(72).fill(0);
  const horizonFn = makeHorizonFn(horizonArr);

  const inputTargets = [];
  const raw = list.map((t, i) => {
    const name = String(t.name || `目标 ${i + 1}`);
    const raStr = String(t.ra);
    const decStr = String(t.dec);
    const raDeg = parseRa(t.ra);
    const decDeg = parseDec(t.dec);
    if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360) {
      throw new Error(`目标「${name}」：赤经无法解析（支持 05:35:17 或十进制小时）`);
    }
    if (!Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90) {
      throw new Error(`目标「${name}」：赤纬需在 -90..90 之间`);
    }
    const expMin = Math.max(1, Math.min(600, Number(t.expMin) || 30));
    inputTargets.push({ name, ra: raStr, dec: decStr, expMin });
    const d = computeTarget(raDeg, decDeg, night, lat, lon, minAlt, horizonFn);
    return { index: i, name, ra: raStr, dec: decStr, expMin, ...d };
  });

  const plan = schedule(raw, night, slewMin, flipMin);
  const byIndex = new Map(plan.map(p => [p.index, p]));
  const targets = raw.map(tg => {
    const p = byIndex.get(tg.index) || null;
    const { segments, ...rest } = tg;
    return { ...rest, windows: segments, scheduled: p, reason: p ? null : reasonFor(tg, minAlt) };
  });
  const planOut = plan.map(p => ({ ...p, name: raw[p.index].name }));

  return {
    night, minAlt, slewMin, flipMin, horizonArr,
    inputTargets, raw, targets, plan: planOut,
  };
}

app.post('/api/plan', (req, res) => {
  try {
    const ctx = evaluatePlan(req.body || {});
    res.json({
      night: ctx.night, minAlt: ctx.minAlt, slewMin: ctx.slewMin, flipMin: ctx.flipMin,
      targets: ctx.targets,
      plan: ctx.plan,
    });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

/** 为未能排入的目标生成具体原因 */
function reasonFor(tg, minAlt) {
  if (tg.maxAlt < 0) {
    return `夜间始终位于地平线下（最高 ${tg.maxAlt.toFixed(1)}°）`;
  }
  if (tg.maxAlt < minAlt) {
    return `最高高度 ${tg.maxAlt.toFixed(1)}° 低于最低高度 ${minAlt}°`;
  }
  if (!tg.segments.length) {
    return `受地平线遮挡：最高点附近方位 ${tg.maxAltAz}° 处遮挡角 ${tg.horizonAtMax}°`;
  }
  const longest = Math.max(...tg.segments.map(s => s.end - s.start)) / 60000;
  if (longest < tg.expMin) {
    return `最长连续可见窗口 ${Math.floor(longest)} 分钟，短于曝光 ${tg.expMin} 分钟`;
  }
  return `与已排目标时间冲突：${tg.segments.length} 段可见窗口均被占用`;
}

/* ================= 执行记录与偏差分析 ================= */

const OBS_STATUSES = new Set(['completed', 'partial', 'skipped']);
const STATUS_LABEL = { completed: '完成', partial: '部分完成', skipped: '跳过' };
const MAX_OBS_PLANS = 200; // 内存中最多保留的计划签名数，超出淘汰最早者
/**
 * 执行记录内存库：planSignature -> Map(targetIndex -> record)
 * 同一计划上下文内，目标重复提交时以后一次覆盖。
 */
const observationStore = new Map();

const r1 = v => Math.round(v * 10) / 10;

function parseTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
}

/** 计划签名：观测站点、日期、约束、地平线与目标清单完全一致才视为同一计划 */
function planSignature(ctx, b) {
  return JSON.stringify({
    date: String(b.date || ''),
    lat: r1(Number(b.lat) * 1e6) / 1e6,
    lon: r1((Number(b.lon) || 0) * 1e6) / 1e6,
    minAlt: ctx.minAlt,
    slewMin: ctx.slewMin,
    flipMin: ctx.flipMin,
    horizon: ctx.horizonArr.map(v => Math.round(v * 100) / 100),
    targets: ctx.inputTargets,
  });
}

/** 记录按目标下标 / 计划序号 / 目标名匹配到本计划中的目标 */
function resolveTargetIndex(rec, ctx) {
  if (Number.isInteger(rec.index) && rec.index >= 0 && rec.index < ctx.targets.length) {
    return rec.index;
  }
  const seq = Number(rec.seq);
  if (Number.isInteger(seq) && seq >= 1 && seq <= ctx.plan.length) {
    return ctx.plan[seq - 1].index;
  }
  if (typeof rec.name === 'string' && rec.name.trim()) {
    const hits = ctx.targets.filter(t => t.name === rec.name.trim());
    if (hits.length === 1) return hits[0].index;
    if (hits.length > 1) throw new Error(`目标名「${rec.name.trim()}」不唯一，请改用 index 匹配`);
  }
  throw new Error(`无法将执行记录匹配到目标：${JSON.stringify(rec).slice(0, 100)}`);
}

/** 校验并归一化单条记录 */
function normalizeRecord(rec, ctx) {
  if (!rec || typeof rec !== 'object') throw new Error('执行记录需为对象');
  const index = resolveTargetIndex(rec, ctx);
  const tg = ctx.targets[index];
  const status = String(rec.status || '').toLowerCase();
  if (!OBS_STATUSES.has(status)) {
    throw new Error(`目标「${tg.name}」：状态需为 completed / partial / skipped`);
  }
  const out = { status, actualStart: null, actualEnd: null, note: String(rec.note || '').slice(0, 200), savedAt: Date.now() };
  if (status !== 'skipped') {
    const s = parseTs(rec.actualStart);
    const e = parseTs(rec.actualEnd);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      throw new Error(`目标「${tg.name}」：${STATUS_LABEL[status]}需提供实际开始与结束时间`);
    }
    if (e <= s) throw new Error(`目标「${tg.name}」：实际结束时间需晚于开始时间`);
    if (e - s > 12 * 3600000) throw new Error(`目标「${tg.name}」：单次观测时长不能超过 12 小时`);
    if (s < ctx.night.start - 3 * 3600000 || e > ctx.night.end + 3 * 3600000) {
      throw new Error(`目标「${tg.name}」：实际时间超出该夜范围过多（容差 3 小时）`);
    }
    out.actualStart = s;
    out.actualEnd = e;
  }
  return { index, record: out };
}

/** 实际区间与该目标全部可见窗口的重叠毫秒数 */
function windowOverlapMs(segments, s, e) {
  let ov = 0;
  for (const seg of segments) {
    ov += Math.max(0, Math.min(e, seg.end) - Math.max(s, seg.start));
  }
  return ov;
}

/** 对单条已保存记录做偏差分析 */
function analyzeOne(ctx, index, rec) {
  const tg = ctx.targets[index];
  const seqPos = ctx.plan.findIndex(p => p.index === index) + 1; // 1 基计划序号，0 = 未排入
  const item = {
    index,
    name: tg.name,
    seq: seqPos || null,
    status: rec.status,
    statusLabel: STATUS_LABEL[rec.status],
    plannedStart: tg.scheduled ? tg.scheduled.start : null,
    plannedEnd: tg.scheduled ? tg.scheduled.end : null,
    plannedExpMin: tg.expMin,
    actualStart: rec.actualStart,
    actualEnd: rec.actualEnd,
    actualMin: null,
    startDevMin: null,
    endDevMin: null,
    outOfWindow: false,
    outsideMin: 0,
    underexposed: false,
    note: rec.note || '',
    savedAt: rec.savedAt,
  };
  if (rec.status === 'skipped') return item;

  const durMs = rec.actualEnd - rec.actualStart;
  item.actualMin = r1(durMs / 60000);
  if (tg.scheduled) {
    item.startDevMin = r1((rec.actualStart - tg.scheduled.start) / 60000);
    item.endDevMin = r1((rec.actualEnd - tg.scheduled.end) / 60000);
  }
  const overlap = windowOverlapMs(ctx.raw[index].segments, rec.actualStart, rec.actualEnd);
  item.outsideMin = Math.max(0, r1((durMs - overlap) / 60000));
  item.outOfWindow = item.outsideMin > 0;
  item.underexposed = durMs / 60000 + 1e-6 < tg.expMin;
  return item;
}

/** 汇总完成率与总偏差 */
function summarize(ctx, items) {
  const timed = items.filter(it => it.actualStart !== null);
  const sum = f => timed.reduce((a, it) => a + (f(it) || 0), 0);
  const absStart = r1(sum(it => Math.abs(it.startDevMin || 0)));
  const absEnd = r1(sum(it => Math.abs(it.endDevMin || 0)));
  return {
    totalTargets: ctx.targets.length,
    scheduledCount: ctx.plan.length,
    recorded: items.length,
    completed: items.filter(it => it.status === 'completed').length,
    partial: items.filter(it => it.status === 'partial').length,
    skipped: items.filter(it => it.status === 'skipped').length,
    completionRate: ctx.targets.length ? r1(items.filter(it => it.status === 'completed').length / ctx.targets.length * 1000) / 1000 : 0,
    recordRate: ctx.targets.length ? r1(items.length / ctx.targets.length * 1000) / 1000 : 0,
    outOfWindowCount: items.filter(it => it.outOfWindow).length,
    underexposedCount: items.filter(it => it.underexposed).length,
    totalActualMin: r1(sum(it => it.actualMin || 0)),
    totalPlannedExpMin: r1(ctx.plan.reduce((a, p) => a + ctx.targets[p.index].expMin, 0)),
    totalAbsStartDevMin: absStart,
    totalAbsEndDevMin: absEnd,
    totalAbsDevMin: r1(absStart + absEnd),
  };
}

/**
 * 录入/覆盖执行记录并返回偏差分析。
 * 请求体与 /api/plan 相同，另带 observations 数组；
 * observations 为空数组时仅查询该计划上下文下已保存的记录。
 */
app.post('/api/observations', (req, res) => {
  try {
    const b = req.body || {};
    const ctx = evaluatePlan(b);
    const sig = planSignature(ctx, b);

    let bucket = observationStore.get(sig);
    if (!bucket) {
      bucket = new Map();
      observationStore.set(sig, bucket);
    }

    const incoming = Array.isArray(b.observations) ? b.observations : [];
    for (const rec of incoming) {
      const { index, record } = normalizeRecord(rec, ctx);
      bucket.set(index, record); // 同一目标重复提交：后一次覆盖
    }
    if (observationStore.size > MAX_OBS_PLANS) {
      observationStore.delete(observationStore.keys().next().value);
    }

    const items = [...bucket.keys()].sort((a, c) => a - c)
      .map(i => analyzeOne(ctx, i, bucket.get(i)));
    res.json({ night: ctx.night, items, summary: summarize(ctx, items) });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔭 夜间序列规划台已启动: http://localhost:${PORT}`));
