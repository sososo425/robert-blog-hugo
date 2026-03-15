---
title: "Agent Memory 论文列表与综述"
description: "基于 Memory in the Age of AI Agents: A Survey 的论文分类整理、核心思想与发展脉络"
---

本目录整理自 [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)（对应综述论文 [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564)），按**功能分类**（事实记忆、经验记忆、工作记忆）与**载体形式**（Token-level / Parametric / Latent）对论文进行归纳，并提炼核心思想、引用关系与发展脉络。

## 文档索引

| 文档 | 内容 |
|------|------|
| [综述：发展脉络与引用关系](/tech/agent-mem-papers/overview/) | 统一分类框架、时间线、奠基工作与引用关系 |
| [事实记忆 (Factual Memory)](/tech/agent-mem-papers/factual-memory/) | 知识型记忆：Token / Parametric / Latent |
| [经验记忆 (Experiential Memory)](/tech/agent-mem-papers/experiential-memory/) | 经验与技能型记忆 |
| [工作记忆 (Working Memory)](/tech/agent-mem-papers/working-memory/) | 主动上下文与上下文管理 |

## 分类框架速览

- **Forms（载体）**：Token-level（显式离散）、Parametric（模型参数）、Latent（隐状态/KV 等）
- **Functions（功能）**：Factual（知识）、Experiential（洞察与技能）、Working（当前任务上下文）
- **Dynamics（动态）**：Formation（抽取）→ Evolution（巩固/遗忘）→ Retrieval（检索）
