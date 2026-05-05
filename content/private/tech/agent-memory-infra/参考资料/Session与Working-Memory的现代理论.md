# Session 与 Working Memory 的现代理论

> **版本归属**: 版本D
> **文档定位**: 架构原理修正与现代 Agent 场景的理论综合
> **关联章节**: 《00-概要设计》第 4 章（Working Memory 架构）
> **触发背景**: 版本C对 Working Memory 的定义过于窄化，需结合业界实践与认知科学原意进行修正

---

## 序言：为什么需要重新思考 Working Memory

版本C提出了一个有价值的观察：原始 AMS 设计中对 Working Memory 的"固定 TTL（5分钟～2小时）"定义已不符合现代 AI Agent 的实际行为。但它走向了另一个极端——**将 Working Memory 窄化成了纯粹的"执行上下文"（Context Window）**，这同样是对概念的误读。

本文结合 **CoALA 认知架构框架**、**Letta/MemGPT 工程实践** 以及 **Baddeley 认知科学原始定义**，对 Working Memory 进行更准确的理论定位，同时保留版本C中关于 Session Archive 和长期知识分层的有价值的洞察。

---

## 第一部分：Working Memory 的理论基础

### 1.1 认知科学源头：Baddeley 的多成分模型

Working Memory 概念源自认知心理学，核心文献是 **Baddeley & Hitch (1974)**，后由 Baddeley 在 2000 年完善。

| 成分 | 功能 |
|------|------|
| **Central Executive** | 注意力控制系统，协调子系统，管理任务切换 |
| **Phonological Loop** | 保持和复述语音/听觉信息 |
| **Visuospatial Sketchpad** | 维护和操作视觉/空间信息 |
| **Episodic Buffer** (2000 新增) | 整合各子系统和长期记忆的信息为连贯情景 |

**关键区分：Working Memory ≠ Short-Term Memory**

| 特征 | Short-Term Memory | Working Memory |
|------|-------------------|----------------|
| 存储 | ✅ 被动存储 | ✅ 存储 |
| 主动操控 | ❌ | ✅ 读取、写入、变换、比较 |
| 目标导向 | ❌ 仅按时间衰减 | ✅ 围绕当前任务组织 |
| 结构化 | ❌ 扁平列表 | ✅ 有类型、有 schema |
| 跨步骤持久 | ❌ | ✅ 跨多步任务 |

**关键洞察**：Working Memory 的核心特征是**主动操控（manipulation）**而非单纯的**存储（storage）**。

### 1.2 CoALA 框架的形式化定义

**CoALA (Cognitive Architectures for Language Agents, Sumers et al., 2023)** 是最权威的语言 Agent 认知架构框架。

它将 Agent 架构定义为四元组：
```
Agent = ⟨Working Memory, Long-Term Memory, Decision Procedure, Action Space⟩
```

**CoALA 对 Working Memory 的定义**：
> 包含所有当前被**主动处理和维护**的信息状态，包括：
> 1. **Active perceptions** — 当前输入/观察
> 2. **Active goals / task state** — 当前目标、子任务分解、执行进度
> 3. **Reasoning traces** — 思维链、scratchpad、中间推理结果
> 4. **Retrieved information** — 从长期记忆检索出来、当前正在使用的信息
> 5. **Action candidates** — 正在评估的候选动作

**核心洞察**：Working Memory 是**信息整合与操作的场所**，不是单纯的缓存。

### 1.3 业界实践：Letta/MemGPT 的 Working Memory

Letta（原 MemGPT）是对 Working Memory 概念最明确、最工程化的实现。

```
┌─────────────────────────────────────────────────────────┐
│  Core Memory (= Working Memory)                         │
│  • 始终注入 system prompt，始终在上下文中                  │
│  • 结构化的 Memory Blocks（human, persona, scratch, custom）│
│  • Agent 可主动读写（core_memory_append, core_memory_replace）│
│  • 跨 turn 持久，甚至跨 session                           │
└─────────────────────────────────────────────────────────┘
                    ▲ paging ▼
┌─────────────────────────────────────────────────────────┐
│  Recall Memory — 对话历史搜索                            │
│  Archival Memory — 向量数据库长期知识                     │
└─────────────────────────────────────────────────────────┘
```

**Letta 的关键创新**：
- Working Memory 是**结构化的、可编辑的、持久化的状态**
- 不只是"当前窗口"，而是 Agent **主动维护的理解状态**
- 包含用户画像、Agent 人设、当前任务状态等

---

## 第二部分：重新理论化 Agent 记忆的层级结构

### 2.1 版本C框架的修正

版本C提出了 Session 三层结构，这是有价值的，但命名和定位需要调整：

**原框架的问题**：
```
Layer 1: Execution Context (= Context Window) ← 被误标为"Working Memory"
Layer 2: Session Archive
Layer 3: Long-term Knowledge Base
```

**问题**：Layer 1 只是 Short-Term Memory / Context Window，不是真正的 Working Memory。

### 2.2 修正后的四层框架

基于 CoALA、Letta 和 LangGraph 的实践，更准确的框架是：

```
Agent Memory Architecture
│
├─ Layer 0: Sensory Buffer（感知缓冲区）
│           └─ 当前输入、环境观察、工具返回结果
│           └─ 真正的"瞬态"，单次 LLM 调用内有效
│
├─ Layer 1: Execution Context（执行上下文）
│           └─ LLM Context Window 内容
│           └─ 包括：system prompt、recent messages、retrieved chunks
│           └─ 特征：被动组装，由框架管理
│
├─ Layer 2: Working Memory（工作记忆）⭐ 核心
│           └─ Agent 主动维护的结构化状态
│           └─ 包括：task state、scratchpad、core memory blocks、plan
│           └─ 特征：主动读写，跨多步持久，目标导向
│
├─ Layer 3: Session Archive（会话存档）
│           └─ 完整会话历史的原始记录
│           └─ 用于：恢复、审计、离线分析、知识提取
│           └─ 特征：完整持久，无 TTL，事后查询
│
└─ Layer 4: Long-Term Memory（长期记忆）
            ├─ Episodic — 结构化情景记忆
            ├─ Procedural — 技能与 SOP
            └─ Semantic — 知识图谱
```

### 2.3 关键概念澄清

| 概念 | 版本C的误读 | 业界共识定义 | 来源 |
|------|------------|--------------|------|
| **Working Memory** | 仅指 Execution Context（Context Window） | **Agent 主动维护的结构化状态**，包括 task state、scratchpad、core memory | CoALA, Letta, LangGraph State |
| **Execution Context** | 未明确区分 | 被动组装的 Context Window 内容，包括 messages、retrieved chunks | LLM 推理实现 |
| **Session Archive** | ✅ 正确识别 | 完整持久化的原始会话记录，用于恢复和分析 | Claude Code, OpenClaw 实践 |
| **TTL 策略** | 主张"绑定任务生命周期" | 应分层：Sensory/Context 瞬时、Working Memory 任务绑定、Archive 无 TTL | 综合 |

**核心修正**：
> Working Memory 不是"执行上下文"的同义词。
> Execution Context 是**被动的、框架组装的、瞬时的**。
> Working Memory 是**主动的、Agent 操控的、跨步骤持久的**。

---

## 第三部分：Claude Code 场景的完整映射

### 3.1 各层在 Claude Code 中的具体对应

```
场景：在 .openclaw 中修复 TypeScript Bug，任务跨越 3 小时

Layer 0: Sensory Buffer（感知缓冲区）
├── 当前文件内容（Read 工具返回）
├── 错误日志输出
├── grep 搜索结果
└── 用户最新消息
    ↓ 单次 LLM 调用内使用

Layer 1: Execution Context（执行上下文）
├── System prompt（Claude 人设、工具定义）
├── 最近 10-20 条消息历史
├── 检索到的相关代码片段（RAG）
└── 当前工具调用结果
    ↓ 由框架组装，每次调用重新构造

Layer 2: Working Memory（工作记忆）⭐
├── Task State: {bug_id: "TS2345", status: "analyzing", step_index: 3}
├── Plan: ["1.定位错误", "2.分析类型定义", "3.修改约束", "4.验证"]
├── Scratchpad: "发现泛型约束过严，考虑 T extends A | B"
├── Core Memory: 用户偏好（TypeScript 严格模式）、项目结构认知
└── Intermediate Results: 之前步骤的部分分析结果
    ↓ Agent/框架主动维护，跨 Read/Edit/Bash 多步调用

Layer 3: Session Archive（会话存档）
├── .claude/sessions/conv-*.messages.jsonl
├── 从第一条消息到最后的完整历史
├── 所有工具调用和返回
├── 所有 CoT 推理链
└── 任务中断后可从此恢复完整上下文
    ↓ 完整持久，无 TTL，用于 resume 和事后分析

Layer 4: Long-Term Memory（长期记忆）
├── Episodic: "2026-03-27 修复 TS 泛型约束的经验"（时间线、事件链）
├── Procedural: "TypeScript 类型错误修复流程" Skill
└── Semantic: "泛型约束 vs Union Type" 知识节点
    ↓ 从 Session Archive 中提取、结构化、持久化
```

### 3.2 工作流程中的记忆流动

```
用户: "修复这个 TypeScript 错误"
    ↓
[Layer 0] Sensory: 接收用户消息、错误日志
    ↓
[Layer 1] Context: 组装 prompt（system + history + 错误信息）
    ↓
[Layer 2] Working Memory 初始化:
    task_state = {type: "bug_fix", language: "typescript", status: "started"}
    plan = ["分析错误", "定位代码", "实施修复", "验证"]
    ↓
循环（多步工具调用）:
    ├── Read 文件 → [Layer 0] 获取内容
    ├── 分析 → [Layer 2] scratchpad += "发现约束问题..."
    ├── Edit 文件 → [Layer 2] task_state.step_index += 1
    └── Bash 测试 → [Layer 2] 更新验证状态
    ↓
任务完成:
    ├── [Layer 2] task_state.status = "completed"
    ├── [Layer 3] 完整会话写入 Archive
    └── 触发 Promotion Pipeline:
        └── [Layer 4] 提取 Episodic/Procedural/Semantic 记忆
```

### 3.3 与 Letta 架构的对比

| 维度 | Letta 实现 | Claude Code / OpenClaw 映射 |
|------|-----------|----------------------------|
| **Core Memory Blocks** | `human`, `persona`, `scratch` | Task State + Scratchpad + 用户偏好 |
| **Recall Memory** | 对话历史向量检索 | Session Archive 的检索能力 |
| **Archival Memory** | 外部向量数据库 | 需要补充的 LTM 层 |
| **Agent 自编辑** | `memory_replace()`, `memory_insert()` | 通过 tool 结果更新 task state |
| **多会话共享** | Shared blocks 跨 conversation | Skill-DOM 跨任务推荐 |

---

## 第四部分：任务时长的现代分类

### 4.1 "5分钟到2小时"说法的准确性问题

版本C正确地指出这个说法需要修正，但结论不完整。基于 2024-2026 的业界数据：

| 层级 | 时长 | 典型场景 | 占比（按调用量） |
|------|------|----------|-----------------|
| **Tier 0: 瞬态** | < 10s | API 调用、embedding、分类 | ~60-70% |
| **Tier 1: 短暂** | 10s–5min | 单轮 Q&A、翻译、简单对话 | ~15-20% |
| **Tier 2: 会话** | 5min–2hr | ChatGPT/Claude 典型对话 | ~8-12% |
| **Tier 3: 自主任务** | 2min–2hr | Deep Research、Codex、SWE-agent | ~3-5% 🔺增长 |
| **Tier 4: 工作流** | 1hr–8hr+ | Claude Code、Devin、大规模重构 | ~1-2% 🔺增长 |
| **Tier 5: 持久** | 天–无限 | 项目 Agent、定时任务、监控 | ~0.5-1% 🔺增长 |

**关键数据点**：
- ChatGPT.com **平均访问时长** ~7-9 分钟（SimilarWeb, 2024-2025）
- 但**逻辑会话生命周期**可以跨越数天数周（Memory、Projects 功能）
- **自主任务**（Tier 3）是 2024-2026 增长最快的类别

### 4.2 不同任务类型的 TTL 策略

| 任务类型 | Working Memory 策略 | Session Archive 策略 |
|----------|--------------------|---------------------|
| **对话型** (Tier 2) | 空闲 2hr 后释放 | 完整保留，可手动删除 |
| **编程任务** (Tier 4) | 绑定任务生命周期，支持 resume | 完整保留，支持跨设备恢复 |
| **自主 Agent** (Tier 3) | 异步执行，checkpoint 持久化 | 后台执行日志完整保留 |
| **定时任务** (Tier 5) | 周期性初始化，执行后释放 | 按保留策略归档 |

---

## 第五部分：AMS 设计的修正建议

### 5.1 对《00-概要设计》第4章的修订建议

**原文（需修正）**：
```markdown
Working Memory 的访问模式绝大多数是点读/点写 + TTL 驱逐，
数据本质上是短暂的（会话生命周期通常 5 分钟到 2 小时）。
```

**建议修订为**：
```markdown
### 4.2 Working Memory 架构设计

#### 概念定义（基于 CoALA 框架与 Letta 实践）

Working Memory 是 Agent **主动维护的结构化状态**，用于当前任务的执行与推理。
它不同于被动的 Execution Context（由框架组装的 Context Window）。

#### 核心组成

| 组件 | 内容 | 生命周期 | 存储 |
|------|------|----------|------|
| **Task State** | 当前任务元数据（ID、类型、状态、进度） | 任务执行期 | Redis |
| **Scratchpad** | 推理痕迹、中间分析结果、临时笔记 | 任务执行期 | Redis |
| **Core Memory** | 用户画像、Agent 人设、项目上下文 | 跨任务持久 | Redis + 定期同步到 LTM |
| **Active Plan** | 当前计划、子任务队列、依赖关系 | 任务执行期 | Redis |

#### 与相邻层的关系

```
Execution Context (Context Window)
    ↑ 框架从 Working Memory + Archive 组装
Working Memory (Agent 主动状态)
    ↓ 异步写入
Session Archive (完整原始记录)
    ↓ Promotion Pipeline
Long-Term Memory (Episodic/Procedural/Semantic)
```

#### TTL 策略（按任务类型）

1. **对话型会话**
   - Working Memory: 空闲 2hr TTL
   - Session Archive: 永久保留

2. **任务导向型会话**
   - Working Memory: 绑定任务生命周期，支持 resume
   - Session Archive: 永久保留，支持跨设备恢复

3. **自主执行型**
   - Working Memory: Checkpoint 持久化，失败可恢复
   - Session Archive: 完整执行日志
```

### 5.2 核心概念对照表（修正版）

| 概念 | 版本C定义 | 本文修正定义 | 存储位置 |
|------|----------|-------------|----------|
| **Sensory Buffer** | 未明确 | 当前感知输入（单次调用） | 运行时内存 |
| **Execution Context** | 误标为 Working Memory | 被动组装的 Context Window | 运行时内存 |
| **Working Memory** | 执行级热数据 | **Agent 主动维护的结构化状态** | Redis |
| **Session Archive** | ✅ 正确 | 完整原始持久化记录 | Kafka / 文件系统 |
| **Episodic Memory** | 从 Archive 萃取 | ✅ 结构化时间线/事件链 | Neo4j |
| **Procedural Memory** | 从 Archive 萃取 | ✅ 技能/SOP | Tree 或 Graph |
| **Semantic Memory** | 从 Archive 萃取 | ✅ 知识图谱 | Tree + Graph |

---

## 结论

### 本文的核心修正

1. **Working Memory 不应被窄化为 Execution Context**
   - Execution Context = 被动的 Context Window 组装
   - Working Memory = Agent 主动维护的**结构化、可操作、跨步骤持久**的状态

2. **Working Memory 有明确的业界共识定义**
   - CoALA 框架将其列为 Agent 四要素之一
   - Letta 的 Core Memory Blocks 是工程化实现
   - Baddeley 的认知科学原意强调"主动操控"而非"被动存储"

3. **Session Archive 是有价值的独立层级**
   - 版本C的这一洞察是正确的
   - 完整原始记录用于恢复、审计、知识提取

4. **任务时长需要分层描述**
   - "5分钟到2小时"仅适用于 Tier 2 会话型任务
   - 现代 Agent 生态已扩展到 Tier 3-5 的长时/持久任务

### 对 AMS 架构的意义

正确理解 Working Memory 的**主动性**和**结构化**特征，将直接影响：
- API 设计（Agent 如何读写状态）
- 存储选型（Redis 支持高频点写 + 结构化）
- 与 LangGraph 等框架的集成方式
- Skill-DOM 的推荐机制（从 Working Memory 提取 vs 从 Archive 提取）

---

## 参考文献

1. **CoALA**: Sumers et al., "Cognitive Architectures for Language Agents" (2023) — 形式化定义 Working Memory 的论文
2. **MemGPT**: Packer et al., "MemGPT: Towards LLMs as Operating Systems" (2023) — Core Memory 的工程实现
3. **Baddeley (1974, 2000)**: Working Memory 的认知科学源头
4. **LangGraph**: State + Checkpointer 机制 — Graph 作为 Working Memory
5. **SimilarWeb Analytics**: ChatGPT.com 访问时长数据 (2024-2025)

---

*本文是对版本C的修正与扩展，保留其关于 Session Archive 和长期知识分层的正确洞察，纠正对 Working Memory 概念的窄化理解。*
