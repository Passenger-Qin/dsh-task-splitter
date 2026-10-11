#!/usr/bin/env node
/**
 * task-parts —— 长任务"分段执行 + 组装"工具（给本地模型用）
 *
 * 为什么需要：本地模型单次输出预算小（maxTokens 8192），一次写不完长文档。
 * 把长任务拆成多个小段，每段单独一次输出（各有一份预算），最后按顺序拼装，
 * 既不依赖模型自觉、也不受单次上限影响。
 *
 * 用法：
 *   node task-parts.mjs init <taskDir> --title "标题" --parts "段1|段2|段3"
 *   node task-parts.mjs status <taskDir>
 *   node task-parts.mjs assemble <taskDir> [--out final.md] [--force]
 *   node task-parts.mjs next <taskDir>          # 打印下一个待写段落的信息
 *
 * 目录结构：
 *   <taskDir>/MANIFEST.json
 *   <taskDir>/parts/01-段1.md ...
 *   <taskDir>/final.md            （assemble 产物）
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , command, target, ...rest] = process.argv;
const flag = (name, fallback = undefined) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};
const has = (name) => rest.includes(`--${name}`);

function slugify(text, index) {
  const cleaned = String(text).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return `${String(index + 1).padStart(2, '0')}-${cleaned || 'part'}`;
}
function loadManifest(dir) {
  const file = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(file)) throw new Error(`找不到 MANIFEST.json：${file}`);
  return { file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}
function saveManifest(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function partPath(dir, part) {
  return path.join(dir, 'parts', part.file);
}
function measure(dir, part) {
  const file = partPath(dir, part);
  if (!fs.existsSync(file)) return { exists: false, chars: 0, body: '' };
  const body = fs.readFileSync(file, 'utf8').replace(/^#[^\n]*\n+/, '').trim();
  return { exists: true, chars: body.length, body };
}

function cmdInit() {
  if (!target) throw new Error('用法: init <taskDir> --parts "段1|段2"');
  const title = flag('title', path.basename(target));
  const raw = flag('parts', '');
  const titles = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (titles.length === 0) throw new Error('需要 --parts "段1|段2|..."');
  fs.mkdirSync(path.join(target, 'parts'), { recursive: true });
  const parts = titles.map((t, i) => ({ index: i + 1, title: t, file: `${slugify(t, i)}.md` }));
  for (const part of parts) {
    const file = partPath(target, part);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${part.title}\n\n`, 'utf8');
  }
  const data = { title, createdAt: new Date().toISOString(), parts };
  const { file } = { file: path.join(target, 'MANIFEST.json') };
  saveManifest(file, data);
  console.log(`已创建任务「${title}」：${parts.length} 段`);
  for (const p of parts) console.log(`  ${String(p.index).padStart(2, '0')}  ${p.file}   ${p.title}`);
  console.log(`\n下一步：逐段填写 parts/*.md，然后运行  node task-parts.mjs assemble "${target}"`);
}

function report(dir) {
  const { data } = loadManifest(dir);
  const min = Number(flag('min', 100));
  const rows = data.parts.map((p) => {
    const { exists, chars } = measure(dir, p);
    return { ...p, exists, chars, done: exists && chars >= min };
  });
  return { data, rows, min };
}

function cmdStatus() {
  const { data, rows, min } = report(target);
  console.log(`任务：${data.title}（每段至少 ${min} 字才算完成）`);
  let done = 0;
  for (const r of rows) {
    if (r.done) done += 1;
    console.log(`  ${r.done ? '✅' : '⬜'} ${String(r.index).padStart(2, '0')} ${r.title}  (${r.chars} 字)  ${r.file}`);
  }
  console.log(`\n完成 ${done}/${rows.length}`);
  const pending = rows.find((r) => !r.done);
  if (pending) {
    console.log(`下一段：${pending.index}/${rows.length} 「${pending.title}」→ ${path.join('parts', pending.file)}`);
    process.exitCode = 2;
  }
}

function cmdNext() {
  const { rows } = report(target);
  const pending = rows.find((r) => !r.done);
  if (!pending) return console.log('全部段落已完成，可以 assemble 了。');
  console.log(JSON.stringify({ index: pending.index, title: pending.title, file: path.join('parts', pending.file) }, null, 2));
}

function cmdAssemble() {
  const { data, rows } = report(target);
  const missing = rows.filter((r) => !r.done);
  if (missing.length > 0 && !has('force')) {
    console.error(`还有 ${missing.length} 段未完成（用 --force 可强行拼装）：${missing.map((m) => m.index).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const out = flag('out', 'final.md');
  const outPath = path.isAbsolute(out) ? out : path.join(target, out);
  const chunks = [`# ${data.title}`, ''];
  for (const r of rows) {
    const { body } = measure(target, r);
    chunks.push(`<!-- part ${r.index}/${rows.length}: ${r.title} -->`, '', body || `（本段为空：${r.title}）`, '');
  }
  const text = chunks.join('\n');
  fs.writeFileSync(outPath, text, 'utf8');
  console.log(`已拼装 ${rows.length} 段 → ${outPath}（${text.length} 字）`);
  if (missing.length > 0) console.log(`注意：有 ${missing.length} 段为空/过短（${missing.map((m) => m.index).join(', ')}）`);
}

try {
  switch (command) {
    case 'init': cmdInit(); break;
    case 'status': cmdStatus(); break;
    case 'next': cmdNext(); break;
    case 'assemble': cmdAssemble(); break;
    default:
      console.log('用法: node task-parts.mjs <init|status|next|assemble> <taskDir> [选项]');
      process.exitCode = 1;
  }
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
}
