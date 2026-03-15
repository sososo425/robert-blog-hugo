---
title: "经验记忆 (Experiential Memory) 论文核心思想"
date: 2026-03-02T12:00:00+08:00
draft: false
description: "Agent 经验与技能型记忆：从反思、示范到过程记忆与自进化的论文归纳"
categories: ["技术"]
tags: ["AI", "Agent", "Memory", "Experiential Memory", "论文"]
---

本文归纳 [Agent-Memory-Paper-List](https://github.com/Shichun-Liu/Agent-Memory-Paper-List) 中 **Experiential Memory** 类别下的论文核心思想。经验记忆承载**洞察、策略与技能**，支持从经验中学习、反思与自进化，按载体分为 **Token-level**、**Parametric**、**Latent**。

---

## 1. Token-level 经验记忆

显式存储经验（示范、轨迹、策略描述、技能库等），供检索或模仿。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2026/01 | MemRL: Self-Evolving Agents via Runtime RL on Episodic Memory | 在情景记忆上做运行时强化学习，实现自进化 Agent | [paper](https://arxiv.org/abs/2601.03192) |
| 2025/12 | MemEvolve: Meta-Evolution of Agent Memory Systems | Agent 记忆系统的元进化 | [paper](https://arxiv.org/abs/2512.18746) |
| 2025/12 | Remember Me, Refine Me: Dynamic Procedural Memory for Experience-Driven Evolution | 动态过程记忆驱动经验型 Agent 进化 | [paper](https://arxiv.org/abs/2512.10696) |
| 2025/12 | Hindsight is 20/20: Agent Memory that Retains, Recalls, and Reflects | 保留、召回与反思统一的 Agent 记忆（与事实记忆共列） | [paper](https://arxiv.org/abs/2512.12818) |
| 2025/11 | Agentic Context Engineering: Evolving Contexts for Self-Improving LMs | 自改进语言模型的上下文演化 | [paper](https://doi.org/10.48550/arXiv.2510.04618) |
| 2025/11 | FLEX: Continuous Agent Evolution via Forward Learning from Experience | 从经验前向学习的持续 Agent 进化 | [paper](https://arxiv.org/abs/2511.06449) |
| 2025/11 | Scaling Agent Learning via Experience Synthesis | 通过经验合成扩展 Agent 学习 | [paper](https://arxiv.org/abs/2511.03773) |
| 2025/11 | UFO2: The Desktop AgentOS | 桌面 Agent 操作系统与经验/状态管理 | [paper](https://doi.org/10.48550/arXiv.2504.14603) |
| 2025/10 | PRINCIPLES: Synthetic Strategy Memory for Proactive Dialogue Agents | 合成策略记忆支撑主动对话 Agent | [paper](https://doi.org/10.48550/arXiv.2509.17459) |
| 2025/10 | Training-Free Group Relative Policy Optimization | 无训练的分组相对策略优化 | [paper](https://arxiv.org/abs/2510.08191) |
| 2025/10 | ToolMem: Learnable Tool Capability Memory for Multimodal Agents | 多模态 Agent 的可学习工具能力记忆 | [paper](https://doi.org/10.48550/arXiv.2510.06664) |
| 2025/10 | H²R: Hierarchical Hindsight Reflection for Multi-Task LLM Agents | 多任务 LLM Agent 的层次化事后反思 | [paper](https://doi.org/10.48550/arXiv.2509.12810) |
| 2025/10 | BrowserAgent: Web Agents with Human-Inspired Browsing Actions | 人类浏览行为启发的 Web Agent | [paper](http://arxiv.org/abs/2510.10666) |
| 2025/10 | LEGOMem: Modular Procedural Memory for Multi-agent Workflow Automation | 多 Agent 工作流自动化的模块化过程记忆 | [paper](http://arxiv.org/abs/2510.04851) |
| 2025/10 | Alita-G: Self-Evolving Generative Agent for Agent Generation | 自进化生成式 Agent，用于 Agent 生成 | [paper](https://doi.org/10.48550/arXiv.2510.23601) |
| 2025/09 | ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory | 推理记忆支撑 Agent 自进化扩展 | [paper](https://arxiv.org/abs/2509.25140) |
| 2025/09 | Memento: Fine-tuning LLM Agents without Fine-tuning LLMs | 不微调 LLM 而微调 Agent（外部记忆/策略） | [paper](https://doi.org/10.48550/arXiv.2508.16153) |
| 2025/08 | Memp: Exploring Agent Procedural Memory | Agent 过程记忆的探索 | [paper](https://arxiv.org/abs/2508.06433) |
| 2025/08 | SEAgent: Self-Evolving Computer Use Agent with Learning from Experience | 从经验中自主学习的自进化计算机使用 Agent | [paper](https://arxiv.org/abs/2508.04700) |
| 2025/07 | Agent KB: Cross-Domain Experience for Agentic Problem Solving | 跨领域经验支撑 Agent 问题解决 | [paper](https://arxiv.org/abs/2507.06229) |
| 2025/07 | MemTool: Short-term memory management for dynamic tool calling in multi-turn | 多轮对话中动态工具调用的短期记忆管理 | [paper](https://arxiv.org/abs/2507.21428) |
| 2025/05 | Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents | 自改进 Agent 的开放演化（Gödel 机式） | [paper](https://doi.org/10.48550/arXiv.2505.22954) |
| 2025/05 | Alita: Generalist Agent with Minimal Predefinition and Maximal Self-Evolution | 最少预定义、最大自进化的通用 Agent | [paper](https://arxiv.org/abs/2505.20286) |
| 2025/05 | SkillWeaver: Web Agents Self-Improve by Discovering and Honing Skills | Web Agent 通过发现与打磨技能自改进 | [paper](https://doi.org/10.48550/arXiv.2504.07079) |
| 2025/05 | LearnAct: Few-Shot Mobile GUI Agent with Unified Demonstration Benchmark | 少样本移动端 GUI Agent 与统一示范基准 | [paper](https://doi.org/10.48550/arXiv.2504.13805) |
| 2025/05 | Retrieval Models Aren't Tool-Savvy: Benchmarking Tool Retrieval for LLMs | 工具检索基准与 LLM 工具能力 | [paper](https://doi.org/10.48550/arXiv.2503.01763) |
| 2025/04 | Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory | 测试时学习与自适应记忆（动态小抄） | [paper](https://arxiv.org/abs/2504.07952) |
| 2025/04 | Inducing Programmatic Skills for Agentic Tasks | 为 Agent 任务诱导程序化技能 | [paper](https://arxiv.org/abs/2504.06821) |
| 2025/03 | COLA: Scalable Multi-Agent Framework For Windows UI Task Automation | Windows UI 任务自动化的多 Agent 框架 | [paper](https://doi.org/10.48550/arXiv.2503.09263) |
| 2025/03 | Memory-augmented Query Reconstruction for KG Reasoning | 记忆增强的查询重构用于知识图谱推理 | [paper](https://arxiv.org/abs/2503.05193) |
| 2025/02 | From Exploration to Mastery: LLMs Master Tools via Self-Driven Interactions | 通过自驱动交互让 LLM 掌握工具 | [paper](https://doi.org/10.48550/arXiv.2410.08197) |
| 2025/02 | From RAG to Memory: Non-Parametric Continual Learning for LLMs | 从 RAG 到记忆：LLM 的非参数持续学习 | [paper](https://arxiv.org/abs/2502.14802) |
| 2024/12 | Planning from Imagination: Episodic Simulation and Episodic Memory for VLN | 视觉-语言导航中的情景模拟与情景记忆 | [paper](https://arxiv.org/abs/2412.01857) |
| 2024/10 | RepairAgent: Autonomous, LLM-Based Agent for Program Repair | 程序修复的自主 LLM Agent | [paper](http://arxiv.org/abs/2403.17134) |
| 2024/09 | SAGE: Self-evolving Agents with Reflective and Memory-augmented Abilities | 具反思与记忆增强能力的自进化 Agent | [paper](https://doi.org/10.1016/j.neucom.2025.130470) |
| 2024/07 | Agent Workflow Memory | Agent 工作流记忆 | [paper](https://openreview.net/forum?id=NTAhi2JEEE) |
| 2024/07 | Fincon: LLM multi-agent with conceptual verbal reinforcement for financial decisions | 金融决策的概念性语言强化多 Agent | [paper](https://arxiv.org/abs/2407.06567) |
| 2024/06 | Buffer of Thoughts: Thought-Augmented Reasoning with LLMs | 思维缓冲与思维增强推理 | [paper](http://papers.nips.cc/paper_files/paper/2024/hash/cde328b7bf6358f5ebb91fe9c539745e-Abstract-Conference.html) |
| 2024/05 | COLT: Completeness-Oriented Tool Retrieval for LLMs | 面向完整性的工具检索 | [paper](https://doi.org/10.48550/arXiv.2405.16089) |
| 2023/11 | JARVIS-1: Open-World Multi-Task Agents With Memory-Augmented Multimodal LMs | 开放世界多任务 Agent 与记忆增强多模态 LM | [paper](https://doi.org/10.1109/TPAMI.2024.3511593) |
| 2023/08 | RecMind: LLM Powered Agent For Recommendation | 推荐场景的 LLM Agent | [paper](https://doi.org/10.18653/v1/2024.findings-naacl.271) |
| 2023/08 | **ExpeL: LLM Agents Are Experiential Learners** | Agent 从经验中学习（示范库与经验提炼，奠基） | [paper](https://doi.org/10.1609/aaai.v38i17.29936) |
| 2023/07 | ToolLLM: Facilitating LLMs to Master 16000+ Real-world APIs | LLM 掌握海量真实 API（工具使用经验） | [paper](https://arxiv.org/abs/2307.16789) |
| 2023/05 | CREATOR: Tool Creation for Abstract and Concrete Reasoning of LLMs | 工具创建与抽象/具体推理解耦 | [paper](https://doi.org/10.18653/v1/2023.findings-emnlp.462) |
| 2023/03 | **Reflexion: Language agents with verbal reinforcement learning** | 语言 Agent 的言语强化学习与反思记忆（奠基） | [paper](https://arxiv.org/abs/2303.11366) |
| 2023/02 | **Toolformer: Language models can teach themselves to use tools** | 模型自学使用工具（工具经验，奠基） | [paper](https://arxiv.org/abs/2302.04761) |

---

## 2. Parametric 经验记忆

策略或技能以参数形式存储（策略网络、适配器、持续预训练等）。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2025/11 | AgentEvolver: Towards Efficient Self-Evolving Agent System | 高效自进化 Agent 系统 | [paper](https://arxiv.org/abs/2511.10395) |
| 2025/10 | Agent Learning via Early Experience | 通过早期经验进行 Agent 学习 | [paper](https://arxiv.org/abs/2510.08558) |
| 2025/10 | Scaling Agents via Continual Pre-training | 持续预训练扩展 Agent | [paper](https://doi.org/10.48550/arXiv.2509.13310) |
| 2024/10 | ToolGen: Unified Tool Retrieval and Calling via Generation | 用生成统一工具检索与调用 | [paper](https://arxiv.org/abs/2410.03439) |
| 2023/08 | Retroformer: Retrospective LLM Agents with Policy Gradient Optimization | 回顾式 LLM Agent 与策略梯度优化 | [paper](https://arxiv.org/abs/2308.02151) |
| 2023/06 | A Machine with Short-Term, Episodic, and Semantic Memory Systems | 短时、情景与语义记忆系统统一的机器架构 | [paper](https://doi.org/10.1609/aaai.v37i1.25075) |

---

## 3. Latent 经验记忆

经验以隐状态或连续表示存在，多与 GUI/视觉等模态结合。

| 时间 | 论文 | 核心思想 | 链接 |
|------|------|----------|------|
| 2025/11 | Auto-scaling Continuous Memory for GUI Agent | GUI Agent 的自扩展连续记忆 | [paper](https://doi.org/10.48550/arXiv.2510.09038) |

---

**引用关系简述**：**Reflexion** 的言语反思与策略记忆被 ExpeL、Memento、SEAgent、H²R、Remember Me Refine Me 等延续；**Toolformer** 开启工具使用线，衍生 ToolLLM、CREATOR、ToolGen、ToolMem、COLT 等；**ExpeL** 的经验提炼与示范库影响 Agent KB、FLEX、Scaling Agent Learning 等。详见 [综述：发展脉络与引用关系](/tech/agent-mem-papers/overview/)。
