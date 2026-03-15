---
title: "Agent Memory 综述：发展脉络与引用关系"
date: 2026-03-02T12:00:00+08:00
draft: false
description: "基于 Agent-Memory-Paper-List 的 Agent 记忆领域发展脉络、统一分类与重要引用关系"
categories: ["技术"]
tags: ["AI", "Agent", "Memory", "综述", "论文"]
---

本文整理 [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564) 及其 [论文列表仓库](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) 中的分类框架、发展脉络与主要引用关系。

---

## 1. 统一分类框架（来自 Survey）

Survey 将 **Agent Memory** 与 RAG、Context Engineering 等区分开，用三个维度统一梳理：

| 维度 | 含义 | 典型划分 |
|------|------|----------|
| **Forms（载体）** | 记忆存于何处 | **Token-level**：显式、离散（文本/图/EDU 等）；**Parametric**：隐式、权重（LoRA/编辑/适配器）；**Latent**：隐状态（KV、压缩表示、连续向量） |
| **Functions（功能）** | 记忆为何服务 | **Factual**：事实与知识；**Experiential**：经验、策略与技能；**Working**：当前任务的主动上下文管理 |
| **Dynamics（动态）** | 记忆如何演化 | **Formation**（抽取）→ **Evolution**（巩固/遗忘/更新）→ **Retrieval**（检索与访问策略） |

因此同一篇工作可能同时涉及多种 Forms 或 Functions，列表中按**主要贡献**归类。

---

## 2. 发展脉络（时间线与三条主线）

### 2.1 早期奠基（2022–2023 上半年）

- **记忆与长上下文**：Memorizing Transformers、递归摘要长对话、Memorybank、RET-LLM、SCM 等，把「长时记忆」视为显式存储 + 检索。
- **生成式智能体**：**Generative Agents**（Stanford）提出具身记忆、反思、计划，被大量后续多智能体与记忆架构引用。
- **工具与经验**：**Toolformer** 开启「工具即能力」；**Reflexion** 用语言反馈做反思与策略记忆，影响后来的 ExpeL、Memento、SEAgent 等。

### 2.2 操作系统式与生产化（2023 下半年–2024）

- **MemGPT**：将 LLM 视为“操作系统”，分层内存（主上下文 / 扩展存储）+ 系统调用，成为**事实记忆 + 工作记忆**的典型范式，被 Mem0、Zep、Memoria、A-MEM 等延续或对比。
- **知识图谱与图记忆**：Arigraph、HippoRAG、Graph RAG、Zep（时序知识图）等，把事实记忆从「块检索」推向「图结构」。
- **个性化与长期对话**：MemoChat、AI PERSONA、Human-inspired Episodic Memory、Crafting Personalized Agents 等，强调用户级持久记忆与画像。

### 2.3 分层、多模态与自进化（2025–2026）

- **事实记忆**：EverMemOS、MAGMA、Memoria、O-Mem 等「记忆操作系统」或多图架构；EDU 分解、LightMem、R³Mem 等压缩与结构化。
- **经验记忆**：MemEvolve、Remember Me Refine Me、FLEX、Alita、Memento 等强调**从经验中演化**、过程记忆、技能记忆。
- **工作记忆**：Agentic Memory、MemSearcher、PRIME、ACON、Sculptor 等统一长短时或主动管理上下文；Latent 侧 LM2、MemoRAG、SnapKV、RazorAttention 等做 KV/上下文压缩与检索增强。

---

## 3. 主要引用关系（奠基 → 后续）

以下为列表中较明确的**概念/技术传承**（按“被引/延续”关系整理，非穷举）。

### 3.1 事实记忆 + 长对话/个性化

| 奠基或节点工作 | 后续/相关工作 |
|----------------|----------------|
| **Generative Agents** (2023/04) | 多智能体社会模拟、OASIS、Sophia、Memoria、角色与持久记忆设计 |
| **MemGPT** (2023/10) | Mem0、Zep、Memoria、A-MEM、EverMemOS、分层/操作系统式记忆架构 |
| **MemoChat** (2023/08) | 长期开放域对话、Memolet、SeCom、Reflective Memory Management |
| **递归摘要长对话** (2023/08) | 时间线/层次化记忆、Hierarchical Aggregate Tree、From Isolated to Hierarchical Schemas |
| **HippoRAG** (2024/05) | 神经启发、图/检索式长期记忆、ComoRAG、Nemori |

### 3.2 经验记忆 + 工具/反思

| 奠基或节点工作 | 后续/相关工作 |
|----------------|----------------|
| **Reflexion** (2023/03) | ExpeL、Memento、SEAgent、H²R、Remember Me Refine Me、语言反思与策略记忆 |
| **Toolformer** (2023/02) | ToolLLM、CREATOR、ToolGen、COLT、ToolMem、工具检索与能力记忆 |
| **ExpeL** (2023/08) | Agent KB、FLEX、Scaling Agent Learning、经验合成与示范库 |
| **JARVIS-1** (2023/11) | 多任务、多模态、具身与工作流记忆（Agent Workflow Memory 等） |

### 3.3 工作记忆 + 上下文/压缩

| 奠基或节点工作 | 后续/相关工作 |
|----------------|----------------|
| **Memorizing Transformers** (2022/08) | 外部记忆、Augmenting LMs with Long-Term Memory、Memory³、M+ |
| **Attention Sinks / 流式长上下文** (2024/01) | Lightning Attention、KV 压缩、RazorAttention、SnapKV |
| **In-Context Autoencoder / Gist Tokens** (2023–2024) | Adapting LMs to Compress Contexts、ACON、SoftCoT、上下文压缩与摘要 |

### 3.4 知识编辑与参数化记忆

| 奠基或节点工作 | 后续/相关工作 |
|----------------|----------------|
| **Editing Factual Knowledge in LMs** (2021/04) | Fast Model Editing、WISE、ELDER、AlphaEdit、Neighboring Perturbations |
| **K-Adapter** (2020/02) | 多源知识注入、MemLoRA、Memory Decoder、MLP Memory |

---

## 4. 小结

- **事实记忆**：从「块 + 检索」到「图/时序图/操作系统式」再到「事件/EDU/多图」与可生产系统（Mem0、Zep、Memoria）。
- **经验记忆**：从「反思 + 示范」到「过程记忆、技能库、自进化」与工具能力记忆（ToolMem、LEGOMem）。
- **工作记忆**：从「长上下文 + 摘要」到「主动上下文管理、RL 驱动检索/压缩」与 Latent 侧 KV/全局记忆（LM2、MemoRAG、SnapKV）。

Survey 的 **Forms × Functions × Dynamics** 为上述工作提供了统一术语和归类方式，便于对照与延伸；更细的引用图可结合各论文的 Related Work 与 Citation 进一步补全。

**参考文献**

- [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564)
- [Agent-Memory-Paper-List (GitHub)](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)
