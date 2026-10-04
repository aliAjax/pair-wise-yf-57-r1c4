// 合并引擎：把本地台账与站点快照按稳定编号逐字段合并。
// 规则：
// 1. 站里的复核意见（reviewNote）始终保留；
// 2. 只有一边改过的字段取该边，本地新写的字段本地优先；
// 3. 观察或轨迹点两边都改过 → 保留两版（本地版 + 站点版），不静默覆盖；
// 4. 样本不设两版，逐字段合并；
// 5. 观察地点相对入账基线一变，复核结论撤销、样本核验退回待处理。
import type { ConflictPair, PatrolObservation, RecordKind, RemoteSnapshot, Sample, SyncState, TrackPoint } from './types';

export const OBS_FIELDS = ['time', 'note', 'risk', 'latitude', 'longitude', 'reviewed', 'reviewNote'] as const;
export const POINT_FIELDS = ['latitude', 'longitude', 'at', 'source'] as const;
export const SAMPLE_FIELDS = ['code', 'species', 'count', 'status', 'observationId'] as const;

/** 站点专属字段：合并时只采信站点值（站里的复核意见保留） */
const STATION_OWNED_FIELDS = ['reviewNote'];

export function businessFields<T extends Record<string, unknown>>(rec: T, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = rec[f];
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** 相对基线发生变化的字段；无基线（从未入账）时全部视为已改 */
function changedFields(current: Record<string, unknown>, base: Record<string, unknown> | null, fields: readonly string[]): string[] {
  if (!base) return fields.slice() as string[];
  const changed: string[] = [];
  for (const f of fields) {
    if (!sameValue(current[f], base[f])) changed.push(f);
  }
  return changed;
}

interface KindMergeResult<T> {
  records: T[];
  pairs: ConflictPair[];
  adopted: number;
  mergedFields: number;
}

function mergeKind<T extends { id: string; rev: number; sync: SyncState; lastAckedRev?: number; acked?: Record<string, unknown> }>(
  local: T[],
  remote: T[],
  kind: RecordKind,
  fields: readonly string[]
): KindMergeResult<T> {
  const remoteById = new Map<string, T>(remote.map((r) => [r.id, r]));
  const records: T[] = [];
  const pairs: ConflictPair[] = [];
  let adopted = 0;
  let mergedFields = 0;

  for (const loc of local) {
    const rem = remoteById.get(loc.id);
    if (!rem) {
      // 站点没有：本地新写的优先，保留原样等待入账
      records.push(loc);
      continue;
    }
    const base = loc.acked ?? null;
    const localChanged = changedFields(businessFields(loc as unknown as Record<string, unknown>, fields), base, fields);
    const remoteChanged = changedFields(businessFields(rem as unknown as Record<string, unknown>, fields), base, fields);

    if (kind !== 'sample' && localChanged.length > 0 && remoteChanged.length > 0) {
      // 观察/轨迹点两边都改过：保留两版，不静默覆盖
      const localCopy: T = { ...loc, sync: 'conflict' };
      const remoteCopy: T = { ...rem, id: `${loc.id}__remote`, sync: 'conflict', lastAckedRev: undefined, acked: undefined };
      records.push(localCopy, remoteCopy);
      pairs.push({
        id: `cf-${loc.id}`,
        kind,
        localId: loc.id,
        remoteId: remoteCopy.id,
        reason: '两边都修改了同一记录，已保留本地与站点两版',
      });
      continue;
    }

    // 逐字段合并
    const merged: T = { ...loc };
    for (const f of fields) {
      const localVal = (loc as unknown as Record<string, unknown>)[f];
      const remoteVal = (rem as unknown as Record<string, unknown>)[f];
      const isStationOwned = STATION_OWNED_FIELDS.includes(f);
      const lc = localChanged.includes(f);
      const rc = remoteChanged.includes(f);
      let next = localVal;
      if (isStationOwned) {
        // 站里的复核意见保留：站点有值即采信
        if (remoteVal !== undefined && !sameValue(remoteVal, localVal)) {
          next = remoteVal;
          mergedFields += 1;
        }
      } else if (rc && !lc) {
        next = remoteVal; // 只有站点改：取站点
        if (!sameValue(remoteVal, localVal)) mergedFields += 1;
      } else if (lc && !rc) {
        next = localVal; // 只有本地改：本地新写优先
      } else if (lc && rc) {
        next = localVal; // 两边都改同一字段：本地新写优先（样本走此路径）
      }
      (merged as unknown as Record<string, unknown>)[f] = next;
    }
    merged.sync = 'synced';
    merged.rev = Math.max(loc.rev, rem.rev);
    merged.lastAckedRev = merged.rev;
    merged.acked = businessFields(merged as unknown as Record<string, unknown>, fields);
    records.push(merged);
  }

  // 站点有、本地无：采用为已入账
  for (const rem of remote) {
    if (local.some((l) => l.id === rem.id)) continue;
    records.push({ ...rem, sync: 'synced', lastAckedRev: rem.rev, acked: businessFields(rem as unknown as Record<string, unknown>, fields) });
    adopted += 1;
  }

  return { records, pairs, adopted, mergedFields };
}

export interface InvalidatedItem {
  observationId: string;
  clearedReview: boolean;
  sampleIds: string[];
}

export interface MergeOutcome {
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  pairs: ConflictPair[];
  adopted: number;
  mergedFields: number;
  invalidated: InvalidatedItem[];
}

/** 地点变更失效回退：观察地点相对入账基线一变，复核结论撤销、样本核验退回待处理 */
function applyLocationInvalidation(
  observations: PatrolObservation[],
  samples: Sample[],
  localObservations: PatrolObservation[],
  localSamples: Sample[]
): { observations: PatrolObservation[]; samples: Sample[]; invalidated: InvalidatedItem[] } {
  const baseLocation = new Map<string, { latitude?: number; longitude?: number }>();
  for (const o of localObservations) {
    const a = o.acked as { latitude?: number; longitude?: number } | undefined;
    if (a) baseLocation.set(o.id, { latitude: a.latitude, longitude: a.longitude });
  }
  // 样本合并前的挂接关系：站点可能在合并路段时把样本改挂到别的观察，
  // 但失效判定要看变更发生时样本实际挂在哪条观察上
  const originalObservation = new Map<string, string | undefined>();
  for (const s of localSamples) {
    const a = s.acked as { observationId?: string } | undefined;
    originalObservation.set(s.id, a?.observationId ?? s.observationId);
  }

  const invalidated: InvalidatedItem[] = [];
  const nextObservations = observations.map((o) => {
    const base = baseLocation.get(o.id) ?? baseLocation.get(o.id.replace(/__remote$/, ''));
    if (!base) return o;
    const moved = !sameValue(base.latitude, o.latitude) || !sameValue(base.longitude, o.longitude);
    if (!moved) return o;
    const clearedReview = o.reviewed === true;
    invalidated.push({ observationId: o.id, clearedReview, sampleIds: [] });
    if (!clearedReview) return { ...o, reviewed: false };
    // 复核结论撤销属本地修订：修订号 +1，待重新入账
    return { ...o, reviewed: false, rev: o.rev + 1, updatedAt: Date.now(), sync: 'queued' as SyncState };
  });

  const nextSamples = samples.map((s) => {
    if (s.status !== 'verified') return s;
    const linkedId = originalObservation.get(s.id) ?? s.observationId;
    if (!linkedId) return s;
    const hit = invalidated.find((i) => i.observationId === linkedId || i.observationId === `${linkedId}__remote`);
    if (!hit) return s;
    hit.sampleIds.push(s.id);
    // 样本核验立即失效，退回待处理；修订号 +1 并标记待重新入账
    return { ...s, status: 'submitted' as const, rev: s.rev + 1, updatedAt: Date.now(), sync: 'queued' as SyncState };
  });

  return { observations: nextObservations, samples: nextSamples, invalidated };
}

export function mergeLedger(local: { observations: PatrolObservation[]; points: TrackPoint[]; samples: Sample[] }, remote: RemoteSnapshot): MergeOutcome {
  const obs = mergeKind<PatrolObservation>(local.observations, remote.observations, 'observation', OBS_FIELDS);
  const pts = mergeKind<TrackPoint>(local.points, remote.points, 'point', POINT_FIELDS);
  const smp = mergeKind<Sample>(local.samples, remote.samples, 'sample', SAMPLE_FIELDS);

  const after = applyLocationInvalidation(obs.records, smp.records, local.observations, local.samples);

  return {
    observations: after.observations,
    points: pts.records,
    samples: after.samples,
    pairs: [...obs.pairs, ...pts.pairs, ...smp.pairs],
    adopted: obs.adopted + pts.adopted + smp.adopted,
    mergedFields: obs.mergedFields + pts.mergedFields + smp.mergedFields,
    invalidated: after.invalidated,
  };
}
