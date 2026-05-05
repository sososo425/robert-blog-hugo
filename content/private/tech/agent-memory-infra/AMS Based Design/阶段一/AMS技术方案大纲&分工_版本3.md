---
title: AMS 技术方案大纲 & 团队分工（版本3 - 横向快速原型）
date: 2026-03-30
tags:
  - AMS
  - 技术方案
  - 团队分工
  - Agent记忆
  - 快速原型
status: 草稿
---

# AMS 技术方案大纲 & 团队分工（版本3 - 横向快速原型）

> [!info] 文档说明
> **分工模式**: 横向分工（by 数据类型 / 端到端自治）
> **目标周期**: 2-3 周快速原型
> **核心目标**: 验证关键假设，产出可演示的原型，而非完整系统
> **检索层**: 本期暂不实现，后期正式开发时考虑调整为纵向或混合分工

---

## 一、分工模式变更说明

### 1.1 为什么采用横向分工？

| 维度         | 纵向分工（版本2）               | 横向分工（版本3）                  |
| ---------- | ----------------------- | -------------------------- |
| **划分依据**   | 技术层次（ETL/Tree/Graph/检索） | 数据类型（Agent数据/知识文档/会话trace） |
| **团队规模要求** | 适合 8-9 人完整团队            | 适合 6-7 人小团队快速启动            |
| **交付节奏**   | 各层解耦，后期集成               | 各组端到端自治，快速出原型              |
| **本期目标**   | 完整系统                    | **2-3 周快速原型验证**            |

### 1.2 横向分工的核心优势（本期）

1. **端到端自治**：每组对自己的数据类型全链路负责，减少跨组协调成本
2. **快速验证假设**：2-3 周内每组能跑通自己的数据流，验证技术可行性
3. **故障隔离**：一组的问题不影响其他组的原型演示
4. **后期灵活调整**：原型验证后，再决定正式开发采用纵向/混合/维持横向

### 1.3 关键假设与妥协

> [!warning] 本期不解决但需记录的问题
>
> 1. **Tree/Graph 算法重复**：3 个组都要实现各自的 Tree 构建和 Graph 抽取逻辑
> 2. **结构一致性风险**：各组定义的 Block Schema、Graph 边类型可能不统一
> 3. **检索层缺失**：本期不做检索服务，各组自行验证本地检索
>
> **缓解措施**：Phase 1 第一周由 TL 统一输出 `Raw Block Schema v0.1` 和 `Minimal Graph Schema v0.1`，各组遵循。

---

## 二、整体架构与数据流

### 2.1 架构图（对应截图标注）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AMS 横向分工架构（版本3）                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GROUP 1 —— 红色框区域                                                │   │
│  │  【Agent 行为数据端到端】                                              │   │
│  │                                                                       │   │
│  │   Agent Framework ◄──IO──► Redis(Working Memory) ──► Compact        │   │
│  │        │                              │                              │   │
│  │        │ Sidecar-based telemetry       │ context                      │   │
│  │        ▼                              ▼                              │   │
│  │   ┌─────────┐    session    ┌─────────────────┐                    │   │
│  │   │Agent-TES│──────────────►│  Raw Block      │                    │   │
│  │   └─────────┘               │  (Agent traces) │                    │   │
│  │                             └─────────────────┘                    │   │
│  │                                    │                                 │   │
│  │                                    ▼                                 │   │
│  │                           ┌─────────────────┐                       │   │
│  │                           │ Group 1 自建存储 │                       │   │
│  │                           │ (Milvus/LanceDB)│                       │   │
│  │                           └─────────────────┘                       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GROUP 2 —— 蓝线区域                                                  │   │
│  │  【知识库构建(doc+code)端到端】                                        │   │
│  │                                                                       │   │
│  │   Knowledge Repository                                                │   │
│  │   ├── work documents (PDF/MD/Wiki)                                   │   │
│  │   └── source code (Python/Java/...)                                  │   │
│  │           │                                                          │   │
│  │           ▼                                                          │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │  ETL Pipeline (Batch)                       │                   │   │
│  │   │  ├── Doc Parser (PDF/MD/Code)               │                   │   │
│  │   │  ├── Chunker (Semantic/AST-based)           │                   │   │
│  │   │  └── VLM (img/table understanding)          │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  │           │                                                          │   │
│  │           ▼                                                          │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │  Tree Construction                          │                   │   │
│  │   │  ├── 文档: 标题层级 + 语义聚类               │                   │   │
│  │   │  └── 代码: AST-based 层级 (函数/类/模块)     │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  │           │                                                          │   │
│  │           ▼                                                          │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │  Graph Construction (轻量)                  │                   │   │
│  │   │  ├── 从 Block 抽取关键实体 (NER)            │                   │   │
│  │   │  ├── 文档内实体关联 (共现/引用)              │                   │   │
│  │   │  └── 代码 Call Graph / Dependency Graph     │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  │           │                                                          │   │
│  │           ▼                                                          │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │ Group 2 自建存储                            │                   │   │
│  │   │ (Milvus + Neo4j + LanceDB)                  │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  GROUP 3 —— 绿线区域                                                  │   │
│  │  【记忆构建(会话/trace)端到端】                                        │   │
│  │                                                                       │   │
│  │   Agent Framework                                                     │   │
│  │        │                                                              │   │
│  │        │ IO / Session / Traces                                        │   │
│  │        ▼                                                              │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │  Streaming Pipeline                         │                   │   │
│  │   │  ├── Session 归并                          │                   │   │
│  │   │  ├── Trace 结构化                          │                   │   │
│  │   │  └── Raw Block 生成                        │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  │           │                                                          │   │
│  │           ▼                                                          │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │  Knowledge Graph 构建                       │                   │   │
│  │   │  ├── 时序事件抽取 (Temporal Events)         │                   │   │
│  │   │  ├── 实体关系抽取 (Triples)                 │                   │   │
│  │   │  ├── 实体链接与消歧                         │                   │   │
│  │   │  └── Temporal KG (timeline + facts)         │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  │           │                                                          │   │
│  │           ▼                                                          │   │
│  │   ┌─────────────────────────────────────────────┐                   │   │
│  │   │ Group 3 自建存储                            │                   │   │
│  │   │ (Neo4j + Milvus)                            │                   │   │
│  │   └─────────────────────────────────────────────┘                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  TL 统筹（跨组公共事项）                                               │   │
│  │  ├── Raw Block Schema v0.1 定义                                       │   │
│  │  ├── Minimal ID 规范（前缀+ULID）                                     │   │
│  │  ├── 共享推理引擎接入（Ray/SGLang）                                   │   │
│  │  └── 存储选型最终确认（Milvus/Neo4j/LanceDB 版本）                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心概念澄清：图结构构建 vs 知识图谱构建

### 3.1 两者的本质区别

| 维度 | Group 2: 图结构构建 (Doc/Code) | Group 3: 知识图谱构建 (Session/Trace) |
|------|-------------------------------|--------------------------------------|
| **数据来源** | 静态文档、源代码 | 动态会话、Agent执行trace |
| **核心目标** | 文档内关联、代码依赖分析 | 跨会话实体关联、时序推理 |
| **图结构特点** | **局部、静态、结构驱动** | **全局、动态、时序驱动** |
| **典型边类型** | `mentions` `references` `calls` `imports` | `follows` `causes` `uses` `related_to` |
| **时间维度** | ❌ 无 | ✅ Temporal Edge（时序边） |
| **规模预期** | 单个文档/代码库内 | 跨所有会话的全局图谱 |
| **消歧难度** | 低（文档内上下文明确） | 高（跨会话实体指代消解） |

### 3.2 具体示例对比

**Group 2 - 代码图结构（局部）**:
```
文件A.py                    文件B.py
  └── func_foo() ──calls──► └── func_bar()
       │                          │
       └── imports ───────────────┘
```
- 局限在代码库内部
- 边类型：`calls`, `imports`, `defined_in`
- 用于：代码导航、依赖分析

**Group 3 - 知识图谱（全局+时序）**:
```
昨天会话                  今天会话
  └── "用pandas处理CSV"    └── "刚才那个库怎么读Excel"
       │                        │
       ▼                        ▼
  ┌─────────┐              ┌─────────┐
  │pandas   │◄──synonym──►│那个库   │
  └────┬────┘              └────┬────┘
       │                        │
       └──uses──► read_csv ◄────┘
              (Temporal: 昨天 → 今天)
```
- 跨会话关联
- 边类型：`synonym_of` `uses` `temporal_follows`
- 用于：联想式回忆、多跳推理

### 3.3 本期原型的边界

> [!tip] 关键约束
>
> **Group 2 的图构建**：
> - 只做**文档/代码内部的轻量关联**
> - 不做跨文档实体链接（那属于 Group 3 的领域）
> - 不做社区发现（本期简化）
>
> **Group 3 的知识图谱**：
> - 聚焦**时序事件抽取**和**跨会话实体关联**
> - 可以从 Group 2 产出的 Block 中抽取实体，但图谱构建逻辑独立
> - 本期可先用规则/简单 NER，不做复杂消歧

---

## 四、各组详细分工

### Group 1：数据采集 + Working Memory + Context Management

> **对应截图红色框**：Agent-TES → Kafka → Working Memory → Compact

#### 核心职责
端到端负责 **Agent 行为数据**的采集、暂存、压缩和初步结构化。

#### 数据流
```
Agent Framework
    │ IO
    ▼
Redis (Working Memory) ──context──► Compact (上下文压缩)
    │                                   │
    │ session/topic                     │ 压缩后回写
    ▼                                   ▼
Agent-TES ──publish traces──► Kafka ──► Raw Block (Agent traces)
                                    │
                                    ▼
                            Group 1 本地存储 (验证用)
```

#### 关键工作（2-3周原型）

| 优先级 | 工作项 | 说明 | 产出 |
|--------|--------|------|------|
| P0 | Agent-TES Sidecar 接入 | 非侵入式采集 Agent IO | 可运行的 Sidecar |
| P0 | Working Memory Redis 设计 | 会话状态 Schema、TTL 策略 | Redis Schema 文档 |
| P0 | Compact 机制原型 | 上下文压缩策略（滑动窗口/LLM摘要）| 压缩 demo |
| P1 | Trace 结构化 | 将 Agent-TES 数据转为 Raw Block | Block 生成器 |
| P1 | 本地存储验证 | 用 Milvus/LanceDB 存储 Block，验证可检索 | 存储接入代码 |
| P2 | Session Archive | 完整会话持久化 | 可选 |

#### 技术栈
- **采集**: eBPF / Sidecar / Bytecode Instrumentation
- **消息队列**: Kafka
- **Working Memory**: Redis + RedisJSON
- **存储验证**: Milvus / LanceDB（本地单节点）

#### 对外接口
```python
# 供 Agent Framework 调用
POST /wm/{session_id}      # 写入工作记忆
GET  /wm/{session_id}      # 读取工作记忆
POST /wm/{session_id}/compact  # 触发压缩

# 供内部使用
Raw Block Schema (Agent traces)
```

---

### Group 2：知识库构建 (doc + code)

> **对应截图蓝线**：Knowledge Repository → ETL → Tree → Graph → 存储

#### 核心职责
端到端负责 **工作文档**和**源代码**的解析、Tree 构建、轻量 Graph 构建和存储。

#### 数据流
```
Knowledge Repository
├── work documents (PDF/MD/Wiki)
└── source code (Python/Java/...)
        │
        ▼
ETL Pipeline (Batch)
├── Doc Parser ──► Chunker ──► Raw Block
└── Code Parser ──► AST Chunker ──► Raw Block
        │
        ▼
Tree Construction
├── 文档: 标题层级 → Section L1/L2
└── 代码: AST层级 → 函数/类/模块
        │
        ▼
Graph Construction (轻量)
├── 实体抽取 (NER)
├── 文档内关联 (共现)
└── 代码 Call Graph
        │
        ▼
Group 2 本地存储 (Milvus + Neo4j + LanceDB)
```

#### 关键工作（2-3周原型）

| 优先级 | 工作项 | 说明 | 产出 |
|--------|--------|------|------|
| P0 | 文档解析器 | PDF/Markdown 解析、表格/图片提取 | Parser 原型 |
| P0 | 代码解析器 | AST 解析（Python/Java）、代码结构提取 | AST Parser |
| P0 | Tree 构建（文档） | 标题层级 + 语义聚类 | 文档 Tree |
| P0 | Tree 构建（代码） | AST-based 层级 | 代码 Tree |
| P1 | Block 摘要生成 | LLM 生成 Block summary | Summary pipeline |
| P1 | 轻量 Graph 构建 | 文档内实体关联、代码 Call Graph | Graph 构建器 |
| P2 | 增量更新机制 | 文档变更时的局部更新 | 可选 |

#### 技术栈
- **解析**: PyMuPDF, Unstructured, tree-sitter
- **Tree**: 自研（标题/AST 解析 + 摘要聚合）
- **Graph**: spaCy NER + 规则关联
- **存储**: Milvus (向量) + Neo4j (图) + LanceDB (元数据)

#### 关键设计决策
```
文档 Tree vs 代码 Tree 的差异：

文档 Tree:
  Section L2 (主题)
    └── Section L1 (子主题)
        └── Block (段落)
  分层依据：标题层级 + 语义聚类

代码 Tree:
  Module (文件)
    └── Class / Function
        └── Block (代码段)
  分层依据：AST 结构（函数/类/模块边界）
```

#### 对外接口
```python
# 批量导入知识库
POST /kb/doc/import          # 导入文档
POST /kb/code/import         # 导入代码仓库

# 查询（本期内部验证用）
GET  /kb/tree/{doc_id}       # 获取文档 Tree 结构
GET  /kb/graph/{entity}      # 获取实体关联（文档内）
```

---

### Group 3：记忆构建 (会话/trace)

> **对应截图绿线**：Session/Trace → Streaming → Raw Block → Knowledge Graph

#### 核心职责
端到端负责从 **用户会话**和**Agent trace** 中抽取结构化记忆，构建**时序知识图谱**。

#### 数据流
```
Agent Framework
    │
    ├── IO / Session ──┐
    │                  │
    └── Trace ─────────┼──► Streaming Pipeline
                       │    ├── Session 归并
                       │    ├── Trace 结构化
                       │    └── Raw Block 生成
                       │
                       ▼
               Knowledge Graph 构建
               ├── 时序事件抽取 (Temporal Events)
               ├── 实体关系抽取 (Triples: subject-relation-object)
               ├── 实体链接与消歧 (Entity Linking)
               └── Temporal KG (timeline + facts + insights)
                       │
                       ▼
               Group 3 本地存储 (Neo4j + Milvus)
```

#### 关键工作（2-3周原型）

| 优先级 | 工作项 | 说明 | 产出 |
|--------|--------|------|------|
| P0 | Session 归并 | 多轮对话归并为连续会话 | Session 归并器 |
| P0 | Trace 结构化 | Agent-TES trace → Raw Block | Trace parser |
| P0 | 实体抽取 (NER) | 从会话中抽取关键实体 | NER pipeline |
| P0 | Triple 抽取 | 实体关系抽取 | Triple 抽取器 |
| P1 | 实体链接 | 跨会话同一实体识别 | 简单消歧规则 |
| P1 | Temporal KG | 时序边构建 (`follows`, `caused_by`) | 时序图谱 |
| P2 | 遗忘机制 | 时序衰减、过期标记 | 可选 |

#### 技术栈
- **流处理**: Kafka + Ray Streaming
- **NER**: spaCy / HanLP / 轻量 LLM
- **关系抽取**: 规则 + LLM prompt
- **图谱**: Neo4j (时序图谱) + Milvus (实体向量)

#### 与 Group 2 的协作边界
```
Group 2 产出: Raw Block (from doc/code)
Group 3 可以: 从 Group 2 的 Block 中抽取实体，纳入全局知识图谱

但 Group 3 不依赖 Group 2：
- Group 3 主要从 Session/Trace 构建图谱
- 可以独立运行，验证时序知识图谱的构建能力
```

#### 对外接口
```python
# 记忆构建接口（内部使用）
POST /memory/session/{id}    # 写入会话数据
POST /memory/trace           # 写入 Agent trace

# 查询（本期内部验证用）
GET  /kg/entity/{name}       # 查询实体时序信息
GET  /kg/timeline            # 获取时间线视图
```

---

## 五、TL 统筹事项（跨组公共层）

### 5.1 本周必须输出（Week 1）

| 交付物 | 内容 | 作用 |
|--------|------|------|
| **Raw Block Schema v0.1** | Block 标准字段定义 | 确保3个组的 Block 结构一致，后期可合并 |
| **Minimal ID 规范** | `{prefix}_{tenant}_{ulid}` | 跨组 ID 可追溯 |
| **共享推理引擎接入指南** | Ray/SGLang 环境配置 | 各组复用推理能力 |
| **存储选型确认** | Milvus/Neo4j/LanceDB 版本 | 避免各组版本不一致 |

### 5.2 Raw Block Schema v0.1（建议）

```json
{
  "block_id": "blk_acmecorp_01hq4j5m...",
  "tenant_id": "acmecorp",
  "source_type": "agent_trace" | "document" | "code" | "session",
  "content": "文本内容（<4KB）",
  "content_oss_key": null | "oss://...",
  "metadata": {
    "title": "可选标题",
    "timestamp": 1711536000,
    "source_uri": "来源标识"
  },
  "embedding": [1536维向量],
  "triples": [
    {"subject": "s", "relation": "r", "object": "o"}
  ]
}
```

### 5.3 原型验证标准（2-3周后）

| 组 | 验证标准 |
|----|---------|
| Group 1 | 能采集 Agent-TES 数据 → 存入 Working Memory → Compact 压缩 → 输出 Raw Block → 本地可检索 |
| Group 2 | 能导入文档/代码 → 构建 Tree → 轻量 Graph → 本地可检索 Tree 结构和实体关联 |
| Group 3 | 能接收 Session/Trace → 抽取实体关系 → 构建 Temporal KG → 本地可查询时序路径 |

---

## 六、排期建议（2-3周快速原型）

### Week 1：基础对齐

| 组 | 任务 |
|----|------|
| TL | 输出 Raw Block Schema、ID 规范、共享环境配置 |
| Group 1 | Agent-TES Sidecar 环境搭建、Redis 设计 |
| Group 2 | 文档/代码解析器调研、Tree 构建方案设计 |
| Group 3 | Streaming Pipeline 搭建、NER 方案调研 |

### Week 2：核心开发

| 组 | 任务 |
|----|------|
| Group 1 | Working Memory 实现、Compact 机制、Trace 结构化 |
| Group 2 | Parser 实现、Tree 构建、Block 摘要 |
| Group 3 | Session 归并、实体抽取、Triple 抽取 |

### Week 3：集成验证

| 组 | 任务 |
|----|------|
| Group 1 | 端到端联调、本地存储验证、演示准备 |
| Group 2 | Tree/Graph 存储验证、演示准备 |
| Group 3 | Knowledge Graph 存储验证、演示准备 |
| ALL | 原型演示、问题复盘、正式开发分工决策 |

---

## 七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 各组 Block Schema 不一致 | 后期无法合并 | TL Week 1 输出强制 Schema v0.1 |
| 人手不足（每组2人） | 进度延迟 | 聚焦核心路径，非核心功能延后 |
| 存储选型争议 | 各组实现差异大 | TL 第一周确认统一版本 |
| Group 2/3 Graph 逻辑重复 | 代码重复 | 本期接受重复，正式开发时抽象公共库 |
| 检索层缺失验证不完整 | 无法验证端到端 | 各组自行实现本地简单检索验证 |

---

## 八、原型后决策点

2-3 周原型完成后，需决策正式开发的分工模式：

```
决策选项：
A. 维持横向（by 数据类型）
   - 适合：各组数据类型差异大，需要持续自治迭代

B. 转为纵向（by 技术层次）
   - 适合：Tree/Graph 算法可复用，需要统一优化

C. 混合模式（推荐）
   - Group 1 维持横向（Agent 数据端到端）
   - Group 2/3 合并为 Tree/Graph 公共层（纵向）
   - 新增 Group 4 检索服务（纵向）
```

---

## 附录：人员配置

```
Tech Lead（1人，跨组统筹）
├── Group 1: 数据采集 + WM + Compact    3人    王宇+景峰+文纬
├── Group 2: 知识库构建(doc+code)      3人    郑棋+杰宁+赵龙
└── Group 3: 记忆构建(session/trace)   3人    露阳+吕鑫+彬彬

```

---

*本文档为快速原型阶段的分工方案，正式开发阶段可能根据原型验证结果调整。*
