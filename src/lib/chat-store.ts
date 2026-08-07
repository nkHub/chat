// 会话状态的持久化存储层。
//
// 历史：早期用 localStorage（键 aether-ai-chat-state）保存全部会话。localStorage
// 有约 5MB 配额，且读写是同步的，聊天记录一多就会：写入超限抛 QuotaExceededError
// 被静默吞掉（刷新丢数据）、首屏同步 JSON.parse 大数据卡死页面。
//
// 现在迁移到 IndexedDB：
// - 容量大（可用磁盘空间），无 5MB 上限；
// - 读写全部异步，不阻塞主线程，大数据也不会卡 UI；
// - 写入失败可通过回调/异常感知，而不是静默丢失。
//
// 为兼容旧数据，首次读取时若 IndexedDB 无记录、localStorage 有旧数据，
// 会自动迁移进 IndexedDB 并删除旧键。

const DB_NAME = "aether-ai-chat";
const DB_VERSION = 1;
const STORE_NAME = "chat-state";
const STORE_KEY = "main";
// 旧 localStorage 键，用于一次性迁移。
const LEGACY_STORAGE_KEY = "aether-ai-chat-state";

// 读单条记录：命中返回值，未命中返回 undefined。
function getState(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(STORE_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

// 写单条记录（结构化克隆，对象/数组直接可存）。
function setState(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, STORE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  });
}

// 删除单条记录。
function deleteState(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(STORE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    request.onerror = () => reject(request.error);
  });
}

// 读取聊天状态：优先 IndexedDB，无记录时尝试从旧 localStorage 一次性迁移。
// 返回解析后的对象或 null（无数据 / 数据损坏）。
export async function loadChatState(): Promise<unknown> {
  // 有 IndexedDB 记录就直接用（迁移/首次已写过后走这里）。
  try {
    const value = await getState();
    if (value !== undefined) return value;
  } catch {
    // IndexedDB 不可用（如隐私模式受限）时忽略，继续走 localStorage 兜底。
  }
  // 尝试旧 localStorage 数据迁移。
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // 迁移成功则写入 IndexedDB 并清除旧键，下次直接走 IndexedDB。
    try {
      await setState(parsed);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // 写 IndexedDB 失败（隐私模式等）就保留 localStorage，下次再试。
    }
    return parsed;
  } catch {
    // localStorage 数据损坏（JSON 解析失败）时按无数据处理。
    return null;
  }
}

// 保存聊天状态到 IndexedDB；失败时抛出，由调用方决定降级策略。
export async function saveChatState(state: unknown): Promise<void> {
  await setState(state);
}

// 清空已保存的聊天状态（用于「清空所有会话」等场景）。
export async function clearChatState(): Promise<void> {
  try {
    await deleteState();
  } catch {
    // 忽略清除失败；随后写入空状态即可。
  }
  // 顺带清掉旧的 localStorage 键，避免迁移逻辑把旧数据捞回来。
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // 忽略。
  }
}
