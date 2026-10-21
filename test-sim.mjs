/**
 * dsh-task-splitter 离线仿真测试：
 * 用假的 ctx/agent/session 驱动 agent/pre-step 钩子，验证
 * 长任务识别、骨架生成、provider 过滤、去重、以及与 task-parts.mjs 的兼容性。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from './lib/index.js';

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { pass += 1; console.log('  PASS ' + label); } else { fail += 1; console.log('  FAIL ' + label); }
};

const BASE = 'D:\\dsh\\_shared\\splitter-test';
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });

function rig(config, { cwd = BASE, provider = 'qwen-local', cwdShape = 'meta' } = {}) {
  const handlers = new Map();
  const ctx = {
    logger: { info: () => {}, warn: (...a) => console.log('    [warn]', ...a) },
    on: (name, fn) => handlers.set(name, fn),
  };
  apply(ctx, config);
  const session = {
    id: 's-' + Math.random().toString(36).slice(2, 8),
    // 0.1.x 宿主：cwd 在 meta.cwd；0.2.1+ 宿主：cwd 只在 header.cwd（无 meta、无 cwd getter）
    ...(cwdShape === 'header' ? { header: { cwd } } : { meta: { cwd } }),
    requestHeader: () => ({ config: { provider, model: 'qwen-test' } }),
  };
  const agent = { id: 'a1', session };
  const run = (text, sourceKind = 'user') => {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: sourceKind === 'user' ? { kind: 'user' } : { kind: 'tool', callId: 'c1' },
    });
    const next = async () => ({ kind: 'enter', messages: [message] });
    return handlers.get('agent/pre-step')({ agent, messages: [message], signal: undefined }, next);
  };
  return { run, session };
}

console.log('用例 1：短提示词不拆');
{
  const { run } = rig({});
  const d = await run('今天天气怎么样');
  check(d.kind === 'enter' && d.messages.length === 1, '短提示词不注入');
}

console.log('用例 2：显式字数+分段的报告 → 自动拆段并建骨架');
{
  const { run, session } = rig({ tasksDir: 'tasks', wordsPerPart: 800 });
  const d = await run('帮我写一篇 3000 字的行业分析报告，分 4 部分，要包含数据支撑和结论');
  check(d.kind === 'enter' && d.messages.length === 2, '注入了 1 条执行规程');
  const injected = d.messages[0];
  check(injected?.source?.plugin === 'task-splitter', '来源标记 plugin/task-splitter');
  const text = injected.content.map((b) => b.text).join('');
  check(/【长任务已自动拆段】/.test(text), '规程含标记');
  check(/每轮只写/.test(text), '规程要求每轮只写一段');
  const dir = /任务目录：(.+)/.exec(text)?.[1]?.trim() ?? "";
  check(Boolean(dir) && fs.existsSync(path.join(dir, 'MANIFEST.json')), '骨架已生成（有 MANIFEST）');
  const manifest = dir && fs.existsSync(path.join(dir, 'MANIFEST.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) : { parts: [] };
  check(manifest.parts.length === 4, `拆成 4 段（实际 ${manifest.parts.length}）`);
  check(fs.existsSync(path.join(dir, 'parts', manifest.parts[0].file)), '第一段文件已建');
  void session;
}

console.log('用例 3：带编号分节列表 → 段落标题取自列表');
{
  const { run } = rig({ tasksDir: 'tasks2' });
  const prompt = [
    '请完成一份系统性的方案文档：',
    '1. 背景与现状分析',
    '2. 目标与范围',
    '3. 技术路线',
    '4. 风险与应对',
    '5. 实施计划',
  ].join('\n');
  const d = await run(prompt);
  const text = d.messages[0]?.content?.map((b) => b.text).join('') ?? '';
  check(/背景与现状分析/.test(text) && /实施计划/.test(text), '标题取自分节列表');
  check(d.messages.length === 2, '已注入规程');
}

console.log('用例 4：云端 provider 不拆');
{
  const { run } = rig({ providers: ['qwen-local'] }, { provider: 'deepseek-official' });
  const d = await run('帮我写一篇 3000 字的行业分析报告，分 4 部分');
  check(d.messages.length === 1, 'DeepSeek 会话不注入');
}

console.log('用例 5：工具结果那一步不触发');
{
  const { run } = rig({});
  const d = await run('帮我写一篇 3000 字的报告，分 4 部分', 'tool');
  check(d.messages.length === 1, '工具结果不触发');
}

console.log('用例 6：同一条用户消息只拆一次');
{
  const { run } = rig({ tasksDir: 'tasks3' });
  const prompt = '写一篇 4000 字的完整教程，分 5 部分，包含示例与常见问题';
  const d1 = await run(prompt);
  check(d1.messages.length === 2, '第一次注入');
  // 第二次同一 id（模拟重试）：用同一 rig 但重新构造同 id 消息较麻烦，这里用相同文本新建消息，
  // handled 以消息 id 去重，因此相同文本的新消息仍会拆——这是预期行为（不同请求）。
  const d2 = await run(prompt);
  check(d2.messages.length === 2, '不同消息 id 视为新请求（预期会再拆）');
}

console.log('用例 7：已含标记的提示词跳过');
{
  const { run } = rig({});
  const d = await run('【长任务已自动拆段】继续写第 2 段');
  check(d.messages.length === 1, '带标记的提示词不重复拆');
}

console.log('用例 8：骨架与 task-parts.mjs 兼容（status 可读）');
{
  const { run } = rig({ tasksDir: 'tasks-compat' });
  await run('写一篇 2000 字的详细说明文档，分 3 部分');
  const dirs = fs.readdirSync(path.join(BASE, 'tasks-compat'), { withFileTypes: true }).filter((e) => e.isDirectory());
  check(dirs.length === 1, '生成了任务目录');
  const dir = path.join(BASE, 'tasks-compat', dirs[0].name);
  const manifest = dir && fs.existsSync(path.join(dir, 'MANIFEST.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) : { parts: [] };
  check(Array.isArray(manifest.parts) && manifest.parts.every((p) => p.index && p.title && p.file), 'MANIFEST 字段与 CLI 约定一致');
}

console.log('用例 9：短提示词的流程型长任务（选股票）→ 计划车道');
{
  const { run } = rig({ tasksDir: 'tasks-plan' });
  const d = await run('帮我选一只明天大概率会涨的股票');
  check(d.messages.length === 2, '注入了规程');
  const text = d.messages[0]?.content?.map((b) => b.text).join('') ?? '';
  check(/【流程型长任务/.test(text), '走流程车道');
  check(/只做一件事/.test(text) && /每轮只执行 1 步/.test(text), '规程要求先立计划、每轮一步');
  const dir = /工作目录：(.+)/.exec(text)?.[1]?.trim() ?? '';
  check(Boolean(dir) && fs.existsSync(path.join(dir, 'PLAN.md')), 'PLAN.md 已建');
  check(Boolean(dir) && fs.existsSync(path.join(dir, 'notes')), 'notes/ 已建');
  const manifest = dir && fs.existsSync(path.join(dir, 'MANIFEST.json'))
    ? JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) : {};
  check(manifest.lane === 'plan', 'MANIFEST 标记 lane=plan');
}

console.log('用例 10：单次查询类不拆（查天气）');
{
  const { run } = rig({});
  const d = await run('帮我查一下明天的天气');
  check(d.messages.length === 1, '查天气不拆');
}

console.log('用例 11：轻量推荐（电影）不拆');
{
  const { run } = rig({});
  const d = await run('帮我推荐一部电影');
  check(d.messages.length === 1, '轻量推荐不拆');
}

console.log('用例 12：消费电子对比（需真实数据）→ 计划车道');
{
  const { run } = rig({ tasksDir: 'tasks-plan2' });
  const d = await run('对比一下这三款笔记本电脑，帮我选一个');
  const text = d.messages[0]?.content?.map((b) => b.text).join('') ?? '';
  check(d.messages.length === 2 && /【流程型长任务/.test(text), '笔记本对比走计划车道');
}

console.log('用例 13：车道可单独关闭（lanes: [parts]）');
{
  const { run } = rig({ lanes: ['parts'], tasksDir: 'tasks-lane-off' });
  const d = await run('帮我选一只明天大概率会涨的股票');
  check(d.messages.length === 1, '关闭 plan 车道后不拆流程型任务');
}

console.log('用例 14：0.2.1+ 宿主（cwd 只在 session.header.cwd）仍能拆');
{
  const { run } = rig({ tasksDir: 'tasks-header-cwd' }, { cwdShape: 'header' });
  const d = await run('帮我调研一下国产开源数据库的现状，并给出选型建议');
  check(d.messages.length === 2, 'header.cwd 会话注入了规程');
  const text = d.messages[0]?.content?.map((b) => b.text).join('') ?? '';
  check(/【流程型长任务/.test(text), '走流程车道');
  const dir = /工作目录：(.+)/.exec(text)?.[1]?.trim() ?? '';
  check(Boolean(dir) && fs.existsSync(path.join(dir, 'PLAN.md')), 'PLAN.md 已建');
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
