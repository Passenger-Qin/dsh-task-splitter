/**
 * dsh-task-splitter — 自动识别长任务并**分两种车道**处理。
 *
 * 车道 A（产出型）：产出很长（长报告/长文档/长代码）→ 瓶颈是单次输出预算(maxTokens)
 *   → 建 `tasks/<slug>/parts/NN-*.md` 骨架 + 每轮只写一段的规程。
 *
 * 车道 B（流程型）：提示词可以很短，但**要做的事步骤多、依赖外部数据/多轮推理**
 *   → 瓶颈是步骤数与上下文（工具结果塞满窗口、小模型多步后跑偏、中间结果丢失）
 *   → 建 `tasks/<slug>/PLAN.md` + `notes/` 骨架 + "先立计划、每轮一步、中间结果落盘"的规程。
 *
 * 判定在**宿主侧**完成（不依赖小模型自觉）：
 * - 产出型信号：显式字数/页数、显式分段、编号分节列表、长文关键词+写作动词、超长提示词、多部分交付；
 * - 流程型信号：决策/研究类动词（帮我选/推荐/评估/对比/分析/判断/预测/调研/筛选…）
 *   + 需要数据的领域名词（股票/基金/房价/机票/保险/论文/竞品/选型…）、显式多步措辞。
 *
 * 注入方式：`agent/pre-step` 里把规程**前置**到这一步的消息中（同一次请求送达，不额外耗一轮）。
 * 只处理"人类新请求"那一步；同一消息只处理一次；provider 默认只对 qwen-local 生效。
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'task-splitter';

export const inject = ['agents', 'sessions'];

/** 包内自带的推进/拼装 CLI（发布版不再依赖作者本机路径）。 */
const TOOL_DEFAULT = fileURLToPath(new URL('../bin/task-parts.mjs', import.meta.url));

/** 车道 A：长文关键词。 */
const LONG_KEYWORDS = [
  '报告', '方案', '白皮书', '论文', '手册', '教程', '攻略', '说明书', '调研', '综述', '长文', '详细说明',
  '完整', '系统梳理', '全面', '深入', '展开讲', '分章节', '分节', '大纲', '多章节', '一篇文章', '设计方案',
];
/** 车道 A：写作类动词。 */
const WRITE_VERBS = ['写', '撰写', '生成', '整理', '输出', '起草', '编写'];
/** 车道 B：决策/研究类动词（暗示多步、依赖外部信息）。 */
const FLOW_VERBS = [
  '帮我选', '帮我挑', '帮我找', '帮我推荐', '帮我判断', '帮我评估', '帮我分析', '帮我查', '帮我调研',
  '推荐', '评估', '对比', '比较', '判断', '预测', '调研', '筛选', '挑一个', '选一个', '选哪个', '怎么选',
  '值不值得', '拿主意', '给出建议', '排序', '打分',
];
/** 车道 B：需要真实数据/多源信息的领域名词。 */
const FLOW_DOMAINS = [
  '股票', '股价', '基金', '基金定投', '理财', '保险', '贷款', '房价', '楼盘', '二手房', '二手车', '车',
  '机票', '酒店', '旅游路线', '行程', '论文', '文献', '法条', '法规', '合规', '竞品', '市场', '供应商',
  '选型', '配置', '装机', 'offer', '岗位', '大学', '专业', '课程', '医院', '医生', '药', '签证',
  '电脑', '笔记本', '手机', '相机', '显示器', '耳机', '家电', '显卡',
];
/** 车道 B：显式多步措辞。 */
const FLOW_STEPWORDS = ['第一步', '然后', '接着', '最后', '分几步', '一步步', '按步骤', '逐个', '逐一', '依次'];

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

/** 是否是需要处理的人类新请求（跳过工具结果、插件注入、子 agent）。 */
function humanPromptOf(messages) {
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue;
    const text = textOf(message);
    if (text.length > 0) return { message, text };
  }
  return undefined;
}

/** 车道 A 打分：产出型长任务。 */
function scoreOutput(text, cfg) {
  const reasons = [];
  let score = 0;
  const sections = [];

  const chars = /\b(\d{3,6})\s*字/.exec(text);
  if (chars) { score += 3; reasons.push(`显式字数 ${chars[1]}`); }
  const pages = /(\d{1,3})\s*页/.exec(text);
  if (pages) { score += 2; reasons.push(`显式页数 ${pages[1]}`); }
  const seg = /(?:分|划分为|拆成|分成)\s*(\d{1,2})\s*(?:段|部分|节|章|块)/.exec(text);
  if (seg) { score += 3; reasons.push(`显式分段 ${seg[1]}`); }

  const lines = text.split(/\r?\n/);
  const itemLines = lines.filter((line) => /^\s*(?:\d{1,2}[.、)）]|[一二三四五六七八九十]{1,2}[、.]|[-*]\s)/.test(line));
  if (itemLines.length >= 3) { score += 2; reasons.push(`分节列表 ${itemLines.length} 项`); }
  if (itemLines.length >= 2 && itemLines.length <= 12) {
    for (const line of itemLines) {
      const title = line.replace(/^\s*(?:\d{1,2}[.、)）]|[一二三四五六七八九十]{1,2}[、.]|[-*]\s)/, '').trim();
      if (title.length > 0 && title.length <= 40) sections.push(title);
    }
  }

  const hits = LONG_KEYWORDS.filter((keyword) => text.includes(keyword));
  const hasVerb = WRITE_VERBS.some((verb) => text.includes(verb));
  if (hits.length > 0) { score += Math.min(2, hits.length); reasons.push(`长文关键词 ${hits.slice(0, 3).join('/')}`); }
  if (hits.length > 0 && hasVerb) { score += 1; reasons.push('写作动词+长文关键词'); }

  if (text.length >= 400) { score += 2; reasons.push(`提示词 ${text.length} 字`); }
  else if (text.length >= 200) { score += 1; reasons.push(`提示词 ${text.length} 字`); }

  if (/(?:以及|并且|同时|还要|另外).{0,40}(?:写|做|给出|输出)/.test(text)) { score += 1; reasons.push('多部分交付'); }

  const explicit = Boolean(chars || pages || seg || itemLines.length >= 3);
  return { score, reasons, chars: chars ? Number(chars[1]) : undefined, sections, explicit };
}

/** 车道 B 打分：流程型长任务（提示词可以很短）。 */
function scoreWorkflow(text, cfg) {
  const reasons = [];
  let score = 0;
  const flowVerb = FLOW_VERBS.find((verb) => text.includes(verb));
  if (flowVerb) { score += 2; reasons.push(`决策/研究动词「${flowVerb}」`); }
  const domain = FLOW_DOMAINS.find((word) => text.includes(word));
  if (domain && flowVerb) { score += 1; reasons.push(`依赖数据的领域「${domain}」`); }
  const stepwords = FLOW_STEPWORDS.filter((word) => text.includes(word));
  if (stepwords.length >= 2) { score += 2; reasons.push(`显式多步措辞 ${stepwords.slice(0, 3).join('/')}`); }
  // 需要外部信息才能回答的措辞
  if (/(?:最新|今天|明天|近期|目前|实时|当前).{0,20}(?:行情|股价|价格|数据|情况|政策|新闻)/
      .test(text) || /(?:查|搜|收集|核实).{0,10}(?:资料|数据|行情|信息|来源)/.test(text)) {
    score += 1; reasons.push('需外部实时信息');
  }
  const researchOnly = !flowVerb && /(?:查一下|搜一下|看一下)/.test(text);
  if (researchOnly) score = Math.min(score, cfg.workflowScore - 1); // 单次查询类不给过
  return { score, reasons };
}

/** 生成安全的文件名片段。 */
function slugify(text, fallback = 'part') {
  const cleaned = String(text)
    .replace(/[，。、；：！？（）【】《》“”‘’·—…~!@#$%^&*()+=\[\]{};:'",.<>/?\\|`\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 24) || fallback;
}

/* ------------------------------- 车道 A：分段骨架 ------------------------------- */

function planParts(detection, cfg) {
  const titles = [];
  if (detection.sections.length >= 2) {
    for (const title of detection.sections) if (!titles.includes(title)) titles.push(title);
  }
  const wanted = detection.chars ? Math.ceil(detection.chars / cfg.wordsPerPart) : 4;
  const target = Math.max(2, Math.min(cfg.maxParts, Math.max(titles.length, wanted)));
  while (titles.length < target) titles.push(`第 ${titles.length + 1} 段`);
  return titles.slice(0, cfg.maxParts);
}

function scaffoldParts(baseDir, title, titles) {
  const dir = path.join(baseDir, slugify(title, 'task'));
  fs.mkdirSync(path.join(dir, 'parts'), { recursive: true });
  const parts = titles.map((partTitle, index) => {
    const generic = /^第\s*\d+\s*段$/.test(partTitle.trim());
    const stem = generic ? `part-${String(index + 1).padStart(2, '0')}` : slugify(partTitle, `part-${index + 1}`);
    return { index: index + 1, title: partTitle, file: `${String(index + 1).padStart(2, '0')}-${stem}.md` };
  });
  for (const part of parts) {
    const file = path.join(dir, 'parts', part.file);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${part.title}\n\n`, 'utf8');
  }
  fs.writeFileSync(
    path.join(dir, 'MANIFEST.json'),
    JSON.stringify({ title, lane: 'parts', createdAt: new Date().toISOString(), parts }, null, 2),
    'utf8',
  );
  return { dir, parts };
}

function instructionParts(dir, parts, cfg) {
  const list = parts.map((part) => `${part.index}. ${part.title}`).join(' / ');
  return [
    '【长任务已自动拆段】这条请求属于"长产出"，已按本地模型的单次输出预算拆成多段，骨架已建好，不要一次性写整篇。',
    `任务目录：${dir}`,
    `分段：${list}`,
    '规程：每轮只写 **1 段**到 parts/NN-*.md（保留文件首行标题），写完立即停，不要顺手写下一段；不要重复前言/目录。',
    `进度：node "${cfg.toolPath}" status "${dir}"　拼装：node "${cfg.toolPath}" assemble "${dir}"`,
    '全部段落完成后拼装成 final.md，通读做衔接修订。',
      ...(cfg.extraRules ? [cfg.extraRules] : []),
  ].join('\n');
}

/* ------------------------------- 车道 B：计划骨架 ------------------------------- */

function scaffoldPlan(baseDir, title, text) {
  const dir = path.join(baseDir, slugify(title, 'task'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  const planFile = path.join(dir, 'PLAN.md');
  if (!fs.existsSync(planFile)) {
    const plan = [
      `# 计划：${title}`,
      '',
      '> 由 dsh-task-splitter 自动建立。**先补全下面的步骤表，再逐步执行**；',
      '> 每一步的原始数据与中间结果写进 `notes/NN-*.md`，不要把大段工具输出堆在对话里。',
      '',
      '## 目标',
      '',
      '（一句话写清最终要交付什么、判定标准是什么）',
      '',
      '## 步骤表',
      '',
      '| # | 步骤 | 需要的工具/数据 | 产出文件 | 验收要点 | 状态 |',
      '|---|---|---|---|---|---|',
      '| 1 |  |  | notes/01-*.md |  | 待办 |',
      '| 2 |  |  | notes/02-*.md |  | 待办 |',
      '',
      '## 已知约束与风险',
      '',
      `- 原始请求：${text.replace(/\s+/g, ' ').slice(0, 200)}`,
      '- 数据必须给出处；无法核实的部分要标注「未核实」',
      '- 结论必须包含不确定性与反面情形，不得把推测写成事实',
      '',
      '## 结论',
      '',
      '（全部步骤完成后汇总到这里，必要时另存 final.md）',
      '',
    ].join('\n');
    fs.writeFileSync(planFile, plan, 'utf8');
  }
  fs.writeFileSync(
    path.join(dir, 'MANIFEST.json'),
    JSON.stringify({ title, lane: 'plan', createdAt: new Date().toISOString(), plan: 'PLAN.md', notesDir: 'notes' }, null, 2),
    'utf8',
  );
  return { dir, planFile };
}

function instructionPlan(dir, cfg) {
  return [
    '【流程型长任务：先立计划，再逐步执行】这条请求看起来简单，但实际步骤多、依赖外部数据，',
    '瓶颈是**步骤数与上下文**（不是单次输出长度）。已建好工作目录，按下面规程做：',
    `工作目录：${dir}`,
    '1. **本轮只做一件事**：把 PLAN.md 的步骤表补全为 5~10 步（每步写清：目标 / 需要的工具或数据 / 产出文件 / 验收要点）。不要开始执行，不要给结论。',
    '2. 之后**每轮只执行 1 步**；该步的原始数据与中间结果写进 notes/NN-*.md，**不要**把大段工具输出留在对话里（避免上下文爆）。',
    '3. 每完成一步，回到 PLAN.md 更新该行状态；需要外部信息就调用你当前可用的搜索工具，并把来源与时间记进对应的 notes 文件。',
    '4. 重活（多文件阅读、交叉核对）可派给子智能体——**只用你当前环境里真实存在的委派工具**；结论必须给出证据链与不确定性。',
    `5. 全部步骤完成后汇总到 PLAN.md 的「结论」；若结论很长，用 node "${cfg.toolPath}" init/assemble 分段写。`,
    '6. 先把"取第一手数据"这类**必须真实执行**的步骤排在最前；无法执行的步骤要在计划里写明替代方案，不要编造数据。',
    ...(cfg.extraRules ? [cfg.extraRules] : []),
  ].join('\n');
}

/* ----------------------------------- 装配 ----------------------------------- */

export function apply(ctx, config) {
  const input = config ?? {};
  const cfg = {
    enabled: input.enabled !== false,
    providers: Array.isArray(input.providers) ? input.providers.filter((p) => typeof p === 'string' && p) : ['qwen-local'],
    minScore: Number.isSafeInteger(input.minScore) ? input.minScore : 3,
    workflowScore: Number.isSafeInteger(input.workflowScore) ? input.workflowScore : 3,
    minPromptChars: Number.isSafeInteger(input.minPromptChars) ? input.minPromptChars : 40,
    maxParts: Number.isSafeInteger(input.maxParts) ? input.maxParts : 8,
    wordsPerPart: Number.isSafeInteger(input.wordsPerPart) && input.wordsPerPart > 0 ? input.wordsPerPart : 900,
    tasksDir: typeof input.tasksDir === 'string' && input.tasksDir ? input.tasksDir : 'tasks',
    toolPath: typeof input.toolPath === 'string' && input.toolPath ? input.toolPath : TOOL_DEFAULT,
    lanes: Array.isArray(input.lanes) ? input.lanes.filter((l) => l === 'parts' || l === 'plan') : ['parts', 'plan'],
    // 机器/环境特定的补充规程（不写死在代码里，避免硬编码过时的工具名或服务地址）
    extraRules: typeof input.extraRules === 'string' && input.extraRules.trim() ? input.extraRules.trim() : '',
  };
  if (!cfg.enabled) {
    ctx.logger?.info?.('task-splitter: disabled by config');
    return;
  }
  const handled = new Map();

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== 'enter') return decision;
      const session = agent?.session;
      if (session === undefined) return decision;

      let provider = '';
      try {
        const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
        provider = header?.config?.provider ?? '';
      } catch { /* 读不到就不过滤 */ }
      if (cfg.providers.length > 0 && provider.length > 0 && !cfg.providers.includes(provider)) return decision;

      const human = humanPromptOf(decision.messages);
      if (human === undefined) return decision;
      if (human.text.includes('【长任务已自动拆段】') || human.text.includes('【流程型长任务')) return decision;
      if (handled.get(session.id) === human.message.id) return decision;

      // 两条车道独立评分：产出型看"要写多长"，流程型看"要做多少步/是否依赖外部数据"。
      // 提示词短不再是流程型的否决条件 —— 恰恰相反，"帮我选一只股票"这种短提示正是它要抓的。
      const output = scoreOutput(human.text, cfg);
      const workflow = scoreWorkflow(human.text, cfg);

      const usePlan = cfg.lanes.includes('plan') && workflow.score >= cfg.workflowScore;
      const useParts = cfg.lanes.includes('parts') && !usePlan && output.score >= cfg.minScore;
      if (!usePlan && !useParts) return decision;

      const cwd = session.meta?.cwd ?? session.cwd;
      if (typeof cwd !== 'string' || cwd.length === 0) {
        ctx.logger?.warn?.('task-splitter: 会话缺少 cwd，跳过自动拆段');
        return decision;
      }
      const baseDir = path.join(cwd, cfg.tasksDir);
      const title = human.text.replace(/\s+/g, ' ').slice(0, 60);

      let text;
      let summary;
      let logLane;
      try {
        if (usePlan) {
          const created = scaffoldPlan(baseDir, title, human.text);
          text = instructionPlan(created.dir, cfg);
          summary = '流程型长任务：已建计划骨架';
          logLane = `plan(score=${workflow.score}: ${workflow.reasons.join('; ')}) → ${created.dir}`;
        } else {
          const created = scaffoldParts(baseDir, title, planParts(output, cfg));
          text = instructionParts(created.dir, created.parts, cfg);
          summary = `长任务已拆成 ${created.parts.length} 段`;
          logLane = `parts(score=${output.score}: ${output.reasons.join('; ')}) → ${created.dir}（${created.parts.length} 段）`;
        }
      } catch (error) {
        ctx.logger?.warn?.(`task-splitter: 建骨架失败: ${error}`);
        return decision;
      }
      handled.set(session.id, human.message.id);
      ctx.logger?.info?.(`task-splitter: ${provider || 'unknown'} ${logLane}`);

      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary },
      });
      return { kind: 'enter', messages: [message, ...decision.messages] };
    } catch (error) {
      ctx.logger?.warn?.(`task-splitter: ${error}`);
      return decision;
    }
  });

  ctx.logger?.info?.(
    `task-splitter: enabled (车道 ${cfg.lanes.join('/')}, 产出阈值 ${cfg.minScore}, 流程阈值 ${cfg.workflowScore}, providers: ${cfg.providers.join(',') || 'all'})`,
  );
}
