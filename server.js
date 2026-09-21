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

app.post('/api/plan', (req, res) => {
  try {
    const b = req.body || {};
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
      return res.status(422).json({ error: '该日期与纬度下太阳始终不落（极昼），无夜间可排' });
    }

    const horizonFn = makeHorizonFn(b.horizon);
    const targets = list.map((t, i) => {
      const name = String(t.name || `目标 ${i + 1}`);
      const raDeg = parseRa(t.ra);
      const decDeg = parseDec(t.dec);
      if (!Number.isFinite(raDeg) || raDeg < 0 || raDeg >= 360) {
        throw new Error(`目标「${name}」：赤经无法解析（支持 05:35:17 或十进制小时）`);
      }
      if (!Number.isFinite(decDeg) || decDeg < -90 || decDeg > 90) {
        throw new Error(`目标「${name}」：赤纬需在 -90..90 之间`);
      }
      const expMin = Math.max(1, Math.min(600, Number(t.expMin) || 30));
      const d = computeTarget(raDeg, decDeg, night, lat, lon, minAlt, horizonFn);
      return { index: i, name, ra: String(t.ra), dec: String(t.dec), expMin, ...d };
    });

    const plan = schedule(targets, night, slewMin, flipMin);
    const byIndex = new Map(plan.map(p => [p.index, p]));
    const out = targets.map(tg => {
      const p = byIndex.get(tg.index) || null;
      const { segments, ...rest } = tg;
      return { ...rest, windows: segments, scheduled: p, reason: p ? null : reasonFor(tg, minAlt) };
    });

    res.json({
      night, minAlt, slewMin, flipMin,
      targets: out,
      plan: plan.map(p => ({ ...p, name: targets[p.index].name })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔭 夜间序列规划台已启动: http://localhost:${PORT}`));
