'use strict';

/**
 * 天文计算核心：恒星时、太阳位置、高度方位、天文夜、可见窗口与子午线翻转点。
 * 公式来源：Meeus《Astronomical Algorithms》低精度版本，精度约 0.01°，对规划足够。
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MIN_MS = 60000;

function jdFromMs(ms) {
  return ms / 86400000 + 2440587.5;
}

/** 格林尼治平恒星时（度） */
function gmstDeg(jd) {
  const T = (jd - 2451545.0) / 36525;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * T * T - (T * T * T) / 38710000;
  return ((g % 360) + 360) % 360;
}

/** 地方平恒星时（度），东经为正 */
function lstDeg(jd, lonDeg) {
  return ((gmstDeg(jd) + lonDeg) % 360 + 360) % 360;
}

/** 太阳视赤经赤纬（度） */
function sunRaDecDeg(jd) {
  const T = (jd - 2451545.0) / 36525;
  const L0 = ((280.46646 + 36000.76983 * T) % 360 + 360) % 360;
  const M = 357.52911 + 35999.05029 * T;
  const Mr = M * D2R;
  const C = (1.914602 - 0.004817 * T) * Math.sin(Mr)
          + 0.019993 * Math.sin(2 * Mr)
          + 0.000289 * Math.sin(3 * Mr);
  const omega = (125.04 - 1934.136 * T) * D2R;
  const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * D2R;
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * R2D;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) * R2D;
  return { ra: ((ra % 360) + 360) % 360, dec };
}

/**
 * 由赤经赤纬（度）、纬度与地方恒星时计算高度/方位/时角。
 * 时角归一化到 (-180, 180]，负值表示子午线以东（上升侧）。
 */
function altAz(raDeg, decDeg, latDeg, lstDegV) {
  const ha = ((lstDegV - raDeg + 540) % 360) - 180;
  const haR = ha * D2R, decR = decDeg * D2R, latR = latDeg * D2R;
  const sinAlt = Math.sin(decR) * Math.sin(latR) + Math.cos(decR) * Math.cos(latR) * Math.cos(haR);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosA = (Math.sin(decR) - Math.sin(alt) * Math.sin(latR)) / (Math.cos(alt) * Math.cos(latR));
  let az = Math.acos(Math.max(-1, Math.min(1, cosA)));
  if (Math.sin(haR) > 0) az = 2 * Math.PI - az;
  return { alt: alt * R2D, az: az * R2D, ha };
}

/**
 * 计算给定日期（当地中午到次日中午）的黑夜区间。
 * 依次尝试天文暮光(-18°)、航海(-12°)、民用(-6°)、日没(0°)，取最深的可用阈值。
 */
function findNight(dateStr, lat, lon) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // 当地平正午对应的 UTC 毫秒
  const noonUtc = Date.UTC(y, m - 1, d, 12) - (lon / 15) * 3600000;
  const step = MIN_MS;
  const n = 24 * 60 + 1;
  const sunAlt = new Array(n);
  for (let i = 0; i < n; i++) {
    const jd = jdFromMs(noonUtc + i * step);
    const sun = sunRaDecDeg(jd);
    sunAlt[i] = altAz(sun.ra, sun.dec, lat, lstDeg(jd, lon)).alt;
  }
  const thresholds = [
    { deg: -18, label: '天文夜（太阳 < -18°）' },
    { deg: -12, label: '航海暮光（太阳 < -12°）' },
    { deg: -6,  label: '民用暮光（太阳 < -6°）' },
    { deg: 0,   label: '日没后（太阳 < 0°）' },
  ];
  for (const th of thresholds) {
    let bestStart = -1, bestLen = 0, cur = -1;
    for (let i = 0; i < n; i++) {
      if (sunAlt[i] < th.deg) {
        if (cur < 0) cur = i;
        if (i - cur + 1 > bestLen) { bestLen = i - cur + 1; bestStart = cur; }
      } else cur = -1;
    }
    if (bestLen >= 30) {
      return {
        start: noonUtc + bestStart * step,
        end: noonUtc + (bestStart + bestLen) * step,
        label: th.label,
        sunLimit: th.deg,
      };
    }
  }
  return null; // 极昼
}

/** 地平线遮挡轮廓：72 个方位仓（每 5°），线性插值 */
function makeHorizonFn(horizon) {
  const h = Array.isArray(horizon) && horizon.length === 72
    ? horizon.map(v => Math.max(0, Math.min(89, Number(v) || 0)))
    : new Array(72).fill(0);
  return (az) => {
    const x = (((az % 360) + 360) % 360) / 5;
    const i = Math.floor(x) % 72;
    const j = (i + 1) % 72;
    const f = x - Math.floor(x);
    return h[i] * (1 - f) + h[j] * f;
  };
}

/**
 * 逐分钟扫描黑夜，计算目标的：
 * - 高度曲线（2 分钟采样，供前端绘图）
 * - 连续可见窗口（高度 ≥ max(最低高度, 地平线遮挡角)），并在子午线穿越处切分为东/西两段
 * - 子午线翻转点（上中天）与最高高度信息
 */
function computeTarget(raDeg, decDeg, night, lat, lon, minAlt, horizonFn) {
  const step = MIN_MS;
  const n = Math.max(1, Math.round((night.end - night.start) / step));
  const pts = new Array(n + 1);
  let maxAlt = -90, maxI = 0;
  for (let i = 0; i <= n; i++) {
    const t = night.start + i * step;
    const jd = jdFromMs(t);
    const { alt, az, ha } = altAz(raDeg, decDeg, lat, lstDeg(jd, lon));
    const effMin = Math.max(minAlt, horizonFn(az));
    pts[i] = { t, alt, az, ha, up: alt >= effMin };
    if (alt > maxAlt) { maxAlt = alt; maxI = i; }
  }

  // 上中天（时角由负过零转正是唯一的翻转点；下中天时角 ±180 跳变不匹配此条件）
  let flipTime = null, flipAlt = null;
  for (let i = 0; i < n; i++) {
    if (pts[i].ha <= 0 && pts[i + 1].ha > 0) {
      const f = (0 - pts[i].ha) / (pts[i + 1].ha - pts[i].ha);
      flipTime = Math.round(pts[i].t + f * step);
      flipAlt = pts[i].alt + f * (pts[i + 1].alt - pts[i].alt);
      break;
    }
  }

  // 连续可见区间，含翻转点的区间切分为 E（东升侧）/ W（西落侧）两段
  const segments = [];
  const closeRun = (a, b) => {
    const t0 = pts[a].t, t1 = pts[b].t;
    if (flipTime !== null && flipTime > t0 && flipTime < t1) {
      segments.push({ start: t0, end: flipTime, side: 'E' });
      segments.push({ start: flipTime, end: t1, side: 'W' });
    } else {
      segments.push({ start: t0, end: t1, side: pts[a].ha <= 0 ? 'E' : 'W' });
    }
  };
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    if (pts[i].up) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      closeRun(runStart, i - 1);
      runStart = -1;
    }
  }
  if (runStart >= 0) closeRun(runStart, n);

  // 绘图曲线：2 分钟采样的高度数组（紧凑传输）
  const stepMin = 2;
  const alts = [];
  for (let i = 0; i <= n; i += stepMin) alts.push(Math.round(pts[i].alt * 10) / 10);

  return {
    segments,
    flipTime,
    flipAlt: flipAlt === null ? null : Math.round(flipAlt * 10) / 10,
    maxAlt: Math.round(maxAlt * 10) / 10,
    maxAltTime: pts[maxI].t,
    maxAltAz: Math.round(pts[maxI].az),
    horizonAtMax: Math.round(horizonFn(pts[maxI].az) * 10) / 10,
    curve: { t0: night.start, stepMin, alts },
  };
}

/** 赤经解析：十进制小时、"HH:MM:SS"、"5h35m17s" 均可，返回度 */
function parseRa(v) {
  if (typeof v === 'number') return v * 15;
  const s = String(v).trim().toLowerCase()
    .replace(/[hms]/g, ':').replace(/\s+/g, ':')
    .replace(/:+/g, ':').replace(/^:|:$/g, '');
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
    return ((p[0] || 0) + (p[1] || 0) / 60 + (p[2] || 0) / 3600) * 15;
  }
  return Number(s) * 15;
}

/** 赤纬解析：十进制度、"±DD:MM:SS"、"-5°23′28″" 均可，返回度 */
function parseDec(v) {
  if (typeof v === 'number') return v;
  let s = String(v).trim().toLowerCase()
    .replace(/[dms°'′″"]/g, ':').replace(/\s+/g, ':')
    .replace(/:+/g, ':').replace(/^:|:$/g, '');
  const neg = s.startsWith('-');
  s = s.replace(/^[+-]/, '');
  let val;
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
    val = (p[0] || 0) + (p[1] || 0) / 60 + (p[2] || 0) / 3600;
  } else {
    val = Number(s);
  }
  return neg ? -val : val;
}

module.exports = { findNight, makeHorizonFn, computeTarget, parseRa, parseDec };
