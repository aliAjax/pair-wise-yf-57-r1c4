/**
 * 纯合并逻辑：
 * - 三向逐字段合并（base / device / station）
 * - 冲突分叉（观察、轨迹留两版；样本本地优先并留档）
 * - 观察地点变更 -> 复核结论 + 关联样本核验立即失效（意见保留）
 * - 回站重复路段 / 重复观察归并（样本改挂，不静默丢弃）
 *
 * 这里不碰存储与时间来源，全部为纯函数，便于单测和断点续传重放。
 */
import {
  KindedFields,
  ObservationFields,
  RecordEnvelope,
  RecordKind,
  SampleFields,
  STATION_OWNED_FIELDS,
  TrackFields
} from './types';

export const TRACK_DUP_METERS = 50;
export const OBS_DUP_METERS = 80;
/** 同一轨迹点的时间窗：距离接近且相隔不超过该值才算重复路段。 */
export const TRACK_DUP_WINDOW_MS = 5 * 60 * 1000;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function defaultFields(kind: RecordKind): KindedFields[typeof kind] {
  if (kind === 'observation') {
    const f: ObservationFields = {
      note: '', risk: 'low', latitude: 0, longitude: 0, observedAt: '',
      reviewState: 'pending', reviewComment: '', reviewVoidReason: ''
    };
    return f;
  }
  if (kind === 'track') {
    const f: TrackFields = { latitude: 0, longitude: 0, at: '', source: 'manual' };
    return f;
  }
  const f: SampleFields = {
    code: '', species: '', count: 0, observationId: '',
    verifyState: 'pending', verifyComment: '', verifyVoidReason: ''
  };
  return f;
}

export function isStationOwned(kind: RecordKind, field: string): boolean {
  return STATION_OWNED_FIELDS[kind].has(field);
}

/** haversine 距离（米）。 */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 尽力解析现场时间（ISO 或 HH:MM:SS），无法比较时返回 null。 */
function parseTime(at: string): number | null {
  if (!at) return null;
  const iso = Date.parse(at);
  if (!Number.isNaN(iso)) return iso;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(at);
  if (m) {
    const base = new Date(2000, 0, 1);
    base.setHours(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0, 0);
    return base.getTime();
  }
  return null;
}

export type MergeFieldOutcome =
  | { type: 'unchanged' }
  | { type: 'applied'; field: string; value: unknown }
  | { type: 'conflict'; field: string; deviceValue: unknown; stationValue: unknown; baseValue: unknown };

/**
 * 单个字段的三向合并。
 * @param base    设备上次对齐站点时该字段的值（设备没见过则为 undefined）
 * @param device  设备新保存的值
 * @param station 站点现值
 */
export function mergeField(
  kind: RecordKind,
  field: string,
  base: unknown,
  device: unknown,
  station: unknown
): MergeFieldOutcome {
  // 站点复核/核验字段：设备永远无权写入，站点原值保留。
  if (isStationOwned(kind, field)) return { type: 'unchanged' };
  if (deepEqual(device, station)) return { type: 'unchanged' };
  if (deepEqual(station, base)) return { type: 'applied', field, value: device };
  if (deepEqual(device, base)) return { type: 'unchanged' };
  return { type: 'conflict', field, deviceValue: device, stationValue: station, baseValue: base };
}

/**
 * 观察地点变更后，失效其复核结论与所有关联样本的核验结论。
 * 站点意见（reviewComment / verifyComment）原样保留，只退回结论并记录原因。
 * 返回被改动的样本 id，供记账与同步。
 */
export function invalidateOnLocationChange(
  observationId: string,
  next: ObservationFields,
  reason: string,
  records: RecordEnvelope[]
): string[] {
  const invalidatedSamples: string[] = [];
  next.reviewState = 'pending';
  next.reviewVoidReason = reason;
  for (const rec of records) {
    if (rec.kind !== 'sample' || !rec.active) continue;
    const f = rec.fields as SampleFields;
    if (f.observationId !== observationId) continue;
    if (f.verifyState !== 'pending' || f.verifyVoidReason) {
      f.verifyState = 'pending';
      f.verifyVoidReason = reason;
      rec.rev += 1;
      rec.fieldRevs.verifyState = rec.rev;
      rec.fieldRevs.verifyVoidReason = rec.rev;
      invalidatedSamples.push(rec.id);
    }
  }
  return invalidatedSamples;
}

/**
 * 重复路段 / 重复观察归并判定。
 * - 轨迹点：距离阈值内且时间相近（无法解析时间则要求时间串一致）。
 * - 观察：距离阈值内视为同一观察的重复上报。
 */
export function isDuplicatePair(kind: RecordKind, a: RecordEnvelope, b: RecordEnvelope): boolean {
  if (kind === 'track') {
    const fa = a.fields as TrackFields;
    const fb = b.fields as TrackFields;
    if (distanceMeters(fa.latitude, fa.longitude, fb.latitude, fb.longitude) > TRACK_DUP_METERS) return false;
    const ta = parseTime(fa.at);
    const tb = parseTime(fb.at);
    if (ta !== null && tb !== null) return Math.abs(ta - tb) <= TRACK_DUP_WINDOW_MS;
    return fa.at === fb.at;
  }
  if (kind === 'observation') {
    const fa = a.fields as ObservationFields;
    const fb = b.fields as ObservationFields;
    return distanceMeters(fa.latitude, fa.longitude, fb.latitude, fb.longitude) <= OBS_DUP_METERS;
  }
  return false;
}

/**
 * 样本到达时，它挂的观察可能已被重复归并（mergedInto）。
 * 沿链跟到幸存观察并改挂；若经过的观察地点不同，核验结论立即失效（意见保留）。
 * 返回最终挂到的观察 id；无变化返回 null。
 */
export function resolveObservationLink(sample: RecordEnvelope, records: RecordEnvelope[]): { survivorId: string; voided: boolean } | null {
  if (sample.kind !== 'sample') return null;
  const f = sample.fields as SampleFields;
  let target = records.find((r) => r.kind === 'observation' && r.id === f.observationId);
  if (!target || target.active) return null;

  const from = target;
  const seen = new Set<string>();
  while (target && !target.active && target.mergedInto && !seen.has(target.id)) {
    seen.add(target.id);
    target = records.find((r) => r.kind === 'observation' && r.id === target!.mergedInto) ?? target;
  }
  const survivor = target;
  if (!survivor || survivor.id === f.observationId) return null;

  const fromFields = from.fields as ObservationFields;
  const toFields = survivor.fields as ObservationFields;
  const placeChanged = fromFields.latitude !== toFields.latitude || fromFields.longitude !== toFields.longitude;

  f.observationId = survivor.id;
  sample.rev += 1;
  sample.fieldRevs.observationId = sample.rev;

  let voided = false;
  if (placeChanged && (f.verifyState !== 'pending' || f.verifyVoidReason)) {
    f.verifyState = 'pending';
    f.verifyVoidReason = `样本挂接的观察已归并到 ${survivor.id}，地点不同，核验退回待处理`;
    sample.rev += 1;
    sample.fieldRevs.verifyState = sample.rev;
    sample.fieldRevs.verifyVoidReason = sample.rev;
    voided = true;
  }
  return { survivorId: survivor.id, voided };
}

/**
 * 执行归并：removed 上的样本改挂 survivor；若两条观察地点不一致，
 * 改挂样本的核验结论立即失效（意见保留）。
 * 返回被改动的样本 id。
 */
export function reattachOnDedup(survivor: RecordEnvelope, removed: RecordEnvelope, records: RecordEnvelope[]): string[] {
  const moved: string[] = [];
  const sf = survivor.kind === 'observation' ? (survivor.fields as ObservationFields) : undefined;
  const rf = removed.kind === 'observation' ? (removed.fields as ObservationFields) : undefined;
  const placeChanged = sf && rf && (sf.latitude !== rf.latitude || sf.longitude !== rf.longitude);
  for (const rec of records) {
    if (rec.kind !== 'sample' || !rec.active) continue;
    const f = rec.fields as SampleFields;
    if (f.observationId !== removed.id) continue;
    f.observationId = survivor.id;
    rec.rev += 1;
    rec.fieldRevs.observationId = rec.rev;
    moved.push(rec.id);
    if (placeChanged && (f.verifyState !== 'pending' || f.verifyVoidReason)) {
      f.verifyState = 'pending';
      f.verifyVoidReason = `样本因重复观察合并，改挂到观察 ${survivor.id}，地点已变`;
      rec.rev += 1;
      rec.fieldRevs.verifyState = rec.rev;
      rec.fieldRevs.verifyVoidReason = rec.rev;
    }
  }
  return moved;
}
