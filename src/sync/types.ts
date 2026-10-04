// 野外巡护离线台账：三类业务对象的稳定类型定义
// 所有记录保存时即带设备号与修订号，联网后按稳定编号逐字段合并。

export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type Risk = 'low' | 'medium' | 'high';
export type SampleStatus = 'draft' | 'submitted' | 'verified';
export type RecordKind = 'observation' | 'point' | 'sample';

/** 台账记录的公共底座：稳定编号、设备号、修订号、入账游标 */
export interface LedgerRecord {
  /** 稳定编号：设备号 + UUID，重传不变，站点据此去重 */
  id: string;
  /** 写入设备，保存时生成并随记录一起上报 */
  deviceId: string;
  /** 修订号：每次本地修改 +1，站点据此判断新旧 */
  rev: number;
  createdAt: string;
  updatedAt: number;
  /** 同步状态：local 仅本机 / queued 待入账 / synced 已入账 / conflict 两版冲突 */
  sync: SyncState;
  /** 站点已确认入账的修订号（幂等与续作游标） */
  lastAckedRev?: number;
  /** 上次入账时的业务字段快照，用于逐字段比对两边改动 */
  acked?: Record<string, unknown>;
}

/** 观察记录 */
export interface PatrolObservation extends LedgerRecord {
  time: string;
  note: string;
  risk: Risk;
  /** 观察地点（合并后若相对入账基线变化，复核立即失效） */
  latitude?: number;
  longitude?: number;
  /** 复核结论：地点一变即退回 false */
  reviewed: boolean;
  /** 站里写的复核意见，合并时保留 */
  reviewNote?: string;
}

/** 轨迹点 */
export interface TrackPoint extends LedgerRecord {
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
}

/** 样本：挂在某条观察下，合并时可被站点改挂到别的观察 */
export interface Sample extends LedgerRecord {
  code: string;
  species: string;
  count: number;
  status: SampleStatus;
  /** 所挂观察的稳定编号（合并重复路段时可能改挂） */
  observationId?: string;
}

/** 两版冲突对：观察或轨迹点两边都改过 → 保留两版，不静默覆盖 */
export interface ConflictPair {
  id: string;
  kind: RecordKind;
  localId: string;
  remoteId: string;
  reason: string;
}

export interface RemoteSnapshot {
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
}
