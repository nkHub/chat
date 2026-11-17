// 生成 src/styles/fonts.css：把 Google Fonts 的 Inter / DM Mono 拉成本地自托管字体。
// 只在「换字体 / 升级字体版本」时手动执行：npm run fonts:sync
//
// 关键决策（改之前先读）：
// 1. 只取 latin / latin-ext 两个子集。本项目界面文案是中文，中文由 theme.css 的
//    回退链交给系统字体渲染；cyrillic / greek / vietnamese 在本项目里永远命中不到，
//    下载只会白占体积。
// 2. Inter 上游是**可变字体**：wght 100–900 一个文件，300/400/500/600 拿到的是同一份
//    字节。所以只存一份 inter-latin.woff2，用 `font-weight: 300 600` 区间声明；
//    若按字重复制 4 份，产物体积凭空翻四倍而字形完全一致。
// 3. DM Mono 上游是**静态字体**：400 与 500 是两份不同文件，必须逐个字重声明。
//
// 「是否可变」不写死，而是由「同族多个字重是否指向同一个 URL」推断：
//   - 共用一个 URL  → 必然是可变形，一个文件 + 字重区间
//   - 各自独立 URL  → 静态字体，逐字重声明
// 这样上游哪天换成静态分片，脚本也自动跟着变，不会悄悄生成错的 @font-face。
import { mkdir, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT_DIR = path.join(ROOT, "src/assets/fonts");
const CSS_OUT = path.join(ROOT, "src/styles/fonts.css");

// 不带 UA 时 Google 会返回 TTF 的旧式 CSS；带现代 UA 才拿到 woff2
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap";

// 界面里实际用到的子集；改这里是唯一需要人工维护的地方
const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);

const css = await (await fetch(CSS_URL, { headers: { "User-Agent": UA } })).text();

// 上游 CSS 形如「/* latin */ @font-face {...}」重复 N 段，按注释定位子集再逐段取字段
const parsed = [];
const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
let match;
while ((match = re.exec(css))) {
  const subset = match[1];
  if (!KEEP_SUBSETS.has(subset)) continue;
  const body = match[2];
  const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
  const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1]);
  const url = /url\((https:[^)]+)\)/.exec(body)?.[1];
  const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
  // 字段缺失就直接失败：宁可同步失败，也不要生成一个静默少字重的样式表
  if (!family || !weight || !url || !range) {
    throw new Error(`上游 CSS 解析失败: ${match[0].slice(0, 120)}`);
  }
  parsed.push({ subset, family, weight, url, range });
}
if (parsed.length === 0) throw new Error("上游 CSS 里没有解析到任何 latin/latin-ext 段");

// 同一 URL 可能被多个字重引用（可变字体），先按 URL 归并再下载
const byUrl = new Map();
for (const item of parsed) {
  const existing = byUrl.get(item.url);
  if (existing) existing.weights.add(item.weight);
  else byUrl.set(item.url, { ...item, weights: new Set([item.weight]) });
}

await mkdir(FONT_DIR, { recursive: true });

const slug = (family) => family.toLowerCase().replace(/\s+/g, "-");
const faces = [];

for (const entry of byUrl.values()) {
  const weights = [...entry.weights].sort((a, b) => a - b);
  // 共用 URL = 可变字体，文件名不挂字重（挂了会让人误以为是某个静态字重）
  const variable = weights.length > 1;
  const name = variable
    ? `${slug(entry.family)}-${entry.subset}.woff2`
    : `${slug(entry.family)}-${entry.subset}-${weights[0]}.woff2`;
  const target = path.join(FONT_DIR, name);

  if (!existsSync(target)) {
    const res = await fetch(entry.url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`下载失败 ${entry.url} → ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // woff2 魔数 + 体积兜底：避免把 404 页面 / 截断文件当成字体存下来
    if (buf.length < 1000 || buf.subarray(0, 4).toString("latin1") !== "wOF2") {
      throw new Error(`不是有效 woff2: ${name} (${buf.length}B)`);
    }
    await writeFile(target, buf);
  }

  faces.push({
    family: entry.family,
    subset: entry.subset,
    range: entry.range,
    name,
    variable,
    // 可变字体声明字重区间，静态字体声明单个字重
    weightDecl: variable ? `${weights[0]} ${weights[weights.length - 1]}` : String(weights[0]),
  });
}

// 清掉已被本次归并逻辑取代的旧文件（避免仓库里留一堆没人引用的 woff2）
const referenced = new Set(faces.map((face) => face.name));
for (const file of await readdir(FONT_DIR)) {
  if (file.endsWith(".woff2") && !referenced.has(file)) await unlink(path.join(FONT_DIR, file));
}

faces.sort((a, b) =>
  a.family === b.family ? a.subset.localeCompare(b.subset) : a.family.localeCompare(b.family),
);

const sizes = await Promise.all(faces.map((face) => stat(path.join(FONT_DIR, face.name))));
const totalBytes = sizes.reduce((sum, item) => sum + item.size, 0);

const header = `/* 自托管字体：Inter 与 DM Mono（OFL 授权，可随应用分发），仅 latin / latin-ext 子集。
 *
 * 为什么不再用 Google Fonts 的 @import：
 *   1. 离线 / 内网环境下 fonts.googleapis.com 不可达，字体静默回退到系统字体，
 *      字重与字形都会漂移，界面看起来"换了个样子"；
 *   2. 每次加载都会把用户 IP 和页面 Referer 发给第三方；
 *   3. CSS 的 @import 是串行阻塞链：必须先拿到 Google 的 CSS 才知道 woff2 真实地址，
 *      白白多一个 RTT。自托管后字体与样式同源，可复用同一条连接。
 *
 * font-display: swap —— 字体未就绪时先用系统字体渲染，避免首屏文字空白；
 * unicode-range 沿用上游取值 —— 中文不落在这些区间内，仍由 theme.css 的回退链
 * 交给系统字体（PingFang SC 等），所以不需要下载体积巨大的中文字体。
 *
 * 本文件由 scripts/fetch-fonts.mjs 生成，请勿手工编辑：
 * ${faces.length} 个 @font-face，字体文件合计 ${(totalBytes / 1024).toFixed(1)} KB。
 */
`;

const bodies = faces.map(
  (face) => `/* ${face.family} · ${face.subset} —— ${
    face.variable
      ? `可变字体，单文件按 wght 轴插值覆盖 ${face.weightDecl}`
      : `静态字体，仅字重 ${face.weightDecl}`
  } */
@font-face {
  font-family: '${face.family}';
  font-style: normal;
  font-weight: ${face.weightDecl};
  font-display: swap;
  src: url('../assets/fonts/${face.name}') format('woff2');
  unicode-range: ${face.range};
}`,
);

await writeFile(CSS_OUT, `${header}\n${bodies.join("\n\n")}\n`);

console.log(`写入 ${faces.length} 个 @font-face，字体合计 ${(totalBytes / 1024).toFixed(1)} KB`);
for (const face of faces) {
  console.log(`  ${face.name.padEnd(28)} weight=${face.weightDecl}${face.variable ? "  (variable)" : ""}`);
}
