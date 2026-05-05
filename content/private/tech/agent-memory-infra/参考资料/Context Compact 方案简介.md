基于你正在设计的 Agent Memory System，**Context Compact（上下文压缩）** 正是 Working Memory 和长期记忆之间的关键桥梁。以下是业界的常用方案和设计思路：

---

## 1. 业界主流 Context Compact 方案

### 1.1 分层记忆架构（Hierarchical Memory）

| 方案 | 核心思想 | 代表实现 |
|------|---------|---------|
| **Letta/MemGPT 三层模型** | Core + Archival + Recall Memory | [Letta](https://www.letta.com/) |
| **Summarization Chain** | 递归摘要， older messages 压缩为 summary | LangChain ConversationSummaryBufferMemory |
| **滑动窗口 + 摘要** | 保留 recent N 条，older 部分做 rolling summary | OpenAI ChatGPT, Claude |

**Letta 的设计**（你的文档中也引用了）：
```
Core Memory (固定大小)
    ↓ 溢出时
Archival Memory (向量存储)
    ↓ 检索时
Recall Memory (动态加载到 Core)
```

### 1.2 语义压缩（Semantic Compression）

| 技术 | 原理 | 效果 |
|------|------|------|
| **LLM-based Summarization** | 用 LLM 将多轮对话压缩为关键信息 | 10:1 ~ 20:1 压缩比 |
| **Extractive Compression** | 提取关键句子/实体，丢弃冗余 | 更快但可能丢失语义 |
| **Embedding-based Deduplication** | 语义相似度去重，合并重复信息 | 减少冗余 token |

### 1.3 结构化压缩（Structured Compact）

```
原始对话 (1000 tokens)
    ↓
结构化提取:
  - Facts: [关键事实列表]
  - Entities: [实体关系]
  - Intent: [用户意图]
  - Action History: [工具调用链]
    ↓
压缩后 (200 tokens)
```

---

## 2. Context Compact 的一般设计原则

### 2.1 双轨压缩策略

```python
# 伪代码示意
class ContextCompressor:
    def compact(self, context_window: Context) -> CompactContext:
        # 1. 近期上下文：保留原始形式（无损）
        recent = context_window.last_n_turns(n=5)
        
        # 2. 中期上下文：语义摘要（有损压缩）
        middle = self.summarize(context_window.middle_range())
        
        # 3. 远期上下文：结构化为记忆（提取关键信息）
        distant = self.extract_facts(context_window.older_range())
        
        return CompactContext(recent, middle, distant)
```

### 2.2 你的 AMS 中的 Context Compact 设计

基于你的文档，建议在 **Working Memory → Declarative Memory** 的提升管道中增加 Context Compact 层：

```
┌─────────────────────────────────────────────┐
│           Working Memory (Redis)            │
│  - 原始对话 (raw_messages)                   │
│  - 任务状态 (task_state)                     │
└──────────────────┬──────────────────────────┘
                   │ Session Promotion Pipeline
                   ▼
┌─────────────────────────────────────────────┐
│        Context Compact Layer               │
│  ┌─────────────────────────────────────┐    │
│  │  ① Summarization (LLM-based)        │    │
│  │  ② Fact Extraction (Triple Extraction)│  │
│  │  ③ Semantic Deduplication           │    │
│  └─────────────────────────────────────┘    │
└──────────────────┬──────────────────────────┘
                   ▼
┌─────────────────────────────────────────────┐
│        Declarative Memory (Tree+Graph)      │
│  - Tree: 层级化摘要 (Section L1/L2)          │
│  - Graph: 实体关系 (Phrase Node + Edge)      │
└─────────────────────────────────────────────┘
```

### 2.3 关键设计决策建议

| 决策点 | 推荐方案 | 理由 |
|--------|---------|------|
| **何时触发压缩** | 会话结束 + 阈值触发（token 数 > 70% 窗口） | 避免频繁压缩的开销 |
| **压缩粒度** | Block 级别（对应你的 Tree 结构中的 Block） | 与现有架构对齐 |
| **压缩比控制** | 原始 : 压缩后 = 5:1 ~ 10:1 | 平衡信息量与 token 效率 |
| **增量 vs 全量** | 增量压缩（只处理新内容） | 减少重复计算 |

---

## 3. 具体实现建议

### 3.1 在现有 AMS 架构中的位置

建议在第 4 章 **Working Memory** 和第 5 章 **Declarative Memory** 之间增加 **4.5 Context Compact Pipeline**：

```yaml
# 新增配置
context_compact:
  trigger:
    - session_end          # 会话结束时
    - token_threshold: 0.7  # token 达到阈值时
    - manual_trigger       # 手动触发
  
  strategies:
    - name: "conversation_summary"
      type: llm_summarization
      model: "gpt-4o-mini"  # 轻量级模型处理压缩
      max_output_tokens: 500
      
    - name: "fact_extraction"
      type: triple_extraction  # 提取 SPO 三元组
      target: declarative_memory.graph
      
    - name: "task_pattern_extraction"
      type: procedural_extraction
      target: procedural_memory
```

### 3.2 与现有 Tree + Graph 双轨模型的结合

```
原始上下文 (Raw Messages)
    │
    ├──→ Tree Construction ──→ Section L1 (摘要文本)
    │                            └── Embedding
    │
    └──→ Graph Construction ──→ Phrase Node (实体)
                                 └── Relation Edge (关系)
```

---

## 4. 业界参考实现

| 项目 | GitHub | 核心特点 |
|------|--------|---------|
| **MemGPT** | letta-ai/letta | 分层记忆管理，自动溢出处理 |
| **LangChain Compressors** | langchain-ai/langchain | 多种 ContextualCompressionRetriever |
| **RAGFlow** | infiniflow/ragflow | 文档级别的智能分块与压缩 |
| **LlamaIndex** | run-llama/llama_index | ChatMemoryBuffer 自动摘要 |

---

**总结**：Context Compact 的核心是**分层有损压缩**——近期保真、中期摘要、远期结构化。在你的 AMS 架构中，这正是 Working Memory 向 Declarative/Procedural Memory 提升的关键环节，与你现有的 Tree + Graph 双轨存储天然契合。