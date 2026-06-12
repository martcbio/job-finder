# Blog Quality Review

Generated: 2026-06-09T01:10:26.852Z

Hard gates: body-level evidence, concrete work verbs, concrete system objects, constraints, duplicate-adjusted counts, and non-taxonomy titles.

## 1. Build the LLM feature like production software, not a demo

- Gate: note_only
- Title verdict: rewrite (10/15)
- Gate reasons: title rewrite
- Role families: agentic_workflow_engineer, llm_application_engineer, enterprise_ai_architect
- Reader promise: After reading this, the reader can translate vague AI demand into a concrete engineering artifact and acceptance criteria.
- Failure mode: The job spec says AI, but no one has translated that into ownership, constraints, or acceptance tests.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, tool schema
- Evidence: 3 body jobs, 1 strong body jobs, 3 duplicate-adjusted body jobs

### Top Body Evidence

- `job_923` `job_923.s013` strong_body_evidence: They are looking for a Senior AI Engineer to take a hands-on role in the design and delivery of agentic AI systems, focused on workflow automation, intelligent decision support, and deep integration with an existing commercial platform.

### Weak / Rejected Evidence

- `job_826` `job_826.s013` weak_body_evidence: This is a 12 month temporary contract to start ASAP Day rate: Competitive Market rate Key Responsibilities Building and evolving AI-powered services using Python Designing and implementing evaluation frameworks for LLM-based systems Improving output quality through structured evals rather than purely code changes Applying techniques...
  - Problems: missing production/customer/security/data constraint
- `job_814`  title_only_evidence: # Specialist Computer Centres PLC - Agentic AI Engineer
  - Problems: title evidence cannot support a top post; missing concrete work verb; missing concrete system object; missing production/customer/security/data constraint
- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object

## 2. Agentic workflows need product boundaries before autonomy

- Gate: note_only
- Title verdict: rewrite (11/15)
- Gate reasons: title rewrite
- Role families: agentic_workflow_engineer, llm_application_engineer, enterprise_ai_architect
- Reader promise: After reading this, the reader can translate vague AI demand into a concrete engineering artifact and acceptance criteria.
- Failure mode: The job spec says AI, but no one has translated that into ownership, constraints, or acceptance tests.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, tool schema
- Evidence: 3 body jobs, 1 strong body jobs, 3 duplicate-adjusted body jobs

### Top Body Evidence

- `job_923` `job_923.s013` strong_body_evidence: They are looking for a Senior AI Engineer to take a hands-on role in the design and delivery of agentic AI systems, focused on workflow automation, intelligent decision support, and deep integration with an existing commercial platform.

### Weak / Rejected Evidence

- `job_826` `job_826.s013` weak_body_evidence: This is a 12 month temporary contract to start ASAP Day rate: Competitive Market rate Key Responsibilities Building and evolving AI-powered services using Python Designing and implementing evaluation frameworks for LLM-based systems Improving output quality through structured evals rather than purely code changes Applying techniques...
  - Problems: missing production/customer/security/data constraint
- `job_814`  title_only_evidence: # Specialist Computer Centres PLC - Agentic AI Engineer
  - Problems: title evidence cannot support a top post; missing concrete work verb; missing concrete system object; missing production/customer/security/data constraint
- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object

## 3. Context engineering is the test surface

- Gate: reject
- Title verdict: kill (6/15)
- Gate reasons: title kill; no strong body evidence
- Role families: llm_application_engineer, ai_data_platform_engineer, forward_deployed_ai_engineer, false_positive_non_ai, rag_knowledge_systems_engineer, enterprise_ai_architect
- Reader promise: After reading this, the reader can design retrieval around freshness, permissions, indexing, and answer-quality checks.
- Failure mode: Retrieval looks plausible while stale, unpermissioned, or badly chunked sources drive bad answers.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, RAG ingestion pipeline
- Evidence: 4 body jobs, 0 strong body jobs, 4 duplicate-adjusted body jobs

### Top Body Evidence

_None._

### Weak / Rejected Evidence

- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object
- `job_826` `job_826.s013` weak_body_evidence: This is a 12 month temporary contract to start ASAP Day rate: Competitive Market rate Key Responsibilities Building and evolving AI-powered services using Python Designing and implementing evaluation frameworks for LLM-based systems Improving output quality through structured evals rather than purely code changes Applying techniques...
  - Problems: missing production/customer/security/data constraint
- `job_936` `job_936.s012` false_positive_non_ai_engineering: This scheme plays a critical role in improving river water quality and environmental sustainability within a protected catchment area.Working on behalf of a regional water authority, the project includes the design and construction of a...
  - Problems: missing concrete system object; missing production/customer/security/data constraint; false-positive non-AI engineering risk
- `job_922` `job_922.s013` weak_body_evidence: The objective of this role is to build, design, and maintain the Data Ingestion, Data processing, indexing and RAG Pipelines.
  - Problems: missing production/customer/security/data constraint

### Counterexamples

- `job_936` `job_936.s012` false_positive_non_ai_engineering: This scheme plays a critical role in improving river water quality and environmental sustainability within a protected catchment area.Working on behalf of a regional water authority, the project includes the design and construction of a...
  - Problems: missing concrete system object; missing production/customer/security/data constraint; false-positive non-AI engineering risk

## 4. AI data engineering is still data engineering

- Gate: reject
- Title verdict: kill (1/15)
- Gate reasons: title kill; fewer than 3 distinct body-evidence jobs; fewer than 3 duplicate-adjusted body jobs; fewer than 2 body snippets with concrete work verbs; no strong body evidence
- Role families: ai_data_platform_engineer, ai_product_owner
- Reader promise: After reading this, the reader can translate vague AI demand into a concrete engineering artifact and acceptance criteria.
- Failure mode: The job spec says AI, but no one has translated that into ownership, constraints, or acceptance tests.
- Artifact(s): backlog slice
- Evidence: 1 body jobs, 0 strong body jobs, 1 duplicate-adjusted body jobs

### Top Body Evidence

_None._

### Weak / Rejected Evidence

- `job_802` `job_802.s014` weak_body_evidence: You'll deliver scalable batch and streaming data systems, enabling advanced analytics and AI use cases.
  - Problems: missing concrete system object
- `job_841`  extraction_failed_but_raw_body_strong: # Hamilton Barnes - Product Owner (AI Conversational Analytics) - 6-Month Contract - London
  - Problems: title evidence cannot support a top post; missing concrete system object; missing production/customer/security/data constraint; raw body contains stronger evidence than extracted quote
- `job_811`  extraction_failed_but_raw_body_strong: # Templeton and Partners - AI Engineer - Trading Analytics - 12-month contract Inside IR35
  - Problems: title evidence cannot support a top post; missing concrete work verb; missing concrete system object; missing production/customer/security/data constraint; raw body contains stronger evidence than extracted quote

## 5. Forward-deployed AI without theatre

- Gate: reject
- Title verdict: kill (1/15)
- Gate reasons: title kill; fewer than 2 body snippets with concrete work verbs
- Role families: llm_application_engineer, enterprise_ai_architect, forward_deployed_ai_engineer, rag_knowledge_systems_engineer, ai_data_platform_engineer
- Reader promise: After reading this, the reader can design retrieval around freshness, permissions, indexing, and answer-quality checks.
- Failure mode: Retrieval looks plausible while stale, unpermissioned, or badly chunked sources drive bad answers.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, RAG ingestion pipeline
- Evidence: 3 body jobs, 1 strong body jobs, 3 duplicate-adjusted body jobs

### Top Body Evidence

- `job_800` `job_800.s014` strong_body_evidence: The AI Engineer - AWS Bedrock/AgentCore - Back End Dev - Context Engineering - Evaluation Harness - LLM will be working for us, Blackstone&, for an enterprise client in London AI Engineer - AWS Bedrock/AgentCore - Back End Dev - Context Engineering - Evaluation Harness - LLM Key Skills: AWS Bedrock AgentCore Back End Development experience Building evaluation...

### Weak / Rejected Evidence

- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object
- `job_835`  title_only_evidence: # McCabe & Barton - Python Developer/AI Engineer (Forward Deployed)
  - Problems: title evidence cannot support a top post; missing concrete system object; missing production/customer/security/data constraint
- `job_922` `job_922.s012` weak_body_evidence: The project is focused on the improvement of access to enterprise knowledge, documents, policies and operational data.
  - Problems: missing concrete work verb; missing concrete system object

## 6. Enterprise AI architecture is mostly integration architecture

- Gate: reject
- Title verdict: kill (1/15)
- Gate reasons: title kill
- Role families: rag_knowledge_systems_engineer, ai_data_platform_engineer, llm_application_engineer, enterprise_ai_architect, agentic_workflow_engineer
- Reader promise: After reading this, the reader can design retrieval around freshness, permissions, indexing, and answer-quality checks.
- Failure mode: Retrieval looks plausible while stale, unpermissioned, or badly chunked sources drive bad answers.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, RAG ingestion pipeline, tool schema
- Evidence: 3 body jobs, 2 strong body jobs, 3 duplicate-adjusted body jobs

### Top Body Evidence

- `job_769` `job_769.s012` strong_body_evidence: You'll combine your expertise in AI/ML engineering and software development to build and deploy cutting-edge generative AI and agentic systems across the financial services sector.
- `job_923` `job_923.s013` strong_body_evidence: They are looking for a Senior AI Engineer to take a hands-on role in the design and delivery of agentic AI systems, focused on workflow automation, intelligent decision support, and deep integration with an existing commercial platform.

### Weak / Rejected Evidence

- `job_922` `job_922.s012` weak_body_evidence: The project is focused on the improvement of access to enterprise knowledge, documents, policies and operational data.
  - Problems: missing concrete work verb; missing concrete system object
- `job_800`  extraction_failed_but_raw_body_strong: # AI Engineer - AWS Bedrock/AgentCore - Back End Dev - Context Engineering - Evaluation Harness - LLM
  - Problems: title evidence cannot support a top post; missing concrete work verb; raw body contains stronger evidence than extracted quote

## 7. Retrieval quality before vector database selection

- Gate: pass
- Title verdict: keep (13/15)
- Role families: rag_knowledge_systems_engineer, ai_data_platform_engineer, llm_application_engineer, enterprise_ai_architect, agentic_workflow_engineer
- Reader promise: After reading this, the reader can turn ambiguous LLM behavior into testable eval cases and release gates.
- Failure mode: The same product behavior changes silently because the expected behavior was never specified as eval data.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, RAG ingestion pipeline, tool schema
- Evidence: 4 body jobs, 1 strong body jobs, 4 duplicate-adjusted body jobs

### Top Body Evidence

- `job_837` `job_837.s014` strong_body_evidence: Key Responsibilities Design and deliver components of an enterprise GenAI platform Enable LLM hosting, RAG pipelines, and AI-driven workflows Support development of...

### Weak / Rejected Evidence

- `job_922` `job_922.s013` weak_body_evidence: The objective of this role is to build, design, and maintain the Data Ingestion, Data processing, indexing and RAG Pipelines.
  - Problems: missing production/customer/security/data constraint
- `job_879` `job_879.s015` weak_body_evidence: Embedding generative AI capabilities such as copilots and chatbots into everyday enterprise...
  - Problems: missing concrete work verb
- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object

## 8. Security and governance as AI product requirements

- Gate: reject
- Title verdict: kill (1/15)
- Gate reasons: title kill
- Role families: rag_knowledge_systems_engineer, ai_data_platform_engineer, llm_application_engineer, enterprise_ai_architect, agentic_workflow_engineer
- Reader promise: After reading this, the reader can design retrieval around freshness, permissions, indexing, and answer-quality checks.
- Failure mode: Retrieval looks plausible while stale, unpermissioned, or badly chunked sources drive bad answers.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, RAG ingestion pipeline, tool schema
- Evidence: 4 body jobs, 2 strong body jobs, 4 duplicate-adjusted body jobs

### Top Body Evidence

- `job_769` `job_769.s012` strong_body_evidence: You'll combine your expertise in AI/ML engineering and software development to build and deploy cutting-edge generative AI and agentic systems across the financial services sector.
- `job_800` `job_800.s014` strong_body_evidence: The AI Engineer - AWS Bedrock/AgentCore - Back End Dev - Context Engineering - Evaluation Harness - LLM will be working for us, Blackstone&, for an enterprise client in London AI Engineer - AWS Bedrock/AgentCore - Back End Dev - Context Engineering - Evaluation Harness - LLM Key Skills: AWS Bedrock AgentCore Back End Development experience Building evaluation...

### Weak / Rejected Evidence

- `job_922` `job_922.s012` weak_body_evidence: The project is focused on the improvement of access to enterprise knowledge, documents, policies and operational data.
  - Problems: missing concrete work verb; missing concrete system object
- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object

## 9. How to tell an AI-native role from AI garnish

- Gate: reject
- Title verdict: kill (1/15)
- Gate reasons: title kill; fewer than 3 distinct body-evidence jobs; fewer than 3 duplicate-adjusted body jobs
- Role families: agentic_workflow_engineer, llm_application_engineer, enterprise_ai_architect
- Reader promise: After reading this, the reader can translate vague AI demand into a concrete engineering artifact and acceptance criteria.
- Failure mode: The job spec says AI, but no one has translated that into ownership, constraints, or acceptance tests.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, tool schema
- Evidence: 2 body jobs, 1 strong body jobs, 2 duplicate-adjusted body jobs

### Top Body Evidence

- `job_923` `job_923.s013` strong_body_evidence: They are looking for a Senior AI Engineer to take a hands-on role in the design and delivery of agentic AI systems, focused on workflow automation, intelligent decision support, and deep integration with an existing commercial platform.

### Weak / Rejected Evidence

- `job_814`  title_only_evidence: # Specialist Computer Centres PLC - Agentic AI Engineer
  - Problems: title evidence cannot support a top post; missing concrete work verb; missing concrete system object; missing production/customer/security/data constraint
- `job_825`  title_only_evidence: # 83Zero Ltd - Software Engineer (AI+Fullstack)
  - Problems: title evidence cannot support a top post; missing concrete work verb; missing concrete system object; missing production/customer/security/data constraint
- `job_826` `job_826.s013` weak_body_evidence: This is a 12 month temporary contract to start ASAP Day rate: Competitive Market rate Key Responsibilities Building and evolving AI-powered services using Python Designing and implementing evaluation frameworks for LLM-based systems Improving output quality through structured evals rather than purely code changes Applying techniques...
  - Problems: missing production/customer/security/data constraint

## 10. The GenAI platform post nobody writes: release, monitor, cost, rollback

- Gate: note_only
- Title verdict: keep (11/15)
- Gate reasons: no strong body evidence
- Role families: llm_application_engineer, ai_data_platform_engineer, forward_deployed_ai_engineer, false_positive_non_ai, rag_knowledge_systems_engineer, enterprise_ai_architect
- Reader promise: After reading this, the reader can ship an LLM-backed feature with traces, deployment gates, and a rollback path.
- Failure mode: A demo-quality LLM feature ships without a way to detect or reverse degraded behavior.
- Artifact(s): permission matrix, audit event schema, eval harness, trace log, rollback checklist, RAG ingestion pipeline
- Evidence: 4 body jobs, 0 strong body jobs, 4 duplicate-adjusted body jobs

### Top Body Evidence

_None._

### Weak / Rejected Evidence

- `job_827` `job_827.s011` weak_body_evidence: The work sits at the intersection of engineering and AI, focused on improving relevance, quality, and reliability in a live, customer-facing system.
  - Problems: missing concrete work verb; missing concrete system object
- `job_826` `job_826.s013` weak_body_evidence: This is a 12 month temporary contract to start ASAP Day rate: Competitive Market rate Key Responsibilities Building and evolving AI-powered services using Python Designing and implementing evaluation frameworks for LLM-based systems Improving output quality through structured evals rather than purely code changes Applying techniques...
  - Problems: missing production/customer/security/data constraint
- `job_936` `job_936.s012` false_positive_non_ai_engineering: This scheme plays a critical role in improving river water quality and environmental sustainability within a protected catchment area.Working on behalf of a regional water authority, the project includes the design and construction of a...
  - Problems: missing concrete system object; missing production/customer/security/data constraint; false-positive non-AI engineering risk
- `job_922` `job_922.s012` weak_body_evidence: The project is focused on the improvement of access to enterprise knowledge, documents, policies and operational data.
  - Problems: missing concrete work verb; missing concrete system object

### Counterexamples

- `job_936` `job_936.s012` false_positive_non_ai_engineering: This scheme plays a critical role in improving river water quality and environmental sustainability within a protected catchment area.Working on behalf of a regional water authority, the project includes the design and construction of a...
  - Problems: missing concrete system object; missing production/customer/security/data constraint; false-positive non-AI engineering risk

