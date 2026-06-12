# Curated Blog Posts Needed - 2026-06-07

This is the human-usable shortlist from the refreshed index. It keeps the generated
theme IDs but filters out obvious false positives from broad words such as
"quality", "customer", or "engineer" where the posting was not actually
AI-adjacent.

## 1. Build the LLM feature like production software, not a demo

- Thesis: The market is asking for engineers who can ship AI-backed features with
  API boundaries, tests/evals, logging, deployment, and rollback.
- Supported themes: `t01`, `t04`
- Job evidence:
  - `job_923` Nicoll Curtin Technology: "design and delivery of agentic AI systems, focused on workflow automation, intelligent decision support, and deep integration with an existing commercial platform."
  - `job_826` Project Recruit: "Building and evolving AI-powered services using Python" and "evaluation frameworks for LLM-based systems."
  - `job_827` Hamilton Barnes: "improving relevance, quality, and reliability in a live, customer-facing system."
  - `job_800` AWS Bedrock/AgentCore role: title explicitly combines "Back End Dev", "Context Engineering", "Evaluation Harness", and "LLM."
- Concrete example needed: a small LLM feature with API contract, eval set,
  trace logs, deploy path, and rollback criteria.

## 2. Agentic workflows need product boundaries before autonomy

- Thesis: The useful agentic skill is not "make an agent"; it is constraining
  tools, state, permissions, retries, and human review around a real workflow.
- Supported themes: `t01`, `t05`
- Job evidence:
  - `job_923` Nicoll Curtin Technology: "agentic AI systems" for "workflow automation" and "intelligent decision support."
  - `job_769` AI Engineer: "build and deploy cutting-edge generative AI and agentic systems across the financial services sector."
  - `job_814` Specialist Computer Centres: "Design and implement agent-based AI solutions using Bedrock agent frameworks."
  - `job_805` TEKsystems: "agentic/AI-driven architectures" with backend services and secure engineering practices.
- Concrete example needed: one workflow with tool schemas, audit log,
  failure states, and a human approval gate.

## 3. Context engineering is the test surface

- Thesis: Context design, retrieval inputs, and evals are where LLM quality becomes
  observable and debuggable.
- Supported themes: `t04`, `t06`
- Job evidence:
  - `job_800` AWS Bedrock/AgentCore role: "Context Engineering" and "Evaluation Harness" are in the title.
  - `job_826` Project Recruit: "evaluation frameworks for LLM-based systems" and "Improving output quality through structured evals."
  - `job_827` Hamilton Barnes: "improving relevance, quality, and reliability in a live, customer-facing system."
  - `job_922` Square One Resources: "Data Ingestion, Data processing, indexing and RAG Pipelines."
- Concrete example needed: context pack design, regression evals, failed
  retrieval examples, and traces showing why an answer changed.

## 4. AI data engineering is still data engineering

- Thesis: A meaningful slice of AI hiring is data foundations: pipelines, indexing,
  platforms, freshness, access, and analytics foundations.
- Supported themes: `t03`, `t06`
- Job evidence:
  - `job_802` Specialist Computer Centres: "scalable batch and streaming data systems, enabling advanced analytics and AI use cases."
  - `job_922` Square One Resources: "Data Ingestion, Data processing, indexing and RAG Pipelines."
  - `job_924` Robert Half: "modernise data platforms and build scalable foundations for AI, analytics and Business..."
  - `job_884` Montash: Principal Data Architect role explicitly framed around "Snowflake, Azure Fabric, AI."
- Concrete example needed: ingestion pipeline, freshness check, data contract,
  access model, and an AI consumer endpoint.

## 5. Enterprise AI architecture is mostly integration architecture

- Thesis: Enterprise AI roles mostly ask for the ability to fit AI into existing
  systems, identity, governance, cloud platforms, APIs, and delivery constraints.
- Supported themes: `t02`, `t01`
- Job evidence:
  - `job_928` TechShack: "designing and deploying production-grade AI and Agentic AI solutions within AWS."
  - `job_806` Hydrogen Group: "intersection of AI engineering, architecture and client delivery."
  - `job_769` AI Engineer: "architect AI solutions" and embed them within enterprise/financial-services context.
  - `job_880` AI & Agile Tooling Architect: "bridge AI innovation with Agile delivery practices" using automation, analytics, integrated toolchains, and GenAI.
- Concrete example needed: integration architecture diagram, API boundary,
  identity/access model, deployment target, and stakeholder handoff.

## 6. Forward-deployed AI without theatre

- Thesis: The credible FDE/solutions signal is discovery through production
  handoff, not demo magic.
- Supported themes: `t05`, `t02`
- Job evidence:
  - `job_835` McCabe & Barton: "Python Developer/AI Engineer (Forward Deployed)."
  - `job_806` Hydrogen Group: "AI engineering, architecture and client delivery."
  - `job_663` Linear Solutions Engineer: "deep-dive demos, proof-of-concepts, security and architecture reviews, and integration workshops."
  - `job_800` AWS Bedrock/AgentCore role: enterprise client, backend development, context engineering, and eval harness.
- Concrete example needed: discovery notes, prototype, integration map,
  acceptance criteria, security review, and production handoff checklist.

## 7. Retrieval quality before vector database selection

- Thesis: The market signal is not "which vector DB"; it is ingestion, indexing,
  grounding, freshness, evals, and failure analysis.
- Supported themes: `t06`, `t04`
- Job evidence:
  - `job_922` Square One Resources: "Data Ingestion, Data processing, indexing and RAG Pipelines."
  - `job_837` GCS: "Enable LLM hosting, RAG pipelines, and AI-driven workflows."
  - `job_879` Henderson Scott: "copilots and chatbots" embedded into enterprise workflows.
  - `job_826` Project Recruit: structured evals for LLM systems.
- Concrete example needed: messy document corpus, indexing pipeline, retrieval
  eval cases, stale-document failure, and answer-quality regression.

## 8. Security and governance as AI product requirements

- Thesis: In enterprise AI, permissions, audit, compliance, and sensitive data
  are product design requirements, not late-stage controls.
- Supported themes: `t02`, `t05`
- Job evidence:
  - `job_846` Stealth IT Consulting: "data governance, and responsible AI principles" plus complex multi-stakeholder setting.
  - `job_663` Linear Solutions Engineer: "security and architecture reviews" and integration workshops.
  - `job_922` Square One Resources: enterprise knowledge, documents, policies, and operational data.
  - `job_769` AI Engineer: financial-services sector context.
- Concrete example needed: permission matrix, audit events, data classification,
  prompt/context redaction, and review workflow.

## 9. How to tell an AI-native role from AI garnish

- Thesis: The refreshed jobs contain both concrete AI systems work and title-only
  AI packaging; a useful post would show how to tell the difference.
- Supported themes: `t07`, `t01`
- Job evidence:
  - Strong signal: `job_923` asks for agentic workflow automation and deep platform integration.
  - Strong signal: `job_826` asks for AI-powered services and LLM eval frameworks.
  - Weak signal: `job_825` / `job_823` / `job_821` are "Software Engineer (AI+Fullstack)" postings where the clean extracted snippet was title-level.
  - Weak signal: `job_801` "AI Engineer" was mostly title-level in the index despite an inference ranking label.
- Concrete example needed: rubric with title-only, stack-only, concrete
  responsibility, production constraint, and domain constraint levels.

## 10. AI product ownership: from vague transformation brief to buildable backlog

- Thesis: Several postings blur product, architecture, and engineering ownership;
  a strong post would show how to turn an AI transformation request into a
  buildable backlog.
- Supported themes: `t02`, `t03`, `t05`
- Job evidence:
  - `job_838` AI Product Lead: "bridge the gap between business strategy and AI delivery."
  - `job_841` Product Owner: "AI conversational analytics programme" and "AI-enabled insights platform."
  - `job_846` AI Product Manager: product strategy in AI/ML/data-heavy environments with governance and responsible AI.
  - `job_880` AI & Agile Tooling Architect: improve productivity, reporting, decision-making, and delivery efficiency through integrated AI/tooling.
- Concrete example needed: problem framing, workflow inventory, assumptions log,
  risk register, backlog slices, and measurable acceptance criteria.
