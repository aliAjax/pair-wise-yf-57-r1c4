// 设备身份与稳定编号：首次启动生成设备号并持久化，
// 同一台设备离线写出的记录编号始终稳定，重传只入账一次。
import Taro from '@tarojs/taro';

const DEVICE_KEY = 'yf57-device-id';

function randomPart(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getDeviceId(): string {
  let id = '';
  try {
    id = Taro.getStorageSync(DEVICE_KEY) || '';
  } catch {
    id = '';
  }
  if (!id) {
    id = `dev-${randomPart()}`;
    try {
      Taro.setStorageSync(DEVICE_KEY, id);
    } catch {
      /* 存储不可用时仅内存态 */
    }
  }
  return id;
}

/** 稳定编号：设备号前缀 + 随机段，离线生成后永不变 */
export function stableId(deviceId: string): string {
  return `${deviceId}-${randomPart()}`;
}
