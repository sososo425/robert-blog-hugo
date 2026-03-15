---
title: "工作记忆 (Working Memory) 论文核心思想"
date: 2026-03-02T12:00:00+08:00
draft: false
description: "Agent 主动上下文与工作记忆：长短时统一管理、压缩与 Latent 记忆"
categories: ["技术"]
tags: ["AI", "Agent", "Memory", "Working Memory", "论文"]
---

本文归纳 [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) 中 **Working Memory** 类别下的论文核心思想。工作记忆负责**当前任务的主动上下文管理**（上下文压缩、检索、KV/隐状态等），按载体分为 **Token-level**、**Parametric**、**Latent**。

---

## 1. Token-level 工作记忆

显式管理当前上下文（摘要、提纲、状态重建、主动筛选等）。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2026/01 | MemRL: Self-Evolving Agents via Runtime RL on Episodic Memory | 情景记忆上的运行时 RL（与经验记忆共列） | [paper](https://arxiv.org/abs/2601.03192) |
| 2026/01 | Agentic Memory: Unified Long-Term and Short-Term Memory Management for LLM Agents | 统一长短时记忆管理的学习框架 | [paper](https://arxiv.org/abs/2601.01885) |
| 2025/11 | Memory as Action: Autonomous Context Curation for Long-Horizon Agentic Tasks | 将记忆视为动作：长程 Agent 任务的自主上下文策展 | [paper](https://doi.org/10.48550/arXiv.2510.12635) |
| 2025/11 | IterResearch: Long-Horizon Agents via Markovian State Reconstruction | 马尔可夫状态重构的长程研究 Agent | [paper](https://arxiv.org/abs/2511.07327) |
| 2025/11 | MemSearcher: Training LLMs to Reason, Search and Manage Memory via End-to-End RL | 端到端 RL 训练推理、搜索与记忆管理 | [paper](https://doi.org/10.48550/arXiv.2511.02805) |
| 2025/10 | AgentFold: Long-Horizon Web Agents with Proactive Context Management | 主动上下文管理的长程 Web Agent | [paper](https://arxiv.org/abs/2510.24699) |
| 2025/10 | PRIME: Planning and Retrieval-Integrated Memory for Enhanced Reasoning | 规划与检索一体化的记忆增强推理 | [paper](https://doi.org/10.48550/arXiv.2509.22315) |
| 2025/10 | Context as Memory: Scene-Consistent Long Video Generation with Memory Retrieval | 将上下文视为记忆：场景一致的长视频生成与记忆检索 | [paper](https://doi.org/10.48550/arXiv.2506.03141) |
| 2025/10 | DeepAgent: General Reasoning Agent with Scalable Toolsets | 可扩展工具集的通用推理 Agent | [paper](https://doi.org/10.48550/arXiv.2510.21618) |
| 2025/10 | ACON: Optimizing Context Compression for Long-Horizon LLM Agents | 长程 LLM Agent 的上下文压缩优化 | [paper](https://doi.org/10.48550/arXiv.2510.00615) |
| 2025/09 | ReSum: Long-Horizon Search Intelligence via Context Summarization | 通过上下文摘要释放长程搜索能力 | [paper](https://doi.org/10.48550/ARXIV.2509.13313) |
| 2025/08 | Sculptor: Empowering LLMs with Cognitive Agency via Active Context Management | 主动上下文管理赋予 LLM 认知主体性 | [paper](https://arxiv.org/abs/2508.04664) |
| 2025/07 | MemAgent: Long-Context LLM with Multi-Conv RL-based Memory Agent | 多轮对话 RL 记忆 Agent 重塑长上下文 LLM | [paper](https://arxiv.org/abs/2507.02259) |
| 2024/10 | Agent S: Open Agentic Framework That Uses Computers Like a Human | 类人使用计算机的开放 Agent 框架 | [paper](https://arxiv.org/abs/2410.08164) |

---

## 2. Parametric 工作记忆

通过模型结构或参数设计实现高效长上下文（注意力、流式等）。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2024/05 | Various Lengths, Constant Speed: Lightning Attention for Efficient LM | 变长输入、恒定速度的高效语言建模 | [paper](https://openreview.net/forum?id=5wm6TiUP4X) |
| 2024/01 | Efficient Streaming Language Models with Attention Sinks | 注意力水槽实现高效流式长上下文 | [paper](https://openreview.net/forum?id=NG7sS51zVF) |

---

## 3. Latent 工作记忆

KV Cache、压缩表示、Gist/Sentinel、检索增强等隐状态级工作记忆。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2025/11 | VisMem: Latent Vision Memory Unlocks Potential of VLM | 潜在视觉记忆释放视觉-语言模型潜力 | [paper](https://arxiv.org/abs/2511.11007) |
| 2025/09 | MemGen: Generative Latent Memory for Self-Evolving Agents | 自进化 Agent 的生成式潜在记忆 | [paper](https://arxiv.org/abs/2509.24704) |
| 2025/09 | Conflict-Aware Soft Prompting for RAG | RAG 中冲突感知的软提示 | [paper](https://doi.org/10.48550/arXiv.2508.15253) |
| 2025/09 | MemoryVLA: Perceptual-Cognitive Memory in VLA for Robotic Manipulation | 视觉-语言-动作模型中的感知-认知记忆 | [paper](https://doi.org/10.48550/arXiv.2508.19236) |
| 2025/06 | MEM1: Synergize Memory and Reasoning for Efficient Long-Horizon Agents | 记忆与推理协同的高效长程 Agent | [paper](https://arxiv.org/abs/2506.15841) |
| 2025/05 | RazorAttention: Efficient KV Cache Compression Through Retrieval Heads | 通过检索头实现高效 KV Cache 压缩 | [paper](https://openreview.net/forum?id=tkiZQlL04w) |
| 2025/04 | MemoRAG: Long Context with Global Memory-Enhanced Retrieval Augmentation | 全局记忆增强检索的长上下文处理 | [paper](https://doi.org/10.1145/3696410.3714805) |
| 2025/04 | SnapKV: LLM Knows What You are Looking for Before Generation | 生成前即知“所见”的 KV 压缩/检索 | [paper](http://papers.nips.cc/paper_files/paper/2024/hash/28ab418242603e0f7323e54185d19bde-Abstract-Conference.html) |
| 2025/03 | LM2: Large Memory Models | 大记忆模型（长上下文与记忆架构） | [paper](https://doi.org/10.48550/arXiv.2502.06049) |
| 2025/02 | SoftCoT: Soft Chain-of-Thought for Efficient Reasoning with LLMs | 软链式思维实现高效推理 | [paper](https://aclanthology.org/2025.acl-long.1137/) |
| 2025/02 | Time-VLM: Multimodal VLM for Augmented Time Series Forecasting | 多模态 VLM 与时间序列预测中的记忆 | [paper](https://doi.org/10.48550/arXiv.2502.04395) |
| 2025/02 | Titans: Learning to Memorize at Test Time | 测试时学习记忆 | [paper](https://doi.org/10.48550/arXiv.2501.00663) |
| 2024/08 | Augmenting Language Models with Long-Term Memory | 为语言模型增加长期记忆（NeurIPS） | [paper](http://papers.nips.cc/paper_files/paper/2023/hash/ebd82705f44793b6f9ade5a669d0f0bf-Abstract-Conference.html) |
| 2024/06 | Taking a Deep Breath: Sentinel Tokens for LLM Long Context | 哨兵 Token 增强 LLM 长上下文建模 | [paper](https://doi.org/10.18653/v1/2024.findings-emnlp.233) |
| 2024/04 | Adapting Language Models to Compress Contexts | 语言模型适应上下文压缩 | [paper](https://doi.org/10.18653/v1/2023.emnlp-main.232) |
| 2024/03 | Learning to Compress Prompts with Gist Tokens | 用 Gist Token 学习压缩提示 | [paper](http://papers.nips.cc/paper_files/paper/2023/hash/3d77c6dcc7f143aa2154e7f4d5e22d68-Abstract-Conference.html) |
| 2024/03 | Scissorhands: KV Cache Compression at Test Time (Persistence of Importance) | 测试时 KV Cache 压缩与重要性持久化 | [paper](http://papers.nips.cc/paper_files/paper/2023/hash/a452a7c6c463e4ae8fbdc614c6e983e6-Abstract-Conference.html) |
| 2024/03 | Focused Transformer: Contrastive Training for Context Scaling | 对比训练与上下文扩展 | [paper](http://papers.nips.cc/paper_files/paper/2023/hash/8511d06d5590f4bda24d42087802cc81-Abstract-Conference.html) |
| 2023/07 | In-Context Autoencoder for Context Compression in LLM | LLM 内上下文自编码器做上下文压缩 | [paper](https://arxiv.org/abs/2307.06945) |
| 2023/06 | H2O: Heavy-Hitter Oracle for Efficient Generative Inference of LLMs | 重击手 Oracle 与高效生成推理 | [paper](http://papers.nips.cc/paper_files/paper/2023/hash/6ceefa7b15572587b78ecfcebb2827f8-Abstract-Conference.html) |
| 2022/08 | Memorizing Transformers | 记忆化 Transformer（外部记忆） | [paper](https://openreview.net/forum?id=TrjbxzRcnf-) |
| 2022/07 | XMem: Long-Term Video Object Segmentation with Atkinson-Shiffrin Memory Model | Atkinson–Shiffrin 记忆模型与长时视频分割 | [paper](https://arxiv.org/abs/2207.07115) |

---

**引用关系简述**：**Memorizing Transformers** 开启外部/长期记忆线，与 **Augmenting LMs with Long-Term Memory**、**Memory³**、**M+** 等一脉相承；**Attention Sinks** 与 **Streaming LMs** 影响 **Lightning Attention**、**RazorAttention**、**SnapKV** 等 KV/流式工作记忆；**In-Context Autoencoder** 与 **Gist Tokens** 启发了 **Adapting LMs to Compress Contexts**、**ACON**、**SoftCoT** 等上下文压缩。详见 [综述：发展脉络与引用关系](/tech/agent-mem-papers/overview/)。
