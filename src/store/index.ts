import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';
import {
  ConflictEntry,
  DeviceLedger,
  LedgerEntry,
  LedgerPair,
  RecordEnvelope,
  StationLedger,
  SyncResult,
  type KVStore
} from '../sync';

/** Taro 存储适配到合并账的 KV 接口。 */
const taroStore: KVStore = {
  get: <T,>(key: string): T | null => {
    try { const v = Taro.getStorageSync(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
  },
  set: (key, value) => { try { Taro.setStorageSync(key, JSON.stringify(value)); } catch { /* 存储满时忽略，内存账仍可继续 */ } }
};

const DEVICE_KEY = 'yf57-device-id';
function getDeviceId(): string {
  let id = '';
  try { id = Taro.getStorageSync(DEVICE_KEY) || ''; } catch { id = ''; }
  if (!id) {
    id = `dev-${Math.random().toString(36).slice(2, 8)}`;
    try { Taro.setStorageSync(DEVICE_KEY, id); } catch { /* ignore */ }
  }
  return id;
}

/**
 * 内存里的一对账：左侧设备（本巡护员）、右侧站点（回站后的站账）。
 * 设备账与站账各自持久化到 Taro 存储；同一进程内模拟"断网记录—回站合并"。
 */
let pair: LedgerPair;
function getPair(): LedgerPair {
  if (!pair) pair = new LedgerPair(getDeviceId(), taroStore);
  return pair;
}
export function deviceLedger(): DeviceLedger { return getPair().device; }
export function stationLedger(): StationLedger { return getPair().station; }
function persistStation() { getPair().persistStation(taroStore); }

export interface LastSyncSummary {
  at: string;
  applied: number;
  duplicates: number;
  conflicts: number;
  invalidations: number;
  dedup: number;
  failedAtSeq?: number;
}

export interface PatrolUiState {
  deviceId: string;
  ackedSeq: number;
  outboxCount: number;
  stationRevision: number;
  records: RecordEnvelope[];
  conflicts: ConflictEntry[];
  deviceLog: LedgerEntry[];
  lastSync: LastSyncSummary | null;
}

function snapshot(device: DeviceLedger, station: StationLedger, lastSync: LastSyncSummary | null): PatrolUiState {
  return {
    deviceId: device.deviceId,
    ackedSeq: device.ackedSeq,
    outboxCount: device.outbox.length,
    stationRevision: station.revision,
    records: JSON.parse(JSON.stringify(device.records)) as RecordEnvelope[],
    conflicts: JSON.parse(JSON.stringify(station.conflicts)) as ConflictEntry[],
    deviceLog: JSON.parse(JSON.stringify(device.log.slice(-30))) as LedgerEntry[],
    lastSync
  };
}

const initial = (): PatrolUiState => snapshot(deviceLedger(), stationLedger(), null);

export interface SaveObservationPayload {
  note?: string;
  risk?: 'low' | 'medium' | 'high';
  latitude?: number;
  longitude?: number;
  observedAt?: string;
  id?: string;
}
export interface SaveSamplePayload {
  code?: string;
  species?: string;
  count?: number;
  observationId?: string;
  id?: string;
}
export interface StationReviewPayload { id: string; state: 'approved' | 'rejected'; comment: string; }
export interface StationVerifyPayload { id: string; state: 'verified' | 'rejected'; comment: string; }
export interface StationEditPayload { id: string; patch: Record<string, unknown>; }
export interface ResolveConflictPayload { pairId: string; resolution: 'local' | 'station'; }
export interface FieldEntryPayload {
  note: string;
  risk: 'low' | 'medium' | 'high';
  latitude: number;
  longitude: number;
  sample?: { species: string; count: number };
}

const slice = createSlice({
  name: 'patrol',
  initialState: initial() as PatrolUiState,
  reducers: {
    /** 现场录入：观察与挂在它上面的样本在同一事务里落账，共享稳定编号挂接。 */
    recordFieldEntry: (state, action: PayloadAction<FieldEntryPayload>) => {
      const { note, risk, latitude, longitude, sample } = action.payload;
      const obsRec = deviceLedger().saveObservation({
        note, risk, latitude, longitude, observedAt: new Date().toLocaleString()
      });
      if (sample && sample.species.trim()) {
        deviceLedger().saveSample({
          code: `WD-${Date.now().toString().slice(-5)}`,
          species: sample.species.trim(),
          count: sample.count,
          observationId: obsRec.id
        });
      }
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    saveObservation: (state, action: PayloadAction<SaveObservationPayload>) => {
      const { id, observedAt, ...rest } = action.payload;
      if (!id && (rest.note === undefined || rest.latitude === undefined || rest.longitude === undefined)) {
        return state; // 新建缺字段时忽略，保持账不变
      }
      const patch = { ...rest, ...(observedAt !== undefined ? { observedAt } : {}), ...(!id ? { observedAt: observedAt ?? new Date().toLocaleString() } : {}) };
      deviceLedger().saveObservation(patch, id);
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    saveTrack: (state, action: PayloadAction<{ latitude: number; longitude: number; source?: 'gps' | 'manual'; at?: string }>) => {
      const p = action.payload;
      deviceLedger().saveTrack({ at: p.at ?? new Date().toLocaleTimeString(), source: p.source ?? 'gps', latitude: p.latitude, longitude: p.longitude });
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    saveSample: (state, action: PayloadAction<SaveSamplePayload>) => {
      const { id, observationId, ...rest } = action.payload;
      const patch = { ...rest, ...(observationId !== undefined ? { observationId } : {}) };
      deviceLedger().saveSample(patch, id);
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    /** 同步；failAtSeq 用于演示"传一半断网，已完成部分保留，续传接其后"。传 -1 表示在待发序列中点断。 */
    sync: (_state, action: PayloadAction<{ failAtSeq?: number } | undefined>) => {
      const opts = action.payload ?? {};
      if (opts.failAtSeq === -1) {
        const pending = deviceLedger().outbox;
        if (pending.length > 1) {
          const midIndex = Math.floor(pending.length / 2) - 1; // 至少让第 1 条完成
          opts.failAtSeq = pending.slice().sort((a, b) => a.seq - b.seq)[Math.max(0, midIndex)].seq;
        } else if (pending.length === 1) {
          opts.failAtSeq = pending[0].seq; // 单条时模拟首包即断（整条未应用）
        }
      }
      const res: SyncResult = deviceLedger().sync(stationLedger(), opts);
      persistStation();
      const summary: LastSyncSummary = {
        at: new Date().toISOString(),
        applied: res.appliedCount,
        duplicates: res.duplicateCount,
        conflicts: res.conflicts.length,
        invalidations: res.invalidations.length,
        dedup: res.dedupMerges.length,
        failedAtSeq: res.failedAtSeq
      };
      return snapshot(deviceLedger(), stationLedger(), summary);
    },
    /** 站里复核：结论 + 意见都留存，设备永不能覆盖。 */
    stationReview: (state, action: PayloadAction<StationReviewPayload>) => {
      stationLedger().reviewObservation(action.payload.id, action.payload.state, action.payload.comment);
      persistStation();
      deviceLedger().sync(stationLedger()); // 纯拉取：把复核意见带回设备
      persistStation();
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    stationVerify: (state, action: PayloadAction<StationVerifyPayload>) => {
      stationLedger().verifySample(action.payload.id, action.payload.state, action.payload.comment);
      persistStation();
      deviceLedger().sync(stationLedger());
      persistStation();
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    /** 站端纠错某条观察的业务字段，用于制造"两边都改"的冲突分叉。 */
    stationEdit: (state, action: PayloadAction<StationEditPayload>) => {
      stationLedger().amendFields(action.payload.id, action.payload.patch);
      persistStation();
      deviceLedger().sync(stationLedger());
      persistStation();
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    },
    resolveConflict: (state, action: PayloadAction<ResolveConflictPayload>) => {
      stationLedger().resolveConflict(action.payload.pairId, action.payload.resolution);
      persistStation();
      deviceLedger().sync(stationLedger());
      persistStation();
      return snapshot(deviceLedger(), stationLedger(), state.lastSync);
    }
  }
});

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) })
});
export const { useConnectionQuery } = patrolApi;
export const {
  recordFieldEntry,
  saveObservation,
  saveTrack,
  saveSample,
  sync,
  stationReview,
  stationVerify,
  stationEdit,
  resolveConflict
} = slice.actions;

export const store = configureStore({
  reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
