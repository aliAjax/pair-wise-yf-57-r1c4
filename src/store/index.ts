// 巡护离线台账 store：
// - 三类记录统一带设备号、稳定编号、修订号；
// - 联网后逐条 POST（按稳定编号幂等，只入账一次），每条确认后立即落游标，
//   失败后从已完成部分续作；
// - POST 完成后拉取站点快照，按稳定编号逐字段合并（mergeLedger）。
import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import { getDeviceId, stableId } from '../sync/device';
import { businessFields, mergeLedger, OBS_FIELDS, POINT_FIELDS, SAMPLE_FIELDS, type MergeOutcome } from '../sync/ledger';
import { armWeakNetworkFailure, fetchAll, postOne, type PostResult } from '../sync/server';
import type { ConflictPair, PatrolObservation, RecordKind, Sample, SyncState, TrackPoint } from '../sync/types';

const STORAGE_KEY = 'yf57-patrol-ledger-v2';

export type { SyncState } from '../sync/types';
export type { PatrolObservation, TrackPoint, Sample, ConflictPair } from '../sync/types';

interface SyncingState {
  active: boolean;
  phase: 'posting' | 'merging';
  posted: number;
  failed: boolean;
}

interface State {
  deviceId: string;
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  conflicts: ConflictPair[];
  syncing: SyncingState | null;
  notice: string | null;
  lastSummary: { posted: number; duplicates: number; adopted: number; mergedFields: number; conflicts: number } | null;
}

const deviceId = getDeviceId();

function recBase(kind: RecordKind): Pick<PatrolObservation, 'id' | 'deviceId' | 'rev' | 'createdAt' | 'updatedAt' | 'sync'> {
  const now = Date.now();
  return {
    id: stableId(deviceId),
    deviceId,
    rev: 1,
    createdAt: new Date(now).toLocaleString(),
    updatedAt: now,
    sync: 'queued',
  };
}

const seed: State = {
  deviceId,
  observations: [
    {
      id: 'o1',
      deviceId,
      rev: 1,
      createdAt: '2026-09-29 07:20',
      updatedAt: Date.now(),
      sync: 'synced',
      lastAckedRev: 1,
      acked: { time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', latitude: 30.5821, longitude: 103.2174, reviewed: false, reviewNote: undefined },
      time: '2026-09-29 07:20',
      note: '东坡发现新鲜足迹，沿溪谷方向移动',
      risk: 'medium',
      latitude: 30.5821,
      longitude: 103.2174,
      reviewed: false,
    },
    {
      id: 'o2',
      deviceId,
      rev: 1,
      createdAt: '2026-09-29 08:05',
      updatedAt: Date.now(),
      sync: 'queued',
      time: '2026-09-29 08:05',
      note: '红外相机外壳松动，已拍照待补报',
      risk: 'high',
      reviewed: false,
    },
    {
      id: 'o3',
      deviceId,
      rev: 1,
      createdAt: '2026-09-29 08:40',
      updatedAt: Date.now(),
      sync: 'synced',
      lastAckedRev: 1,
      acked: { time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', reviewed: true, reviewNote: '样线南段已复核，同意记录' },
      time: '2026-09-29 08:40',
      note: '样线南段没有异常',
      risk: 'low',
      reviewed: true,
      reviewNote: '样线南段已复核，同意记录',
    },
  ],
  points: [
    {
      // 本地手动修正过坐标（rev 2），站点也改了同一坐标 → 两版冲突
      id: 'p1',
      deviceId,
      rev: 2,
      createdAt: '2026-09-29 07:20',
      updatedAt: Date.now(),
      sync: 'synced',
      lastAckedRev: 1,
      acked: { latitude: 30.58, longitude: 103.215, at: '07:20', source: 'gps' },
      latitude: 30.5821,
      longitude: 103.2174,
      at: '07:20',
      source: 'gps',
    },
    {
      id: 'p2',
      deviceId,
      rev: 1,
      createdAt: '2026-09-29 08:05',
      updatedAt: Date.now(),
      sync: 'synced',
      lastAckedRev: 1,
      acked: { latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' },
      latitude: 30.5856,
      longitude: 103.2211,
      at: '08:05',
      source: 'gps',
    },
  ],
  samples: [
    {
      id: 's1',
      deviceId,
      rev: 1,
      createdAt: '2026-09-29 07:25',
      updatedAt: Date.now(),
      sync: 'synced',
      lastAckedRev: 1,
      acked: { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'verified', observationId: 'o1' },
      code: 'WD-0929-01',
      species: '疑似豹猫毛发',
      count: 1,
      status: 'verified',
      observationId: 'o1',
    },
  ],
  conflicts: [],
  syncing: null,
  notice: null,
  lastSummary: null,
};

function readState(): State {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<State>;
      if (parsed.deviceId && Array.isArray(parsed.observations)) return { ...seed, ...parsed, syncing: null };
    }
  } catch {
    /* 落盘损坏时回到种子 */
  }
  return seed;
}

const slice = createSlice({
  name: 'patrol',
  initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<{ note: string; risk: PatrolObservation['risk'] }>) => {
      const base = recBase('observation');
      const latestPoint = state.points[state.points.length - 1];
      state.observations.unshift({
        ...base,
        time: new Date().toLocaleString(),
        note: action.payload.note,
        risk: action.payload.risk,
        reviewed: false,
        // 保存时带上记录到的位置（若有）
        latitude: latestPoint?.latitude,
        longitude: latestPoint?.longitude,
      });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      const base = recBase('point');
      state.points.push({ ...base, latitude: action.payload.latitude, longitude: action.payload.longitude, at: new Date().toLocaleTimeString(), source: 'gps' });
    },
    addSample: (state, action: PayloadAction<{ code: string; species: string; count: number; observationId?: string }>) => {
      const base = recBase('sample');
      state.samples.unshift({ ...base, code: action.payload.code, species: action.payload.species, count: action.payload.count, status: 'draft', observationId: action.payload.observationId });
    },
    /** 本地修改后修订号 +1，等待重新入账 */
    bumpRev: (state, action: PayloadAction<{ kind: RecordKind; id: string }>) => {
      const bucket = action.payload.kind === 'observation' ? state.observations : action.payload.kind === 'point' ? state.points : state.samples;
      const item = bucket.find((r) => r.id === action.payload.id);
      if (item) {
        item.rev += 1;
        item.updatedAt = Date.now();
        item.sync = 'queued';
      }
    },
    /** 单条 POST 成功：按稳定编号落游标（续作与幂等的依据） */
    markAcked: (state, action: PayloadAction<{ kind: RecordKind; id: string; rev: number }>) => {
      const bucket = action.payload.kind === 'observation' ? state.observations : action.payload.kind === 'point' ? state.points : state.samples;
      const item = bucket.find((r) => r.id === action.payload.id);
      if (item) {
        item.lastAckedRev = action.payload.rev;
        item.sync = 'synced';
        const fields = action.payload.kind === 'observation' ? OBS_FIELDS : action.payload.kind === 'point' ? POINT_FIELDS : SAMPLE_FIELDS;
        item.acked = businessFields(item as unknown as Record<string, unknown>, fields);
      }
    },
    setSyncing: (state, action: PayloadAction<SyncingState | null>) => {
      state.syncing = action.payload;
    },
    /** 合并完成：替换台账、登记冲突对、生成失效回退提示 */
    applyMerge: (state, action: PayloadAction<MergeOutcome>) => {
      const outcome = action.payload;
      state.observations = outcome.observations;
      state.points = outcome.points;
      state.samples = outcome.samples;
      const known = new Set(state.conflicts.map((c) => c.id));
      for (const pair of outcome.pairs) {
        if (!known.has(pair.id)) state.conflicts.push(pair);
      }
      const parts: string[] = [];
      if (outcome.adopted) parts.push(`采用站点新记录 ${outcome.adopted} 条`);
      if (outcome.mergedFields) parts.push(`逐字段合并 ${outcome.mergedFields} 处`);
      if (outcome.pairs.length) parts.push(`保留冲突两版 ${outcome.pairs.length} 对`);
      const cleared = outcome.invalidated.filter((i) => i.clearedReview).length;
      const samples = outcome.invalidated.reduce((n, i) => n + i.sampleIds.length, 0);
      if (cleared || samples) parts.push(`地点变更退回待处理 ${cleared} 项复核、${samples} 项样本核验`);
      state.notice = `同步完成：${parts.join('，')}。`;
      state.lastSummary = { posted: 0, duplicates: 0, adopted: outcome.adopted, mergedFields: outcome.mergedFields, conflicts: outcome.pairs.length };
    },
    /** 冲突处理：保留本地版或站点版（默认两版都留）；选定后保留版即为权威版本，标记已入账 */
    resolvePair: (state, action: PayloadAction<{ pairId: string; choice: 'local' | 'remote' }>) => {
      const pair = state.conflicts.find((c) => c.id === action.payload.pairId);
      if (!pair) return;
      const bucket = pair.kind === 'observation' ? state.observations : pair.kind === 'point' ? state.points : state.samples;
      const keepId = action.payload.choice === 'local' ? pair.localId : pair.remoteId;
      const removeId = action.payload.choice === 'local' ? pair.remoteId : pair.localId;
      const removeIdx = bucket.findIndex((r) => r.id === removeId);
      if (removeIdx >= 0) bucket.splice(removeIdx, 1);
      const keep = bucket.find((r) => r.id === keepId);
      if (keep) {
        keep.sync = 'synced';
        keep.lastAckedRev = keep.rev;
        const fields = pair.kind === 'observation' ? OBS_FIELDS : pair.kind === 'point' ? POINT_FIELDS : SAMPLE_FIELDS;
        keep.acked = businessFields(keep as unknown as Record<string, unknown>, fields);
      }
      state.conflicts = state.conflicts.filter((c) => c.id !== pair.id);
    },
    dismissNotice: (state) => {
      state.notice = null;
    },
    /** 同步收尾：写入本次入账汇总 */
    finishSync: (state, action: PayloadAction<{ posted: number; duplicates: number; adopted: number; mergedFields: number; conflicts: number }>) => {
      state.lastSummary = action.payload;
    },
    reviewObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (item && !item.reviewed) {
        item.reviewed = true;
        item.rev += 1;
        item.updatedAt = Date.now();
        item.sync = 'queued';
      }
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item && item.status !== 'verified') {
        item.status = 'verified';
        item.rev += 1;
        item.updatedAt = Date.now();
        item.sync = 'queued';
      }
    },
  },
});

/** 需要入账的记录：非冲突状态下，未入账或本地修订号已超过站点确认的修订号；冲突记录走两版裁决，不再重传 */
export function needsPost(rec: { sync: SyncState; rev: number; lastAckedRev?: number }): boolean {
  return rec.sync !== 'conflict' && (rec.sync !== 'synced' || rec.rev > (rec.lastAckedRev ?? 0));
}

const COLLECTIONS: { kind: RecordKind; key: 'observations' | 'points' | 'samples' }[] = [
  { kind: 'observation', key: 'observations' },
  { kind: 'point', key: 'points' },
  { kind: 'sample', key: 'samples' },
];

/**
 * 同步续作台账：
 * 1. 逐条 POST（幂等），每条确认后立即落游标；中断则返回失败位置，下次从断点续作；
 * 2. 拉取站点快照逐字段合并；
 * 3. 合并产生的待入账变更（如核验退回）再补一次 POST。
 */
export const runSync = createAsyncThunk<
  { posted: number; duplicates: number; failed: boolean; adopted: number; mergedFields: number; conflicts: number },
  void,
  { state: RootState }
>('patrol/runSync', async (_void, { dispatch, getState }) => {
  const postPass = async (): Promise<{ posted: number; duplicates: number; failed: boolean }> => {
    let posted = 0;
    let duplicates = 0;
    let failed = false;
    for (const { kind, key } of COLLECTIONS) {
      for (const rec of getState().patrol[key]) {
        if (!needsPost(rec)) continue;
        dispatch(setSyncing({ active: true, phase: 'posting', posted, failed: false }));
        try {
          const result: PostResult = await postOne(rec);
          // duplicate（站点已有同版本）不用本地快照落游标：同版本内容可能不同，
          // 交给随后的逐字段合并/两版冲突裁决，避免静默覆盖
          if (result.status !== 'duplicate') dispatch(markAcked({ kind, id: rec.id, rev: rec.rev }));
          posted += 1;
          if (result.status === 'duplicate') duplicates += 1;
        } catch {
          // 弱网中断：已入账部分已落游标，下次从这里续作
          failed = true;
          return { posted, duplicates, failed };
        }
      }
    }
    return { posted, duplicates, failed };
  };

  dispatch(setSyncing({ active: true, phase: 'posting', posted: 0, failed: false }));
  const first = await postPass();

  let adopted = 0;
  let mergedFields = 0;
  let conflicts = 0;

  if (!first.failed) {
    dispatch(setSyncing({ active: true, phase: 'merging', posted: first.posted, failed: false }));
    const remote = await fetchAll();
    const outcome = mergeLedger(getState().patrol, remote);
    dispatch(applyMerge(outcome));
    adopted = outcome.adopted;
    mergedFields = outcome.mergedFields;
    conflicts = outcome.pairs.length;
    // 合并后可能产生新的待入账项（如样本核验因地点变更退回待处理）
    const second = await postPass();
    first.posted += second.posted;
    first.duplicates += second.duplicates;
    if (second.failed) first.failed = true;
  }

  dispatch(setSyncing(first.failed ? { active: false, phase: 'posting', posted: first.posted, failed: true } : null));
  if (!first.failed) {
    dispatch(finishSync({ posted: first.posted, duplicates: first.duplicates, adopted, mergedFields, conflicts }));
  }
  return { posted: first.posted, duplicates: first.duplicates, failed: first.failed, adopted, mergedFields, conflicts };
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }),
  }),
});
export const { useConnectionQuery } = patrolApi;

export const {
  addObservation,
  addPoint,
  addSample,
  bumpRev,
  markAcked,
  setSyncing,
  applyMerge,
  resolvePair,
  dismissNotice,
  finishSync,
  reviewObservation,
  verifySample,
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware),
});

if (typeof window !== 'undefined') {
  store.subscribe(() => {
    const state = store.getState().patrol;
    // 同步中间态也持久化：中断后续作不丢游标
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify({ ...state, syncing: state.syncing?.active ? state.syncing : null }));
  });
}

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 供 UI 触发"弱网中断"演示：下一次 POST 会失败 */
export { armWeakNetworkFailure };
