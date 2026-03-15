---
title: "Agent Memory: 经验记忆 (Experiential Memory)"
date: 2026-03-15T20:30:00+08:00
draft: false
tags: ["AI", "Agent", "Experiential Memory", "技能学习", "终身学习"]
categories: ["tech"]
description: "Agent Memory 中经验记忆相关论文总结，涵盖技能积累、经验复用和程序性记忆等方向。"
---

## 概述

**经验记忆 (Experiential Memory)** 存储智能体从交互中学习到的**技能、洞察和策略**，而非静态事实。它使智能体能够：

- 从失败和成功中学习 (强化学习)
- 积累和复用技能 (程序性记忆)
- 通过反思改进行为 (元认知)
- 跨任务迁移经验 (迁移学习)

**与事实记忆的区别**:
- 事实记忆: "北京是中国的首都" (静态知识)
- 经验记忆: "当用户抱怨时，先道歉再解决问题" (习得策略)

---

## Token-level 经验记忆

**核心思想**: 用自然语言显式记录经验、技能和策略。

### 代表性论文

#### 1. Reflexion (2023)
- **论文**: *Reflexion: Language agents with verbal reinforcement learning*
- **链接**: [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)
- **核心思想**:
  - **语言强化学习**: 使用自然语言反馈替代数值奖励
  - 智能体通过**自我反思**总结失败原因
  - 将反思结果存入经验记忆，指导下一次尝试
- **关键创新**:
  - 不需要模型微调，纯提示工程实现
  - 经验以人类可读的形式存储
  - 支持多轮迭代改进
- **意义**: 开创了语言化经验学习的先河

#### 2. ExpeL (2023)
- **论文**: *ExpeL: LLM Agents Are Experiential Learners*
- **链接**: [AAAI 2024](https://doi.org/10.1609/aaai.v38i17.29936)
- **核心思想**:
  - 从经验中提取**成功和失败的案例**
  - 构建经验库支持少样本学习
  - 新任务时检索相似经验作为参考
- **关键机制**:
  - 经验编码: 将执行轨迹转化为可复用的知识
  - 经验检索: 基于任务相似度匹配相关经验
  - 经验应用: 将检索到的经验注入提示
- **意义**: 证明了经验积累对智能体性能的显著提升

#### 3. SkillWeaver (2025)
- **论文**: *SkillWeaver: Web Agents can Self-Improve by Discovering and Honing Skills*
- **链接**: [arXiv:2504.07079](https://arxiv.org/abs/2504.07079)
- **核心思想**:
  - **技能发现**: 自动从网页交互中识别可复用技能
  - **技能精炼**: 通过多次执行优化技能描述
  - **技能库**: 维护结构化的技能集合
- **技能表示**:
  ```
  技能名称: 登录网站
  前置条件: 需要用户名和密码
  执行步骤: 1. 点击登录按钮 2. 输入凭证 3. 提交
  预期结果: 进入用户主页
  ```
- **意义**: 实现网页智能体的持续自我改进

#### 4. Agent Workflow Memory (2024)
- **论文**: *Agent Workflow Memory*
- **链接**: [OpenReview](https://openreview.net/forum?id=NTAhi2JEEE)
- **核心思想**:
  - 将复杂任务分解为**工作流**
  - 学习并存储任务工作流模式
  - 新任务时复用或改编已有工作流
- **工作流记忆**:
  - 节点: 子任务或操作
  - 边: 执行顺序和依赖关系
  - 条件: 分支决策规则
- **意义**: 结构化经验表示支持复杂任务规划

#### 5. MemEvolve (2025)
- **论文**: *MemEvolve: Meta-Evolution of Agent Memory Systems*
- **链接**: [arXiv:2512.18746](https://arxiv.org/abs/2512.18746)
- **核心思想**:
  - **元进化**: 不仅进化记忆内容，还进化记忆机制
  - 记忆系统本身作为优化目标
  - 自动发现最佳记忆结构
- **意义**: 从固定架构走向自适应记忆系统

#### 6. Hindsight is 20/20 (2025)
- **论文**: *Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects*
- **链接**: [arXiv:2512.12818](https://arxiv.org/abs/2512.12818)
- **核心思想**:
  - **三R框架**: 保持(Retain)、回忆(Recall)、反思(Reflect)
  - 事后反思 (Hindsight) 优化决策
  - 构建可解释的经验记忆
- **意义**: 系统化的经验记忆管理框架

#### 7. Remember Me, Refine Me (2025)
- **论文**: *Remember Me, Refine Me: A Dynamic Procedural Memory Framework*
- **链接**: [arXiv:2512.10696](https://arxiv.org/abs/2512.10696)
- **核心思想**:
  - **动态程序性记忆**: 持续改进技能表示
  - 保留技能历史版本
  - 根据执行反馈选择最优版本
- **意义**: 程序性记忆的版本控制和进化

#### 8. MemRL (2026)
- **论文**: *MemRL: Self-Evolving Agents via Runtime Reinforcement Learning on Episodic Memory*
- **链接**: [arXiv:2601.03192](https://arxiv.org/abs/2601.03192)
- **核心思想**:
  - 基于**情景记忆**的运行时强化学习
  - 从记忆中采样经验进行离线学习
  - 实时更新策略而不中断服务
- **意义**: 实现终身学习的经验积累

---

## Parametric 经验记忆

**核心思想**: 将经验编码到模型参数中，通过持续学习更新。

### 代表性论文

#### 1. Retroformer (2023)
- **论文**: *Retroformer: Retrospective Large Language Agents with Policy Gradient Optimization*
- **链接**: [arXiv:2308.02151](https://arxiv.org/abs/2308.02151)
- **核心思想**:
  - 使用**策略梯度优化**学习回顾性反思
  - 训练模型生成更好的自我反思
  - 将反思能力编码到模型参数
- **训练目标**:
  - 最大化任务成功率
  - 通过反思改进决策质量
- **意义**: 参数化经验提升反思能力

#### 2. ToolGen (2024)
- **论文**: *ToolGen: Unified Tool Retrieval and Calling via Generation*
- **链接**: [arXiv:2410.03439](https://arxiv.org/abs/2410.03439)
- **核心思想**:
  - 将工具使用经验编码到生成模型
  - 统一工具检索和调用
  - 通过训练提升工具使用熟练度
- **意义**: 参数化工具技能记忆

#### 3. AgentEvolver (2025)
- **论文**: *AgentEvolver: Towards Efficient Self-Evolving Agent System*
- **链接**: [arXiv:2511.10395](https://arxiv.org/abs/2511.10395)
- **核心思想**:
  - 高效自进化智能体系统
  - 选择性经验存储与参数更新
  - 避免灾难性遗忘
- **意义**: 可扩展的参数化经验学习

#### 4. Agent Learning via Early Experience (2025)
- **论文**: *Agent Learning via Early Experience*
- **链接**: [arXiv:2510.08558](https://arxiv.org/abs/2510.08558)
- **核心思想**:
  - 早期经验对智能体学习的深远影响
  - 关键期假设在智能体学习中的验证
  - 优化早期训练经验的选择
- **意义**: 揭示了经验积累的时间效应

#### 5. Scaling Agents via Continual Pre-training (2025)
- **论文**: *Scaling Agents via Continual Pre-training*
- **链接**: [arXiv:2509.13310](https://arxiv.org/abs/2509.13310)
- **核心思想**:
  - 通过持续预训练扩展智能体能力
  - 大规模经验数据的利用
  - 参数层面的知识累积
- **意义**: 预训练范式的经验学习

---

## Latent 经验记忆

**核心思想**: 使用连续向量表示隐式编码经验。

### 代表性论文

#### 1. Auto-scaling Continuous Memory (2025)
- **论文**: *Auto-scaling Continuous Memory for GUI Agent*
- **链接**: [arXiv:2510.09038](https://arxiv.org/abs/2510.09038)
- **核心思想**:
  - 面向 GUI 智能体的自动扩展连续记忆
  - 根据任务复杂度动态调整记忆容量
  - 潜在空间中的经验压缩
- **意义**: 自适应的经验记忆容量管理

---

## 关键概念对比

| 概念 | 定义 | 典型应用 | 代表论文 |
|------|------|----------|----------|
| **Episodic Memory** | 具体事件的经历 | 失败案例分析 | ExpeL, MemRL |
| **Procedural Memory** | 技能和操作知识 | 工具使用、工作流 | SkillWeaver, Agent Workflow Memory |
| **Meta-memory** | 关于记忆的记忆 | 记忆策略优化 | MemEvolve |
| **Reflective Memory** | 反思和洞察 | 决策改进 | Reflexion, Hindsight is 20/20 |

---

## 技术演进脉络

```
2023: 语言化反思 (Reflexion) → 经验库 (ExpeL)
    ↓
2024: 工作流学习 (Agent Workflow Memory) → 技能发现 (SkillWeaver)
    ↓
2025: 元进化 (MemEvolve) → 运行时学习 (MemRL)
    ↓
2026: 自进化智能体 (Agentic Memory)
```

---

## 应用场景

### 1. 编程助手
- **经验**: 常见 bug 修复模式
- **应用**: 自动代码修复 (RepairAgent)

### 2. 网页智能体
- **经验**: 网站导航模式
- **应用**: 自动表单填写、信息检索

### 3. 对话系统
- **经验**: 用户偏好和交互风格
- **应用**: 个性化对话

### 4. 游戏 AI
- **经验**: 游戏策略和技巧
- **应用**: 游戏通关、策略优化

---

## 推荐阅读顺序

1. **入门**: Reflexion → ExpeL → SkillWeaver
2. **进阶**: Agent Workflow Memory → MemEvolve → Hindsight is 20/20
3. **前沿**: MemRL → Mem-α → Agentic Memory

---

*[返回总览](../)*
