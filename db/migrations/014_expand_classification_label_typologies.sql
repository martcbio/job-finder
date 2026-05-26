ALTER TABLE job_search.job_classification_labels
  DROP CONSTRAINT job_classification_labels_label_check;

ALTER TABLE job_search.job_classification_labels
  ADD CONSTRAINT job_classification_labels_label_check
  CHECK (
    label IN (
      'agentic_engineer',
      'agentic_architect',
      'rag_enterprise',
      'fde',
      'solutions_engineer',
      'inference_engineer',
      'ml_platform',
      'backend_product_engineering',
      'developer_tools',
      'data_engineering',
      'security_ai',
      'founding_engineer',
      'ai_product_manager',
      'non_engineering',
      'staffing_agency',
      'index_not_job',
      'ai_enablement',
      'internal_ai_tooling',
      'business_automation_ai',
      'ai_operations',
      'workplace_ai',
      'ai_adoption_transformation'
    )
  );
