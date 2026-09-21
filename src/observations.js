'use strict';

/**
 * 执行记录存储与偏差分析。
 *
 * - 记录以「规划指纹 planKey + 目标序号」为键，同一目标重复提交以后一次覆盖；
 *   存储在内存中（重启即清空，适合单机规划台），按 LRU 方式限制计划数量。
 * - 偏差分析：以调度序列中的计划开始/结束时刻为基准，计算开始偏差、结束偏差、
 *   实际曝光分钟数，并识别实际区间落在该目标可见窗口之外的部分（含翻转点切分）。
 */

const MIN_MS = 60000;
const MAX_PLANS = 50;

const STATUSES = ['done', 'partial', 'skipped'];
const STATUS_LABEL = { done: '完成', partial: '部分完成', skipped: '跳过' };

/** 规划指纹：使同一组设置/地平线/目标产生同一键（字段顺序与解析后数值规范化） */
function planKeyFor(input) {
  const h = JSON.stringify(
    Array.isArray(input.horizon) && input.horizon.length === 72
      ? input.horizon.map(v => Math.round(Math.max(0, Math.min(89, Number(v) || 0)) * 10) / 10)
      : new Array(72).fill(0)
  );
  const targets = (Array.isArray(input.targets) ? input.targets : []).map(t => [
    String(t.name || ''), String(t.ra), String(t.dec),
    Math.round((Math.max(1, Math.min(600, Number(t.expMin) || 30))) * 10) / 10,
  ]);
  const canonical = JSON.stringify([
    round(input.lat, 6), round(input.lon, 6), String(input.date),
    round(input.minAlt, 4), round(input.slewMin, 4), round(input.flipMin, 4),
    h, targets,
  ]);
  return 'p' + hash32(canonical).toString(36);
}

function round(v, p) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : 0;
}

/** 非加密 32 位哈希（FNV-1a），仅用于生成短指纹 */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ---------------- 窗口区间分析 ---------------- */

/** 目标可见窗口（segments，按时间升序）覆盖 [s, e] 的毫秒数 */
function overlapMs(segments, s, e) {
  let sum = 0;
  for (const w of segments) {
    const a = Math.max(s, w.start);
    const b = Math.min(e, w.end);
    if (b > a) sum += b - a;
  }
  return sum;
}

/**
 * 实际区间相对可见窗口之外的子区间列表：
 * 依次从窗口之间的间隙与两端余量中扣除。
 */
function outsideIntervals(segments, s, e) {
  if (e <= s) return [];
  const out = [];
  let cursor = s;
  for (const w of segments) {
    if (w.start > cursor) out.push([cursor, Math.min(e, w.start)]);
    cursor = Math.max(cursor, Math.min(e, w.end));
    if (cursor >= e) break;
  }
  if (cursor < e) out.push([cursor, e]);
  return out.filter(([a, b]) => b > a);
}

/**
 * 对一条执行记录做偏差分析。
 * tg 为 /api/plan 输出的目标（含 windows、expMin），scheduled 为计划段或 null。
 */
function analyze(rec, tg, scheduled) {
  const { status, actualStart, actualEnd } = rec;
  const base = { status, statusLabel: STATUS_LABEL[status] || status };
  if (status === 'skipped' || actualStart == null || actualEnd == null) {
    return { ...base, actualStart: null, actualEnd: null, actualMin: 0 };
  }

  const windows = tg.windows || [];
  const withinMs = overlapMs(windows, actualStart, actualEnd);
  const totalMs = Math.max(0, actualEnd - actualStart);
  const outsideMs = Math.max(0, totalMs - withinMs);
  const plannedMin = tg.expMin;

  const out = {
    ...base,
    actualStart,
    actualEnd,
    actualMin: Math.round(totalMs / MIN_MS * 10) / 10,
    startOffsetMin: null,
    endOffsetMin: null,
    absStartOffsetMin: null,
    absEndOffsetMin: null,
    outsideMin: Math.round(outsideMs / MIN_MS * 10) / 10,
    outsideWindow: outsideMs > 30 * 1000, // 超过 30 秒视为越窗
    outsideIntervals: outsideIntervals(windows, actualStart, actualEnd),
    matchedWindow: null,
    underexposed: status === 'done' && totalMs < plannedMin * MIN_MS,
    shortMin: Math.max(0, Math.round((plannedMin * MIN_MS - totalMs) / MIN_MS * 10) / 10),
  };

  if (scheduled) {
    out.startOffsetMin = Math.round((actualStart - scheduled.start) / MIN_MS * 10) / 10;
    out.endOffsetMin = Math.round((actualEnd - scheduled.end) / MIN_MS * 10) / 10;
    out.absStartOffsetMin = Math.abs(out.startOffsetMin);
    out.absEndOffsetMin = Math.abs(out.endOffsetMin);
  }

  let best = null;
  for (const w of windows) {
    if (actualStart >= w.start - MIN_MS && actualStart <= w.end + MIN_MS) {
      if (!best || Math.abs(actualStart - w.start) < Math.abs(actualStart - best.start)) best = w;
    }
  }
  if (best) out.matchedWindow = { start: best.start, end: best.end, side: best.side };
  return out;
}

/** 汇总：完成率（含部分完成按 0.5 计）、总偏差与越窗/欠曝计数 */
function summarize(analyzed, scheduledCount) {
  let done = 0, partial = 0, skipped = 0, recorded = 0;
  let absStart = 0, absEnd = 0, signedStart = 0, signedEnd = 0, offsetN = 0;
  let outside = 0, underexposed = 0, actualMin = 0;

  for (const a of analyzed) {
    if (!a || !a.status) continue;
    recorded++;
    if (a.status === 'done') done++;
    else if (a.status === 'partial') partial++;
    else if (a.status === 'skipped') skipped++;
    if (typeof a.actualMin === 'number') actualMin += a.actualMin;
    if (a.outsideWindow) outside++;
    if (a.underexposed) underexposed++;
    if (a.absStartOffsetMin != null) {
      absStart += a.absStartOffsetMin;
      absEnd += a.absEndOffsetMin;
      signedStart += a.startOffsetMin;
      signedEnd += a.endOffsetMin;
      offsetN++;
    }
  }
  const basis = Math.max(0, scheduledCount || 0);
  const r1 = x => Math.round(x * 10) / 10;
  const rate = basis ? Math.min(1, (done + partial * 0.5) / basis) : null;
  const rateDone = basis ? Math.min(1, done / basis) : null;
  return {
    scheduledCount: basis,
    recordedCount: recorded,
    done, partial, skipped,
    unrecorded: Math.max(0, basis - recorded),
    completionRate: rate === null ? null : r1(rate),
    completionDoneRate: rateDone === null ? null : r1(rateDone),
    totalAbsOffsetMin: r1(absStart + absEnd),
    avgAbsOffsetMin: offsetN ? r1((absStart + absEnd) / (2 * offsetN)) : null,
    signedStartOffsetMin: r1(signedStart),
    signedEndOffsetMin: r1(signedEnd),
    outsideCount: outside,
    underexposedCount: underexposed,
    actualExposureMin: r1(actualMin),
  };
}

/* ---------------- 内存存储（LRU 覆盖） ---------------- */
/** planKey -> Map<targetIndex, { rec, analysis, updatedAt }> */
const store = new Map();
const planMeta = new Map(); // planKey -> { createdAt, lastWrite, scheduledCount, name }

/**
 * 覆盖写入（或删除，rec 为 null）。
 * 分析结果在写入时计算并一并存储，GET 无需再次提供计划上下文。
 */
function upsert(planKey, targetIndex, rec, tg, scheduled, metaName) {
  if (!store.has(planKey)) {
    if (store.size >= MAX_PLANS) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
      planMeta.delete(oldest);
    }
    store.set(planKey, new Map());
  }
  const m = store.get(planKey);
  if (rec === null) {
    m.delete(targetIndex);
  } else {
    m.set(targetIndex, {
      index: targetIndex,
      name: tg.name,
      rec,
      analysis: analyze(rec, tg, scheduled),
      updatedAt: Date.now(),
    });
  }
  const meta = planMeta.get(planKey) || { createdAt: Date.now() };
  meta.lastWrite = Date.now();
  if (metaName) meta.name = metaName;
  planMeta.set(planKey, meta);
  return snapshot(planKey, scheduledCountOf(planKey));
}

/** GET 时没有计划上下文：以最近一次写入时保存的 scheduledCount 汇总 */
function scheduledCountOf(planKey) {
  return planMeta.get(planKey)?.scheduledCount ?? 0;
}

function rememberScheduledCount(planKey, scheduledCount, name) {
  const meta = planMeta.get(planKey) || { createdAt: Date.now(), lastWrite: Date.now() };
  meta.scheduledCount = scheduledCount;
  if (name) meta.name = name;
  planMeta.set(planKey, meta);
}

/** 取某计划下的全部记录与汇总 */
function snapshot(planKey, scheduledCount) {
  const m = store.get(planKey);
  if (!m) return { planKey, records: [], summary: summarize([], scheduledCount || 0) };
  const entries = [...m.values()].sort((a, b) => a.index - b.index);
  if (scheduledCount == null) scheduledCount = scheduledCountOf(planKey);
  return {
    planKey,
    records: entries,
    summary: summarize(entries.map(e => e.analysis), scheduledCount),
    updatedAt: planMeta.get(planKey)?.lastWrite || null,
  };
}

function hasPlan(planKey) {
  return store.has(planKey);
}

module.exports = {
  STATUSES, STATUS_LABEL, MIN_MS,
  planKeyFor, analyze, summarize,
  upsert, snapshot, hasPlan, rememberScheduledCount,
  overlapMs, outsideIntervals,
};
