---
title: "事实记忆 (Factual Memory) 论文核心思想"
date: 2026-03-02T12:00:00+08:00
draft: false
description: "Agent 事实/知识型记忆：Token-level、Parametric、Latent 三类载体的论文归纳与核心思想"
categories: ["技术"]
tags: ["AI", "Agent", "Memory", "Factual Memory", "论文"]
---

本文归纳 [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) 中 **Factual Memory** 类别下的论文核心思想，按载体分为 **Token-level**、**Parametric**、**Latent** 三节。事实记忆主要承载**知识、事实与用户画像**，支持长期个性化与检索增强。

---

## 1. Token-level 事实记忆

显式、离散存储（文本块、图、EDU、知识库等），通过检索或图遍历参与推理。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2026/01 | Memory Matters More: Event-Centric Memory as a Logic Map | 以事件为中心的逻辑图记忆，支撑 Agent 搜索与推理 | [paper](https://www.arxiv.org/abs/2601.04726) |
| 2026/01 | MAGMA: Multi-Graph based Agentic Memory Architecture | 多图结构的 Agent 记忆架构，融合多种图表示 | [paper](https://arxiv.org/abs/2601.03236) |
| 2026/01 | EverMemOS: Self-Organizing Memory Operating System | 自组织记忆操作系统，面向结构化长程推理 | [paper](https://www.arxiv.org/abs/2601.02163) |
| 2025/12 | From Context to EDUs: Faithful Context Compression via EDU Decomposition | 用基本语篇单元(EDU)分解做忠实、结构化上下文压缩 | [paper](https://arxiv.org/abs/2512.14244) |
| 2025/12 | MemVerse: Multimodal Memory for Lifelong Learning Agents | 多模态记忆，支持终身学习智能体 | [paper](https://arxiv.org/abs/2512.03627) |
| 2025/12 | MMAG: Mixed Memory-Augmented Generation | 混合记忆增强生成，用于 LLM 应用 | [paper](https://arxiv.org/abs/2512.01710) |
| 2025/12 | Sophia: A Persistent Agent Framework of Artificial Life | 持久化智能体框架，人工生命式长期状态 | [paper](https://arxiv.org/abs/2512.18202) |
| 2025/12 | WorldMM: Dynamic Multimodal Memory Agent for Long Video | 长视频推理的动态多模态记忆 Agent | [paper](https://arxiv.org/abs/2512.02425) |
| 2025/12 | Memoria: A Scalable Agentic Memory Framework for Personalized Conversational AI | 可扩展的 Agent 记忆框架，面向个性化对话 | [paper](https://arxiv.org/abs/2512.12686) |
| 2025/12 | Hindsight is 20/20: Agent Memory that Retains, Recalls, and Reflects | 记忆的保留、召回与反思三者统一设计 | [paper](https://arxiv.org/abs/2512.12818) |
| 2025/11 | A Simple Yet Strong Baseline for Long-Term Conversational Memory | 长期对话记忆的简单强基线 | [paper](https://arxiv.org/abs/2511.17208) |
| 2025/11 | General Agentic Memory Via Deep Research | 通过深度研究构建通用 Agent 记忆 | [paper](https://arxiv.org/abs/2511.18423) |
| 2025/11 | O-Mem: Omni Memory for Personalized, Long Horizon, Self-Evolving Agents | 全场景记忆系统，支持个性化、长程与自进化 | [paper](https://arxiv.org/abs/2511.13593) |
| 2025/11 | RCR-Router: Role-Aware Context Routing with Structured Memory | 多 Agent 系统中基于角色的结构化记忆与上下文路由 | [paper](https://doi.org/10.48550/arXiv.2508.04903) |
| 2025/11 | Persistent Memory and User Profiles for Personalized Long-term Interactions | 持久记忆与用户画像实现长期个性化交互 | [paper](https://doi.org/10.48550/arXiv.2510.07925) |
| 2025/10 | Livia: Emotion-Aware AR Companion with Progressive Memory Compression | 模块化 Agent + 渐进式记忆压缩的情绪感知 AR 伴侣 | [paper](https://doi.org/10.48550/arXiv.2509.05298) |
| 2025/10 | D-SMART: Dynamic Structured Memory And Reasoning Tree | 动态结构化记忆与推理树，提升对话一致性 | [paper](https://arxiv.org/abs/2510.13363) |
| 2025/10 | WebWeaver: Web-Scale Evidence with Dynamic Outlines for Deep Research | 开放域深度研究中用动态大纲组织网络规模证据 | [paper](https://doi.org/10.48550/arXiv.2509.13312) |
| 2025/10 | CAM: Constructivist Agentic Memory for LLM Reading Comprehension | 建构主义视角下的 Agent 记忆，用于阅读理解 | [paper](https://doi.org/10.48550/arXiv.2510.05520) |
| 2025/10 | Pre-Storage Reasoning for Episodic Memory | 将推理前置于存储，减轻推理负担以支持个性化对话 | [paper](https://doi.org/10.48550/arXiv.2509.10852) |
| 2025/10 | LightMem: Lightweight Memory-Augmented Generation | 轻量高效的记忆增强生成 | [paper](https://arxiv.org/abs/2510.18866) |
| 2025/10 | RGMem: Renormalization Group-based Memory Evolution for User Profile | 用重归一化群思想做用户画像的记忆演化 | [paper](https://arxiv.org/abs/2510.16392) |
| 2025/09 | Mem-α: Learning Memory Construction via RL | 用强化学习学习记忆构建策略 | [paper](https://doi.org/10.48550/arXiv.2509.25911) |
| 2025/09 | SGMem: Sentence Graph Memory for Long-Term Conversational Agents | 句子图记忆，支撑长期对话 Agent | [paper](https://arxiv.org/abs/2509.21212) |
| 2025/09 | Nemori: Self-Organizing Agent Memory Inspired by Cognitive Science | 认知科学启发的自组织 Agent 记忆 | [paper](https://doi.org/10.48550/arXiv.2508.03341) |
| 2025/09 | MOOM: Maintenance, Organization and Optimization of Memory in Ultra-Long RP | 超长角色扮演对话中的记忆维护、组织与优化 | [paper](https://arxiv.org/abs/2509.11860) |
| 2025/09 | Multiple Memory Systems for Long-term Memory of Agent | 多记忆系统增强 Agent 长期记忆 | [paper](https://doi.org/10.48550/arXiv.2508.15294) |
| 2025/09 | Semantic Anchoring in Agentic Memory | 利用语言结构做持久对话上下文的语义锚定 | [paper](https://doi.org/10.48550/arXiv.2508.12630) |
| 2025/09 | ComoRAG: Cognitive-Inspired Memory-Organized RAG for Long Narrative Reasoning | 认知启发的记忆组织 RAG，面向状态化长叙事推理 | [paper](https://doi.org/10.48550/arXiv.2508.10419) |
| 2025/08 | Building Self-Evolving Agents via Experience-Driven Lifelong Learning | 经验驱动的终身学习与自进化 Agent 框架与基准 | [paper](https://arxiv.org/abs/2508.19005) |
| 2025/08 | Seeing, Listening, Remembering, and Reasoning: Multimodal Agent with LTM | 多模态 Agent 的长期记忆与推理 | [paper](https://arxiv.org/abs/2508.09736) |
| 2025/08 | Memory-R1: LLM Agents Manage and Utilize Memories via RL | 用强化学习让 LLM Agent 管理与利用记忆 | [paper](https://arxiv.org/abs/2508.19828) |
| 2025/08 | Intrinsic Memory Agents: Heterogeneous Multi-Agent with Structured Contextual Memory | 异构多 Agent 与结构化上下文记忆 | [paper](https://arxiv.org/abs/2508.08997) |
| 2025/07 | MIRIX: Multi-Agent Memory System for LLM-Based Agents | 面向 LLM Agent 的多智能体记忆系统 | [paper](https://arxiv.org/abs/2507.07957) |
| 2025/07 | Hierarchical Memory for High-Efficiency Long-Term Reasoning | 层次化记忆支撑高效长期推理 | [paper](https://arxiv.org/abs/2507.22925) |
| 2025/06 | G-Memory: Tracing Hierarchical Memory for Multi-Agent Systems | 多智能体系统中的层次化记忆追踪 | [paper](https://arxiv.org/abs/2506.07398) |
| 2025/06 | Embodied Agents Meet Personalization: Memory for Personalized Assistance | 具身 Agent 与个性化中的记忆利用 | [paper](https://doi.org/10.48550/arXiv.2505.16348) |
| 2025/05 | MemGuide: Intent-Driven Memory Selection for Goal-Oriented Multi-Session Agents | 目标导向多会话中的意图驱动记忆选择 | [paper](https://arxiv.org/abs/2505.20231) |
| 2025/05 | Pre-training Limited Memory LMs with Internal and External Knowledge | 内外知识结合预训练有限记忆语言模型 | [paper](https://arxiv.org/abs/2505.15962) |
| 2025/05 | Embodied VideoAgent: Persistent Memory from Egocentric Videos | 第一视角视频与具身传感器的持久记忆，动态场景理解 | [paper](https://doi.org/10.48550/arXiv.2501.00358) |
| 2025/04 | Mem0: Building production-ready ai agents with scalable long-term memory | 可扩展长期记忆的生产级 Agent（开源 Mem0） | [paper](https://arxiv.org/abs/2504.19413) |
| 2025/03 | In Prospect and Retrospect: Reflective Memory Management for Long-term Dialogue | 前瞻与回顾的反思式记忆管理，长期个性化对话 | [paper](https://aclanthology.org/2025.acl-long.413/) |
| 2025/02 | SeCom: Memory Construction and Retrieval for Personalized Conversational Agents | 个性化对话 Agent 的记忆构建与检索 | [paper](https://openreview.net/forum?id=xKDZAW0He3) |
| 2025/02 | Zep: A Temporal Knowledge Graph Architecture for Agent Memory | 时序知识图架构作为 Agent 记忆（Zep 开源） | [paper](https://doi.org/10.48550/arXiv.2501.13956) |
| 2025/02 | R³Mem: Bridging Memory Retention and Retrieval via Reversible Compression | 可逆压缩桥接记忆保留与检索 | [paper](https://arxiv.org/abs/2502.15957) |
| 2025/02 | A-MEM: Agentic Memory for LLM Agents | 面向 LLM Agent 的 Agentic 记忆设计 | [paper](https://doi.org/10.48550/ARXIV.2502.12110) |
| 2025/02 | Unveiling Privacy Risks in LLM Agent Memory | LLM Agent 记忆中的隐私风险揭示 | [paper](https://arxiv.org/abs/2502.13172) |
| 2025/02 | Mem2Ego: Global-to-Ego Memory for Long-Horizon Embodied Navigation | 视觉语言模型的全局-自我记忆，长程具身导航 | [paper](https://doi.org/10.48550/arXiv.2502.14254) |
| 2024/12 | AI PERSONA: Life-long Personalization of LLMs | LLM 的终身个性化与人格 | [paper](https://arxiv.org/abs/2412.13103) |
| 2024/11 | OASIS: Open Agent Social Interaction Simulations with One Million Agents | 百万级开放 Agent 社会交互模拟 | [paper](https://arxiv.org/abs/2411.11581) |
| 2024/10 | Video-RAG: Visually-aligned Retrieval-Augmented Long Video Comprehension | 视觉对齐的检索增强长视频理解 | [paper](https://arxiv.org/abs/2411.13093) |
| 2024/10 | Memolet: Reifying the Reuse of User-AI Conversational Memories | 将用户-AI 对话记忆的复用具体化 | [paper](https://doi.org/10.1145/3654777.3676388) |
| 2024/10 | From Isolated Conversations to Hierarchical Schemas: Dynamic Tree Memory | 从孤立对话到层次图式的动态树记忆 | [paper](https://arxiv.org/abs/2410.14052) |
| 2024/10 | Enhancing Long Context in LLMs Through Inner Loop Query Mechanism | 内循环查询机制增强长上下文表现 | [paper](https://arxiv.org/abs/2410.12859) |
| 2024/09 | Crafting Personalized Agents via RAG on Editable Memory Graphs | 可编辑记忆图上的 RAG 构建个性化 Agent | [paper](https://arxiv.org/abs/2409.19401) |
| 2024/07 | Human-inspired Episodic Memory for Infinite Context LLMs | 人式情景记忆，无限上下文 LLM | [paper](https://openreview.net/forum?id=BI2int5SAC) |
| 2024/07 | Arigraph: Knowledge graph world models with episodic memory for llm agents | 带情景记忆的知识图谱世界模型 | [paper](https://arxiv.org/abs/2407.04363) |
| 2024/07 | ChatHaruhi: Reviving Anime Character via LLM | 用 LLM 复活动漫角色（角色记忆与一致性） | [paper](https://doi.org/10.48550/arXiv.2308.09597) |
| 2024/07 | Toward Conversational Agents with Context and Time Sensitive Long-term Memory | 上下文与时间敏感的长期记忆对话 Agent | [paper](https://doi.org/10.48550/arXiv.2406.00057) |
| 2024/06 | Enhancing Long-Term Memory using Hierarchical Aggregate Tree for RAG | 层次聚合树增强长期记忆与 RAG | [paper](https://arxiv.org/abs/2406.06124) |
| 2024/06 | Towards Lifelong Dialogue Agents via Timeline-based Memory Management | 基于时间线的记忆管理实现终身对话 Agent | [paper](https://arxiv.org/abs/2406.10996) |
| 2024/05 | HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs | 神经生物学启发的 LLM 长期记忆 | [paper](https://arxiv.org/abs/2405.14831) |
| 2024/05 | Memory Sharing for Large Language Model based Agents | LLM Agent 的记忆共享 | [paper](https://doi.org/10.48550/arXiv.2404.09982) |
| 2024/05 | Knowledge Graph Tuning: Real-time LLM Personalization from Human Feedback | 基于人类反馈的实时知识图谱调优与个性化 | [paper](https://arxiv.org/abs/2405.19686) |
| 2024/04 | From Local to Global: Graph RAG for Query-Focused Summarization | 从局部到全局的图 RAG 与查询聚焦摘要 | [paper](https://arxiv.org/abs/2404.16130) |
| 2024/03 | Memoro: LLMs for Real-Time Memory Augmentation | 用 LLM 实现简洁的实时记忆增强接口 | [paper](https://doi.org/10.1145/3613904.3642450) |
| 2023/10 | RoleLLM: Role-Playing Abilities of LLMs | 角色扮演能力基准与增强 | [paper](https://doi.org/10.18653/v1/2024.findings-acl.878) |
| 2023/10 | **MemGPT: Towards LLMs as Operating Systems** | 将 LLM 视为操作系统，分层内存与系统调用（奠基） | [paper](https://arxiv.org/abs/2310.08560) |
| 2023/10 | GameGPT: Multi-agent Collaborative Framework for Game Development | 游戏开发中的多智能体协作 | [paper](https://doi.org/10.48550/ARXIV.2310.08067) |
| 2023/10 | Lyfe Agents: Generative agents for low-cost real-time social interactions | 低成本实时社交的生成式 Agent | [paper](https://arxiv.org/abs/2310.02172) |
| 2023/08 | CALYPSO: LLMs as Dungeon Masters' Assistants | 地下城大师助手与长期状态 | [paper](https://doi.org/10.1609/aiide.v19i1.27534) |
| 2023/08 | MetaGPT: Meta Programming for Multi-Agent Collaborative Framework | 多智能体协作的元编程框架 | [paper](https://arxiv.org/abs/2308.00352) |
| 2023/08 | Recommender AI Agent: LLMs for Interactive Recommendations | 交互式推荐中的 LLM Agent | [paper](https://doi.org/10.1145/3731446) |
| 2023/08 | MemoChat: Tuning LLMs to Use Memos for Long-Range Open-Domain Conversation | 用 Memo 做一致的长程开放域对话 | [paper](https://arxiv.org/abs/2308.08239) |
| 2023/08 | Recursively summarizing enables long-term dialogue memory in LLMs | 递归摘要实现长期对话记忆 | [paper](https://arxiv.org/abs/2308.15022) |
| 2023/07 | MovieChat: From Dense Token to Sparse Memory for Long Video | 长视频理解：从稠密 Token 到稀疏记忆 | [paper](https://doi.org/10.1109/CVPR52733.2024.01725) |
| 2023/07 | S³: Social-network Simulation with LLM-Empowered Agents | 社交网络模拟与 LLM Agent | [paper](https://doi.org/10.48550/ARXIV.2307.14984) |
| 2023/05 | Prompted LLMs as Chatbot Modules for Long Open-domain Conversation | 长开放域对话的提示式聊天模块 | [paper](https://doi.org/10.18653/v1/2023.findings-acl.277) |
| 2023/05 | RecurrentGPT: Interactive Generation of (Arbitrarily) Long Text | 交互式生成长文本的循环结构 | [paper](https://arxiv.org/abs/2305.13304) |
| 2023/05 | Memorybank: Enhancing LLMs with long-term memory | 为 LLM 增加长期记忆的 Memorybank | [paper](https://arxiv.org/abs/2305.10250) |
| 2023/05 | RET-LLM: Towards a general read-write memory for LLMs | 通用读写记忆 | [paper](https://arxiv.org/abs/2305.14322) |
| 2023/04 | **Generative agents: Interactive simulacra of human behavior** | 具身记忆、反思、计划的生成式智能体（奠基） | [paper](https://arxiv.org/abs/2304.03442) |
| 2023/04 | HuaTuo: Tuning LLaMA with Chinese Medical Knowledge | 中文医学知识微调 | [paper](https://arxiv.org/abs/2304.06975) |
| 2023/04 | SCM: Self-Controlled Memory Framework for LLM | LLM 的自控记忆框架 | [paper](https://arxiv.org/abs/2304.13343) |

---

## 2. Parametric 事实记忆

通过模型参数、适配器或知识编辑存储事实与画像，读快写慢、可做终身编辑。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2025/10 | MemLoRA: Distilling Expert Adapters for On-Device Memory | 设备端记忆的专家适配器蒸馏 | [paper](https://arxiv.org/abs/2512.04763) |
| 2025/10 | Pretraining with hierarchical memories: long-tail and common knowledge | 分层记忆预训练，区分长尾与常识知识 | [paper](https://arxiv.org/abs/2510.02375) |
| 2025/08 | Memory Decoder: Pretrained, Plug-and-Play Memory for LLMs | 即插即用的预训练记忆解码器 | [paper](https://arxiv.org/abs/2508.09874) |
| 2025/08 | MLP Memory: Language Modeling with Retriever-pretrained External Memory | 检索器预训练外部记忆的语言建模 | [paper](https://doi.org/10.48550/arXiv.2508.01832) |
| 2024/10 | Self-Updatable LLMs by Integrating Context into Model Parameters | 将上下文整合进参数实现自更新 LLM | [paper](https://openreview.net/forum?id=aCPFCDL9QY) |
| 2024/10 | AlphaEdit: Null-Space Constrained Knowledge Editing | 零空间约束的知识编辑 | [paper](https://arxiv.org/abs/2410.02355) |
| 2024/08 | ELDER: Enhancing Lifelong Model Editing with Mixture-of-LoRA | 混合 LoRA 的终身模型编辑 | [paper](https://doi.org/10.1609/aaai.v39i23.34622) |
| 2024/05 | WISE: Rethinking Knowledge Memory for Lifelong Model Editing of LLMs | 终身编辑中的知识记忆重构 | [paper](http://papers.nips.cc/paper_files/paper/2024/hash/60960ad78868fce5c165295fbd895060-Abstract-Conference.html) |
| 2024/03 | Online Adaptation of LMs with a Memory of Amortized Contexts | 摊销上下文记忆的在线适应 | [paper](http://papers.nips.cc/paper_files/paper/2024/hash/eaf956b52bae51fbf387b8be4cc3ce18-Abstract-Conference.html) |
| 2024/01 | Neighboring Perturbations of Knowledge Editing on LLMs | LLM 知识编辑的邻域扰动 | [paper](https://openreview.net/forum?id=K9NTPRvVRI) |
| 2023/11 | CharacterGLM: Customizing Social Characters with LLMs | 用 LLM 定制社交角色（参数化角色记忆） | [paper](https://doi.org/10.18653/v1/2024.emnlp-industry.107) |
| 2023/10 | Character-LLM: A Trainable Agent for Role-Playing | 可训练角色扮演 Agent | [paper](https://doi.org/10.18653/v1/2023.emnlp-main.814) |
| 2021/10 | Fast Model Editing at Scale | 大规模快速模型编辑 | [paper](https://openreview.net/forum?id=0DcZxeWfOPt) |
| 2021/04 | Editing Factual Knowledge in Language Models | 语言模型中事实知识编辑（奠基） | [paper](https://arxiv.org/abs/2104.08164) |
| 2020/02 | K-Adapter: Infusing Knowledge into Pre-Trained Models with Adapters | 用适配器向预训练模型注入知识 | [paper](https://doi.org/10.18653/v1/2021.findings-acl.121) |
| 2013/02 | ELLA: An Efficient Lifelong Learning Algorithm | 高效终身学习算法 | [paper](https://proceedings.mlr.press/v28/ruvolo13.html) |

---

## 3. Latent 事实记忆

以隐状态、压缩表示或连续向量承载记忆，介于显式文本与参数之间。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2025/09 | Similarity-Distance-Magnitude Activations | 相似性-距离-幅值激活与记忆表示 | [paper](https://arxiv.org/abs/2509.12760) |
| 2025/08 | Towards General Continuous Memory for Vision-Language Models | 视觉-语言模型的通用连续记忆 | [paper](https://arxiv.org/abs/2505.17670) |
| 2025/03 | M+: Extending MemoryLLM with Scalable Long-Term Memory | MemoryLLM 的可扩展长期记忆扩展 | [paper](https://doi.org/10.48550/arXiv.2502.00592) |
| 2025/02 | R3Mem: Bridging Memory Retention and Retrieval via Reversible Compression | 可逆压缩桥接保留与检索（与 Token 版同系列） | [paper](https://arxiv.org/abs/2502.15957v1) |
| 2024/07 | Memory³: Language Modeling with Explicit Memory | 带显式记忆的语言建模 | [paper](https://doi.org/10.48550/arXiv.2407.01178) |
| 2024/03 | Efficient Episodic Memory Utilization of Cooperative Multi-Agent RL | 多智能体强化学习中的情景记忆高效利用 | [paper](https://openreview.net/forum?id=LjivA1SLZ6) |
| 2023/10 | Memoria: Resolving Fateful Forgetting via Human-Inspired Memory Architecture | 人式记忆架构解决灾难性遗忘 | [paper](https://arxiv.org/abs/2310.03052) |
| 2021/12 | Detecting Local Insights from Global Labels (Convolutional Decomposition) | 从全局标签检测局部洞察，序列标注与记忆 | [paper](https://doi.org/10.1162/coli_a_00416) |

---

**说明**：核心思想由标题与 Survey 分类推断，精确表述以原文为准。完整列表与链接见 [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List)。
