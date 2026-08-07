/**
 * 聊天记录导入脚本（手动执行）
 *
 * 用途：
 *   把旧 localStorage 导出的 chat.json（可能带多层 JS 字符串转义）
 *   导入到新版 chat 使用的 IndexedDB 存储中。
 *
 * 用法：
 *   1. 打开 /chat 页面（任意 origin 一致的页面即可）。
 *   2. 打开浏览器 DevTools → Console。
 *   3. 把本文件整体粘贴进 Console 后回车执行。
 *   4. 在弹出文件选择框里选中 chat.json。
 *   5. 提示「导入成功」后刷新页面即可看到历史会话。
 *
 * 原理：
 *   旧数据是 DevTools Console 复制出来的 JS 字符串字面量，转义层数不均匀，
 *   手写反转义不可靠。这里直接用 eval 按 JS 字面量规则求值（浏览器原生支持
 *   全部转义），再递归剥到包含 sessions 的对象，最后写入 IndexedDB。
 *
 * 注意：
 *   本脚本是手工运维工具，仅用于一次性导入，请勿作为正式代码引用。
 */
(function () {
  // 新版 chat 的 IndexedDB 存储参数（与 src/lib/chat-store.ts 保持一致）
  const DB_NAME = "aether-ai-chat";
  const DB_VERSION = 1;
  const STORE_NAME = "chat-state";
  const STORE_KEY = "main";

  // 打开 / 创建 IndexedDB
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 把还原后的完整聊天状态写入 IndexedDB
  async function writeState(state) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(state, STORE_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }

  // 递归剥字符串：内容本身是 JS 字面量 / JSON 字符串时逐层还原，直到拿到对象
  function normalize(v, depth) {
    depth = depth || 0;
    while (typeof v === "string" && depth < 8) {
      let parsed = null;
      try {
        parsed = JSON.parse(v);
      } catch (e) {
        // ignore
      }
      if (parsed === null) {
        try {
          parsed = eval("(" + v + ")");
        } catch (e) {
          // ignore
        }
      }
      if (parsed === null) break;
      v = parsed;
      depth++;
    }
    return v;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) {
      alert("未选择文件");
      return;
    }
    const text = await file.text();

    let state;
    try {
      state = eval("(" + text + ")"); // 先按 JS 字面量求值（处理 DevTools 复制出来的转义）
    } catch (e) {
      try {
        state = JSON.parse(text);
      } catch (e2) {
        // ignore
      }
    }
    if (typeof state === "string") state = normalize(state);
    if (!state || typeof state !== "object" || !state.sessions) {
      alert("解析失败：未能还原出含 sessions 的对象，请确认选的是 chat.json");
      console.log("解析结果:", state);
      return;
    }
    try {
      await writeState(state);
      const n = (state.sessions || []).length;
      alert("导入成功！共 " + n + " 个会话。刷新页面即可查看。");
      console.log("导入成功:", n, "个会话");
    } catch (err) {
      alert("写入 IndexedDB 失败: " + err);
      console.error(err);
    }
  });
  input.click();
})();
