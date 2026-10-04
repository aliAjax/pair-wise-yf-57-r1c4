// 站点（云端台账）模拟服务：
// - 重传只入账一次：按稳定编号去重，站点版本不低于上报版本时直接 ack；
// - 支持弱网中断注入，中断后客户端从已完成部分续作。
import type { PatrolObservation, RemoteSnapshot, Sample, TrackPoint } from './types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const STATION_DEVICE = 'dev-station';

// 站点侧种子台账：与本地基线对应，且包含站点的修改
const db: RemoteSnapshot = {
  observations: [
    {
      id: 'o1',
      deviceId: STATION_DEVICE,
      rev: 1,
      time: '2026-09-29 07:20',
      note: '东坡发现新鲜足迹，沿溪谷方向移动',
      risk: 'medium',
      // 站点修正了观察地点 → 触发本地复核/核验失效回退
      latitude: 30.583,
      longitude: 103.2205,
      reviewed: false,
      // 站里的复核意见，合并时必须保留
      reviewNote: '东坡足迹已核实，注意沿溪沟方向排查',
      sync: 'synced',
      createdAt: '2026-09-29 07:20',
      updatedAt: Date.now(),
    },
    {
      id: 'o3',
      deviceId: STATION_DEVICE,
      rev: 1,
      time: '2026-09-29 08:40',
      note: '样线南段没有异常',
      risk: 'low',
      reviewed: true,
      reviewNote: '样线南段已复核，同意记录',
      sync: 'synced',
      createdAt: '2026-09-29 08:40',
      updatedAt: Date.now(),
    },
    {
      // 站点新写的观察，本地没有 → 合并时采用
      id: 'o4',
      deviceId: STATION_DEVICE,
      rev: 1,
      time: '2026-09-29 09:10',
      note: '北坡废弃营地发现人为丢弃物',
      risk: 'high',
      latitude: 30.59,
      longitude: 103.23,
      reviewed: true,
      reviewNote: '已联系护林员清理，待跟进',
      sync: 'synced',
      createdAt: '2026-09-29 09:10',
      updatedAt: Date.now(),
    },
  ],
  points: [
    {
      // 与本地 p1 两边都改过 → 两版冲突
      id: 'p1',
      deviceId: STATION_DEVICE,
      rev: 2,
      latitude: 30.584,
      longitude: 103.2199,
      at: '07:20',
      source: 'gps',
      sync: 'synced',
      createdAt: '2026-09-29 07:20',
      updatedAt: Date.now(),
    },
    { id: 'p2', deviceId: STATION_DEVICE, rev: 1, latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps', sync: 'synced', createdAt: '2026-09-29 08:05', updatedAt: Date.now() },
  ],
  samples: [
    {
      id: 's1',
      deviceId: STATION_DEVICE,
      rev: 1,
      code: 'WD-0929-01',
      species: '豹猫毛发样本',
      count: 1,
      status: 'verified',
      // 站点合并重复路段后把样本改挂到了 o4
      observationId: 'o4',
      sync: 'synced',
      createdAt: '2026-09-29 07:25',
      updatedAt: Date.now(),
    },
    {
      // 站点新样本
      id: 's2',
      deviceId: STATION_DEVICE,
      rev: 1,
      code: 'WD-0928-03',
      species: '雉鸡羽毛',
      count: 2,
      status: 'submitted',
      observationId: 'o3',
      sync: 'synced',
      createdAt: '2026-09-28 18:00',
      updatedAt: Date.now(),
    },
  ],
};

let armedFailure = false;

/** 模拟弱网：下一次 POST 中断（之后自动解除） */
export function armWeakNetworkFailure(): void {
  armedFailure = true;
}

export interface PostResult {
  status: 'inserted' | 'updated' | 'duplicate';
  rev: number;
  id: string;
}

/** POST 一条记录：按稳定编号幂等入账，重传不重复写 */
export async function postOne(rec: PatrolObservation | TrackPoint | Sample): Promise<PostResult> {
  await delay(120);
  if (armedFailure) {
    armedFailure = false;
    throw new Error('弱网中断：POST 未到达站点');
  }
  const existing = [...db.observations, ...db.points, ...db.samples].find((r) => r.id === rec.id);
  if (!existing) {
    const bucket = 'risk' in rec ? db.observations : 'source' in rec ? db.points : db.samples;
    (bucket as typeof db.observations).push(clone(rec) as PatrolObservation);
    return { status: 'inserted', rev: rec.rev, id: rec.id };
  }
  if (existing.rev >= rec.rev) {
    // 重传且站点版本不旧：只入账一次，直接确认
    return { status: 'duplicate', rev: existing.rev, id: rec.id };
  }
  Object.assign(existing, clone(rec));
  return { status: 'updated', rev: rec.rev, id: rec.id };
}

export async function fetchAll(): Promise<RemoteSnapshot> {
  await delay(80);
  return clone(db);
}
