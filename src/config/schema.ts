import { z } from "zod/v4";
import { SEARCH_DOMAINS, SEARCH_KEYWORDS } from "./search";

const OptionalUrlEnv = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const ConfigSchema = z.object({
  keywords: z.array(z.string()),
  domains: z.array(z.string()),
  notionDatabaseId: z.string().default(""),
  notionToken: z.string().default(""),
  jinaApiKey: z.string().default(""),
  jinaBaseUrl: z.string(),
  openrouterApiKey: z.string().default(""),
  llmModel: z.string().default("google/gemini-2.5-flash"),
  slackWebhookUrl: OptionalUrlEnv,
  enableAtsEnrichment: z.boolean().default(true),
});

export type JobFinderConfig = z.infer<typeof ConfigSchema>;

export const config: Readonly<JobFinderConfig> = Object.freeze(
  ConfigSchema.parse({
    keywords: SEARCH_KEYWORDS,
    domains: SEARCH_DOMAINS,
    notionDatabaseId: process.env.NOTION_DATABASE_ID,
    notionToken: process.env.NOTION_TOKEN,
    jinaApiKey: process.env.JINA_API_KEY,
    jinaBaseUrl: "https://r.jina.ai",
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    llmModel: process.env.LLM_MODEL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    enableAtsEnrichment: process.env.ENABLE_ATS_ENRICHMENT
      ? process.env.ENABLE_ATS_ENRICHMENT === "true"
      : undefined,
  }),
);
