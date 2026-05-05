 基于你文档中已有的资料和搜索结果，我为你整理一份 **Letta "Stateful Agent" 理念** 的完整介绍：

---

## Letta 简介

**Letta**（前身是 **MemGPT**）是一个开源的 AI Agent 框架，于 2024-2025 年从 MemGPT 重新品牌定位。它的核心理念是：**Agent 不应该只是无状态的请求-响应函数，而应该是有持久记忆、能够随时间学习和自我改进的有状态实体**。

---

## 1. Stateful Agent 的核心理念

### 传统 Stateless Agent 的问题
| 问题 | 说明 |
|------|------|
| **上下文截断** | LLM 有限的上下文窗口导致长对话历史被截断 |
| **经验归零** | 每次会话从零开始，无法从历史成功/失败中学习 |
| **知识孤岛** | 没有机制将过去的推理链、工具调用经验沉淀为可复用知识 |

### Letta 的解决方案：Memory as Operating System
Letta 将内存视为**云原生基础设施**而非简单的缓存上下文，实现了一个类似操作系统的内存层级架构：

```
┌─────────────────────────────────────────────────────────┐
│  Core Memory (In-Context)                               │
│  • 用户画像、偏好设置                                     │
│  • 活跃工作记忆（当前会话）                                │
│  • 永久投影到 LLM 上下文窗口                              │
└─────────────┬───────────────────────────────────────────┘
              │ context overflow/compaction (π⁻ operation)
              ▼
┌─────────────────────────────────────────────────────────┐
│  Recall Memory (Out-of-Context)                         │
│  • 对话历史（向量数据库检索）                              │
└─────────────────────────────────────────────────────────┘
              │ recursive summarization
              ▼
┌─────────────────────────────────────────────────────────┐
│  Archival Memory (Long-term)                            │
│  • 压缩后的长期知识                                      │
│  • 以较低分辨率存储                                      │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 三层记忆架构详解

| 层级 | 名称 | 存储位置 | 分辨率 | 用途 |
|------|------|----------|--------|------|
| **L1** | Core Memory | LLM Context Window | 100% | 当前活跃信息（用户数据、偏好） |
| **L2** | Recall Memory | Vector DB | 100% | 近期对话历史，可检索 |
| **L3** | Archival Memory | Vector DB | 压缩后 | 长期积累的历史，递归摘要 |

### π⁻ (Pi-minus) 操作
当上下文窗口填满时，Letta 自动执行 **π⁻ 操作**：
1. 将超出窗口的内容进行递归摘要（recursive summarization）
2. 压缩后存入 Archival Memory
3. 保留关键信息的向量表示以支持后续检索

---

## 3. 2025 年的架构创新

### (1) Context Repositories (MemFS)
Letta 将内存扩展为**基于 git 的版本化存储**：
- 记忆不再只是数据库条目，而是被投影到文件系统中
- 支持版本控制（versioning）、分支、回滚
- Agent 可以通过"computer use"工具操作记忆文件

### (2) Sleep-Time Compute（休眠时计算）
- Agent 在**空闲时期**自动执行背景处理
- 功能包括：反思（reflection）、记忆整合、重新组织知识结构
- 2025 年后这些工作流移至客户端执行，无需用户在线

### (3) Conversations API（2026）
- 单个 Agent 可同时维护**多个并发对话**
- 所有对话共享统一记忆系统
- 支持跨对话记忆检索

---

## 4. 内存管理机制

### Memory Blocks（内存块）
```python
# 伪代码示例
core_memory = {
    "human": "<用户信息、偏好>",  # 限制 20000 字符
    "persona": "<Agent 人设>",     # 限制 20000 字符
    "scratch": "<临时工作区>"      # 可读写
}
```

### 自编辑能力
Agent 可以调用工具修改自己的记忆：
- `memory_replace()` - 替换特定内存块内容
- `memory_insert()` - 插入新记忆
- `memory_search()` - 从 Recall/Archival 检索历史

### Context Budgeting（上下文预算）
- 自动监测 token 使用量
- 接近限制时触发摘要和归档
- 优先保留 Core Memory 中的关键信息

---

## 5. 多 Agent 共享记忆

```python
# 多个 Agent 共享同一块内存
shared_block = client.blocks.create(label="organization", ...)
manager_agent = client.agents.create(..., block_ids=[shared_block.id])
worker_agent = client.agents.create(..., block_ids=[shared_block.id])
```

应用场景：
- 组织架构知识管理
- 多 Agent 协作任务
- 跨会话身份一致性

---

## 6. Letta Code（2025 发布）

**Letta Code** 是一个开源的 Agent 执行框架，特点：
- **模型无关性**：支持 OpenAI、Anthropic、Google 及开源模型
- **Skills Framework**：可组合、可复用的能力模块
- **Dynamic Subagents**：支持 Agent 层级委派和任务分解

---

## 7. 与业界方案的对比

| 维度 | Letta (Stateful) | 传统 Stateless Agent |
|------|------------------|---------------------|
| **记忆持久化** | ✅ 跨会话持久化 | ❌ 每次请求独立 |
| **上下文管理** | ✅ 自动压缩、检索 | ❌ 手动构造 prompt |
| **学习能力** | ✅ 在线学习（通过 context 更新） | ❌ 需要微调/重训练 |
| **可扩展性** | ✅ 基于状态累积 | ❌ 基于请求复制 |
| **记忆分类** | Core/Recall/Archival（3层） | 无显式分类 |

---

## 8. 性能基准

**LoCoMo Benchmark**（长期对话记忆测试）：
- Letta: **74.0%**
- Zep: 72.3%
- Mem0: 66.9%

Letta 证明了**基于文件系统的记忆方法**可以与专门设计的检索系统相媲美，同时保持架构简洁性。

---

## 9. 参考资料

1. **[Stateful Agents: The Missing Link in LLM Intelligence](https://www.letta.com/blog/stateful-agents)** - Letta 官方博客，阐述 stateful agent 理念
2. **[Letta V1: Lessons from ReAct, MemGPT, & Claude Code](https://www.letta.com/blog/letta-v1-agent)** - V1 架构设计理念
3. **[Building Stateful AI Agents: A Deep Dive into Letta](https://agentlist.top/en/articles/build-stateful-agent-with-letta)** - 实战架构分析
4. **[Conversations: Shared Agent Memory](https://www.letta.com/blog/conversations)** - 多对话共享记忆
5. **[Forever stateful: Letta Code](https://tessl.io/blog/forever-stateful-letta-code-bets-on-memory-as-the-missing-layer-in-coding-agents/)** - Letta Code 深度分析
6. **[GitHub - awesome-letta](https://github.com/letta-ai/awesome-letta)** - 社区资源合集

---

## 与你项目的关系

从文档来看，你的 **AMS (Agent Memory Infrastructure)** 已经在参考 Letta 的思想，并做了重要扩展：

| 特性 | Letta | AMS (你的方案) |
|------|-------|----------------|
| 记忆层级 | 3 层 (Core/Recall/Archival) | 4 层 (Working/Procedural/Semantic/Metacognitive) |
| 存储结构 | Vector + KV | **Tree + Graph + Vector + TimeSeries** |
| 技能闭环 | ❌ | ✅ Trace→Memory→Skill→Trace |
| 遗忘机制 | ❌ | ✅ Temporal Decay |
| 遥测采集 | ❌ | ✅ Agent-TES |

如果你想深入对比，建议重点阅读：
- 你文档第 **1.1** 节（与 Letta 的对比定位）
- 第 **14** 节（完整的业界方案对比表）