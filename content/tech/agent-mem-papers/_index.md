---
title: "Agent Memory 论文综述"
date: 2026-03-15T20:30:00+08:00
draft: false
tags: ["AI", "Agent", "Memory", "综述", "论文"]
categories: ["tech"]
description: "基于 Shichun-Liu/Agent-Memory-Paper-List 的 Agent Memory 领域论文总结，涵盖事实记忆、经验记忆和工作记忆三大类别。"
---

## 概述

Agent Memory（智能体记忆）是构建基础模型智能体的核心支柱，支撑着智能体执行长程推理、持续学习和与复杂环境有效交互的能力。本综述基于复旦大学研究团队的 [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) 仓库，系统梳理了这一快速发展领域的研究脉络。

### 与相关概念的区别

Agent Memory 与以下概念存在本质区别：

| 概念                      | 核心特征           | 与 Agent Memory 的区别               |
| ----------------------- | -------------- | -------------------------------- |
| **LLM Memory**          | LLM 自身的参数化知识   | Agent Memory 是显式的外部记忆系统          |
| **RAG**                 | 检索增强生成，基于外部知识库 | RAG 是静态检索，Agent Memory 支持动态更新和演化 |
| **Context Engineering** | 优化输入上下文        | Agent Memory 关注跨会话的长期记忆保持        |
|                         |                |                                  |

### 统一分类框架

该领域研究通过三个维度进行组织：

#### 1. 形式 (Forms) - 记忆载体
- **Token-level**: 显式、离散的自然语言表示
- **Parametric**: 隐式的模型参数权重
- **Latent**: 隐藏状态表征

#### 2. 功能 (Functions) - 记忆用途
- **Factual Memory (事实记忆)**: 存储知识和事实信息
- **Experiential Memory (经验记忆)**: 记录洞察、技能和经验
- **Working Memory (工作记忆)**: 主动上下文管理

#### 3. 动态 (Dynamics) - 记忆演化
- **Formation (形成)**: 信息提取和编码
- **Evolution (演化)**: 巩固与遗忘机制
- **Retrieval (检索)**: 访问策略

---

## 发展脉络

### 第一阶段：基础探索期 (2021-2023)

**核心特征**: 从知识编辑和模型编辑技术起步，逐步探索如何让 LLM 具备长期记忆能力。

**代表性工作**:
- **知识编辑**: `Editing Factual Knowledge in Language Models` (2021) 开启了通过修改模型参数来更新知识的先河
- **记忆架构**: `Memoria` (2023) 提出受人类启发的记忆架构，解决"灾难性遗忘"问题
- **工具使用**: `Toolformer` (2023) 让语言模型自学使用工具，扩展了记忆边界
- **生成式智能体**: `Generative Agents` (2023) 展示了具备完整记忆系统的交互式智能体

**技术路线分化**:
1. **参数化路线**: 通过模型编辑直接修改权重 (如 ELLA, K-Adapter)
2. **非参数化路线**: 外部存储 + 检索 (如 RET-LLM, MemGPT)

### 第二阶段：架构成熟期 (2023-2024)

**核心特征**: 形成完整的记忆系统架构，引入认知科学理论。

**重要进展**:

#### 2.1 多层次记忆架构
- **MemGPT** (2023): 将 LLM 视为操作系统，引入分层存储管理
- **HippoRAG** (2024): 受神经生物学启发的长期记忆模型
- **AriGraph** (2024): 结合知识图谱世界模型与情景记忆

#### 2.2 个性化与角色扮演
- **Character-LLM** (2023): 可训练的角色扮演智能体
- **ChatHaruhi** (2024): 动漫角色复活，展示记忆对个性的塑造
- **AI PERSONA** (2024): 终身个性化 LLM

#### 2.3 经验学习与技能积累
- **ExpeL** (2023): LLM 智能体作为经验学习者
- **Reflexion** (2023): 语言智能体的语言强化学习
- **Buffer of Thoughts** (2024): 思维增强推理

### 第三阶段：系统化与工程化 (2024-2025)

**核心特征**: 从理论研究走向工程实践，出现大量生产级记忆系统。

#### 3.1 自进化智能体
- **SEAgent** (2025): 自进化计算机使用智能体
- **Darwin Godel Machine** (2025): 开放式自我改进智能体进化
- **Alita** (2025): 最小预定义、最大自进化的通用智能体

#### 3.2 强化学习驱动的记忆
- **Memory-R1** (2025): 通过强化学习增强 LLM 智能体的记忆管理能力
- **Mem-α** (2025): 通过强化学习学习记忆构建
- **MemRL** (2026): 基于情景记忆的运行时强化学习

#### 3.3 多智能体记忆系统
- **G-Memory** (2025): 多智能体系统的分层记忆追踪
- **MIRIX** (2025): 面向 LLM 智能体的多智能体记忆系统
- **Intrinsic Memory Agents** (2025): 通过结构化上下文记忆实现异构多智能体系统

#### 3.4 记忆与推理的融合
- **MEM1** (2025): 协同记忆与推理的长程智能体
- **MemAgent** (2025): 基于多对话 RL 的记忆智能体重塑长上下文 LLM
- **PRIME** (2025): 规划与检索集成记忆

---

## 核心趋势分析

### 趋势 1: 从静态存储到动态演化
早期研究将记忆视为静态知识库，最新研究强调记忆的**动态性**:
- 记忆的自动整理与压缩 (如 MOOM, SGMem)
- 基于遗忘曲线的记忆衰减机制
- 记忆的巩固与抽象 (如 Hindsight is 20/20)

### 趋势 2: 从单一模态到多模态融合
- **MemVerse** (2025): 多模态终身学习智能体记忆
- **Video-RAG**: 视觉对齐的检索增强长视频理解
- **MemoryVLA** (2025): 视觉-语言-动作模型中的感知认知记忆

### 趋势 3: 从显式编程到自主学习
- **Agentic Context Engineering** (2025): 自改进语言模型的上下文演化
- **SkillWeaver** (2025): 通过发现和磨练技能实现自改进
- **MemGuide** (2025): 面向目标的意图驱动记忆选择

### 趋势 4: 从孤立记忆到协作记忆
- **Memory Sharing** (2024): LLM 智能体间的记忆共享
- **OASIS** (2024): 百万级智能体的开放社会交互模拟
- **RCR-Router** (2025): 多智能体系统的结构化记忆路由

---

## 论文分类导航

本综述将论文按功能分为三大类：

1. **[事实记忆 (Factual Memory)](./factual-memory)** - 存储和检索知识性信息
2. **[经验记忆 (Experiential Memory)](./experiential-memory)** - 学习和积累技能、洞察
3. **[工作记忆 (Working Memory)](./working-memory)** - 管理和优化上下文

---

## 引用

本综述基于以下资源整理：

> **Memory in the Age of AI Agents: A Survey**  
> Shichun Liu et al., arXiv:2512.13564, 2025  
> [GitHub: Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)

---

*最后更新: 2026年3月15日*
