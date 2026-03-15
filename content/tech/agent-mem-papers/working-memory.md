---
title: "Agent Memory: 工作记忆 (Working Memory)"
date: 2026-03-15T20:30:00+08:00
draft: false
tags: ["AI", "Agent", "Working Memory", "上下文管理", "长上下文"]
categories: ["tech"]
description: "Agent Memory 中工作记忆相关论文总结，涵盖上下文压缩、注意力机制和 KV Cache 优化等方向。"
---

## 概述

**工作记忆 (Working Memory)** 对应认知心理学中的**短期记忆**概念，负责：

- **主动上下文管理**: 维护当前任务相关的信息
- **注意力调控**: 决定关注哪些信息
- **信息整合**: 结合短期和长期记忆进行推理
- **认知负荷管理**: 处理有限容量的注意力资源

**与长期记忆的区别**:
- 工作记忆: 容量有限 (受上下文长度限制)，访问快速，临时存储
- 长期记忆: 容量几乎无限，访问需要检索，持久存储

---

## Token-level 工作记忆

**核心思想**: 通过文本压缩和选择管理上下文。

### 代表性论文

#### 1. Agent S (2024)
- **论文**: *Agent S: An Open Agentic Framework That Uses Computers Like a Human*
- **链接**: [arXiv:2410.08164](https://arxiv.org/abs/2410.08164)
- **核心思想**:
  - 模拟人类使用计算机的认知过程
  - **分层工作记忆**: 视觉记忆 + 动作记忆 + 语义记忆
  - 动态切换注意力焦点
- **意义**: 人类认知架构在智能体设计中的应用

#### 2. AgentFold (2025)
- **论文**: *AgentFold: Long-Horizon Web Agents with Proactive Context Management*
- **链接**: [arXiv:2510.24699](https://arxiv.org/abs/2510.24699)
- **核心思想**:
  - **主动上下文管理**: 预测未来需要的信息
  - 折叠 (Fold) 和展开 (Unfold) 上下文细节
  - 根据任务进度动态调整上下文粒度
- **意义**: 长程任务中的上下文生命周期管理

#### 3. MemSearcher (2025)
- **论文**: *MemSearcher: Training LLMs to Reason, Search and Manage Memory*
- **链接**: [arXiv:2511.02805](https://arxiv.org/abs/2511.02805)
- **核心思想**:
  - 端到端强化学习训练记忆管理
  - 智能体学习何时搜索、保留或丢弃信息
  - 统一推理和记忆管理
- **意义**: 强化学习驱动的主动记忆策略

#### 4. ACON (2025)
- **论文**: *ACON: Optimizing Context Compression for Long-Horizon LLM Agents*
- **链接**: [arXiv:2510.00615](https://arxiv.org/abs/2510.00615)
- **核心思想**:
  - 面向长程任务的上下文压缩优化
  - 保持任务关键信息的同时压缩冗余
  - 可学习的压缩策略
- **意义**: 智能体场景的上下文压缩专用方法

#### 5. PRIME (2025)
- **论文**: *PRIME: Planning and Retrieval-Integrated Memory for Enhanced Reasoning*
- **链接**: [arXiv:2509.22315](https://arxiv.org/abs/2509.22315)
- **核心思想**:
  - 规划与检索集成的工作记忆
  - 根据计划动态组织记忆
  - 支持复杂多步推理
- **意义**: 工作记忆与规划的深度耦合

#### 6. ReSum (2025)
- **论文**: *ReSum: Unlocking Long-Horizon Search Intelligence via Context Summarization*
- **链接**: [arXiv:2509.13313](https://arxiv.org/abs/2509.13313)
- **核心思想**:
  - 通过上下文摘要解锁长程搜索智能
  - 累积式摘要保持历史信息
  - 层次化摘要结构
- **意义**: 摘要技术在工作记忆中的应用

#### 7. Agentic Memory (2026)
- **论文**: *Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management*
- **链接**: [arXiv:2601.01885](https://arxiv.org/abs/2601.01885)
- **核心思想**:
  - 统一的长短期记忆管理
  - 端到端学习记忆操作
  - 无缝切换工作记忆和长期记忆
- **意义**: 统一记忆架构的里程碑

#### 8. Memory as Action (2025)
- **论文**: *Memory as Action: Autonomous Context Curation for Long-Horizon Agentic Tasks*
- **链接**: [arXiv:2510.12635](https://arxiv.org/abs/2510.12635)
- **核心思想**:
  - 将记忆管理视为**动作**序列
  - 自主策划上下文内容
  - 学习最优的上下文组织策略
- **意义**: 记忆管理动作化的创新视角

---

## Parametric 工作记忆

**核心思想**: 通过架构设计或参数调整优化上下文处理能力。

### 代表性论文

#### 1. Attention Sinks (2024)
- **论文**: *Efficient Streaming Language Models with Attention Sinks*
- **链接**: [ICLR 2024](https://openreview.net/forum?id=NG7sS51zVF)
- **核心思想**:
  - **注意力汇聚点 (Attention Sinks)**: 保留初始的几个 token
  - 解决 KV Cache 驱逐导致的性能下降
  - 实现流式语言模型的高效推理
- **关键发现**:
  - 初始 token 对注意力计算至关重要
  - 保留这些 token 可维持模型稳定性
- **意义**: KV Cache 管理的突破性工作

#### 2. Lightning Attention (2024)
- **论文**: *Various Lengths, Constant Speed: Efficient Language Modeling with Lightning Attention*
- **链接**: [OpenReview](https://openreview.net/forum?id=5wm6TiUP4X)
- **核心思想**:
  - 线性注意力机制
  - 与序列长度无关的恒定计算速度
  - 支持无限长上下文
- **意义**: 突破二次复杂度的注意力瓶颈

---

## Latent 工作记忆

**核心思想**: 在潜在空间中高效表示和操作上下文信息。

### 代表性论文

#### 1. SnapKV (2024)
- **论文**: *SnapKV: LLM Knows What You are Looking for Before Generation*
- **链接**: [NeurIPS 2024](https://papers.nips.cc/paper_files/paper/2024/hash/28ab418242603e0f7323e54185d19bde-Abstract-Conference.html)
- **核心思想**:
  - LLM 在生成前就知道需要关注什么
  - **提前聚类**: 在预填充阶段识别关键 KV
  - 仅保留关键 KV，压缩缓存
- **技术细节**:
  - 观察注意力模式识别重要 token
  - 基于观察结果压缩 KV Cache
- **意义**: 观察驱动的 KV Cache 压缩

#### 2. RazorAttention (2025)
- **论文**: *RazorAttention: Efficient KV Cache Compression Through Retrieval Heads*
- **链接**: [OpenReview](https://openreview.net/forum?id=tkiZQlL04w)
- **核心思想**:
  - 通过**检索头**压缩 KV Cache
  - 识别负责信息检索的注意力头
  - 仅在这些头上保留完整 KV
- **意义**: 注意力头级别的细粒度压缩

#### 3. MemoRAG (2025)
- **论文**: *MemoRAG: Boosting Long Context Processing with Global Memory-Enhanced Retrieval Augmentation*
- **链接**: [arXiv:2504.09181](https://arxiv.org/abs/2504.09181)
- **核心思想**:
  - 全局记忆增强的检索增强生成
  - 双路径处理: 全局记忆编码 + 局部检索
  - 潜在空间中的记忆融合
- **意义**: RAG 与工作记忆的融合

#### 4. LM2 (2025)
- **论文**: *LM2: Large Memory Models*
- **链接**: [arXiv:2502.06049](https://arxiv.org/abs/2502.06049)
- **核心思想**:
  - 大记忆模型架构
  - 显式可学习的记忆模块
  - 注意力与记忆的深度集成
- **意义**: 原生支持记忆的模型架构

#### 5. MEM1 (2025)
- **论文**: *MEM1: Learning to Synergize Memory and Reasoning for Efficient Long-Horizon Agents*
- **链接**: [arXiv:2506.15841](https://arxiv.org/abs/2506.15841)
- **核心思想**:
  - 协同记忆与推理
  - 学习最优的记忆-推理权衡
  - 高效的长程任务处理
- **意义**: 记忆与推理的协同优化

#### 6. VisMem (2025)
- **论文**: *VisMem: Latent Vision Memory Unlocks Potential of Vision-Language Models*
- **链接**: [arXiv:2511.11007](https://arxiv.org/abs/2511.11007)
- **核心思想**:
  - 面向视觉语言模型的潜在视觉记忆
  - 压缩视觉信息到潜在表示
  - 支持长视频理解
- **意义**: 多模态工作记忆的扩展

#### 7. MemoryVLA (2025)
- **论文**: *MemoryVLA: Perceptual-Cognitive Memory in Vision-Language-Action Models*
- **链接**: [arXiv:2508.19236](https://arxiv.org/abs/2508.19236)
- **核心思想**:
  - 视觉-语言-动作模型中的感知认知记忆
  - 结合感知记忆和认知记忆
  - 支持机器人操作的长程记忆
- **意义**: 具身智能中的工作记忆

#### 8. MemGen (2025)
- **论文**: *MemGen: Weaving Generative Latent Memory for Self-Evolving Agents*
- **链接**: [arXiv:2509.24704](https://arxiv.org/abs/2509.24704)
- **核心思想**:
  - 生成式潜在记忆
  - 记忆不仅存储还生成信息
  - 支持自进化智能体
- **意义**: 生成式记忆的探索

---

## 技术演进脉络

### 上下文压缩方向

```
2023: 简单截断 / 滑动窗口
    ↓
2024: SnapKV (观察驱动) → Attention Sinks (汇聚点保留)
    ↓
2025: RazorAttention (检索头) → ACON (智能体专用压缩)
    ↓
2026: Agentic Memory (端到端学习)
```

### 记忆-推理融合方向

```
2024: Agent S (认知架构)
    ↓
2025: PRIME (规划集成) → MEM1 (协同优化) → MemSearcher (RL驱动)
    ↓
2026: Memory as Action (记忆动作化)
```

---

## 关键技术对比

| 技术 | 压缩目标 | 压缩时机 | 信息损失 | 适用场景 |
|------|----------|----------|----------|----------|
| SnapKV | KV Cache | 预填充 | 低 | 通用长上下文 |
| RazorAttention | KV Cache | 推理时 | 中 | 注意力稀疏场景 |
| Attention Sinks | KV Cache | 流式处理 | 低 | 流式生成 |
| ACON | 文本上下文 | 任务执行 | 可控 | 智能体任务 |
| MemoRAG | 检索结果 | 检索后 | 低 | RAG 系统 |

---

## 认知科学视角

工作记忆的研究深受认知科学影响：

### Baddeley 工作记忆模型在 AI 中的映射

| 认知组件 | 人类功能 | AI 对应 | 代表工作 |
|----------|----------|---------|----------|
| **语音环路** | 保持语言信息 | 上下文缓存 | SnapKV, Attention Sinks |
| **视觉空间画板** | 保持视觉信息 | 视觉记忆 | VisMem, MemoryVLA |
| **情景缓冲器** | 整合多模态信息 | 多模态融合 | MemoRAG, MemGen |
| **中央执行系统** | 注意力控制 | 记忆管理策略 | MemSearcher, Memory as Action |

---

## 应用场景

### 1. 长文档处理
- **挑战**: 超过上下文长度的文档
- **方案**: SnapKV + MemoRAG 组合
- **效果**: 高效处理百页级文档

### 2. 多轮对话
- **挑战**: 保持对话连贯性
- **方案**: AgentFold + ReSum
- **效果**: 支持数十轮连续对话

### 3. 长程任务执行
- **挑战**: 复杂任务的信息管理
- **方案**: Agentic Memory + MEM1
- **效果**: 支持数百步的任务执行

### 4. 实时流处理
- **挑战**: 流式数据的高效处理
- **方案**: Attention Sinks + Lightning Attention
- **效果**: 实时处理无限长流

---

## 推荐阅读顺序

1. **入门**: Attention Sinks → SnapKV → AgentFold
2. **进阶**: MemSearcher → PRIME → MEM1
3. **前沿**: Agentic Memory → Memory as Action → MemGen

---

*[返回总览](../)*
