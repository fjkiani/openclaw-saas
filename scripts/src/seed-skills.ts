import { db, skillsTable } from "@workspace/db";

const skills = [
  // BioTech Research
  { name: "literature-search", slug: "literature-search", description: "Search PubMed, bioRxiv, and CrossRef for peer-reviewed literature. Returns structured citations with abstracts.", category: "BioTech Research", stars: 4812, installs: 18400, featured: true, tags: ["research", "pubmed", "literature"] },
  { name: "protein-structure-query", slug: "protein-structure-query", description: "Query the RCSB PDB for protein structures, ligands, and experimental metadata.", category: "BioTech Research", stars: 3201, installs: 9870, featured: false, tags: ["protein", "pdb", "structure"] },
  { name: "crispr-offtarget-analysis", slug: "crispr-offtarget-analysis", description: "Predict CRISPR-Cas9 off-target sites using the Cas-OFFinder algorithm wrapper.", category: "BioTech Research", stars: 2834, installs: 7200, featured: true, tags: ["crispr", "genomics", "analysis"] },
  { name: "ncbi-gene-lookup", slug: "ncbi-gene-lookup", description: "Retrieve gene summaries, aliases, and orthologs from the NCBI Gene database.", category: "BioTech Research", stars: 2100, installs: 5600, featured: false, tags: ["ncbi", "gene", "genomics"] },
  { name: "drug-interaction-checker", slug: "drug-interaction-checker", description: "Check drug-drug and drug-target interactions using DrugBank and ChEMBL.", category: "BioTech Research", stars: 3450, installs: 12100, featured: false, tags: ["drug", "interaction", "chembl"] },

  // DevOps & Automation
  { name: "github-pr-review", slug: "github-pr-review", description: "Automatically review GitHub pull requests, check for style issues, and post review comments.", category: "DevOps", stars: 9210, installs: 41300, featured: true, tags: ["github", "pr", "review"] },
  { name: "terraform-plan-analyzer", slug: "terraform-plan-analyzer", description: "Parse and explain Terraform plan output. Identify risky changes and suggest safety checks.", category: "DevOps", stars: 5670, installs: 22000, featured: false, tags: ["terraform", "iac", "infrastructure"] },
  { name: "kubernetes-troubleshoot", slug: "kubernetes-troubleshoot", description: "Diagnose pod failures, CrashLoopBackOff issues, and resource quotas from kubectl output.", category: "DevOps", stars: 7123, installs: 28900, featured: true, tags: ["kubernetes", "k8s", "debugging"] },
  { name: "docker-compose-generator", slug: "docker-compose-generator", description: "Generate Docker Compose files from natural language service descriptions.", category: "DevOps", stars: 4321, installs: 18700, featured: false, tags: ["docker", "compose", "generator"] },
  { name: "ci-pipeline-debugger", slug: "ci-pipeline-debugger", description: "Analyze CI/CD pipeline failures from GitHub Actions, GitLab CI, or Jenkins logs.", category: "DevOps", stars: 3890, installs: 14500, featured: false, tags: ["ci", "cd", "debugging"] },
  { name: "aws-cost-analyzer", slug: "aws-cost-analyzer", description: "Analyze AWS Cost Explorer reports and recommend cost optimization strategies.", category: "DevOps", stars: 6100, installs: 24200, featured: true, tags: ["aws", "cost", "cloud"] },

  // Finance & Analysis
  { name: "earnings-call-summarizer", slug: "earnings-call-summarizer", description: "Summarize SEC earnings call transcripts. Extract guidance, risks, and key metrics.", category: "Finance", stars: 5430, installs: 19800, featured: true, tags: ["finance", "sec", "earnings"] },
  { name: "stock-screener", slug: "stock-screener", description: "Screen stocks by fundamental and technical criteria using Yahoo Finance data.", category: "Finance", stars: 4120, installs: 16300, featured: false, tags: ["stocks", "screener", "finance"] },
  { name: "crypto-portfolio-tracker", slug: "crypto-portfolio-tracker", description: "Track cryptocurrency portfolio performance with live CoinGecko price feeds.", category: "Finance", stars: 3780, installs: 14100, featured: false, tags: ["crypto", "portfolio", "defi"] },
  { name: "financial-model-builder", slug: "financial-model-builder", description: "Build DCF and comparable company models from raw financial statement data.", category: "Finance", stars: 2900, installs: 9800, featured: false, tags: ["dcf", "model", "valuation"] },

  // Legal Research
  { name: "case-law-search", slug: "case-law-search", description: "Search US federal and state case law via CourtListener and Casetext APIs.", category: "Legal", stars: 3210, installs: 11400, featured: true, tags: ["legal", "caselaw", "search"] },
  { name: "contract-review", slug: "contract-review", description: "Review contracts for common issues: missing clauses, ambiguous language, and risky terms.", category: "Legal", stars: 4560, installs: 17200, featured: true, tags: ["contract", "review", "legal"] },
  { name: "patent-search", slug: "patent-search", description: "Search USPTO and EPO patent databases. Analyze claims and prior art.", category: "Legal", stars: 2700, installs: 8900, featured: false, tags: ["patent", "ip", "uspto"] },
  { name: "gdpr-compliance-check", slug: "gdpr-compliance-check", description: "Review policies and data flows for GDPR compliance gaps and remediation steps.", category: "Legal", stars: 3100, installs: 11100, featured: false, tags: ["gdpr", "compliance", "privacy"] },

  // Data & Analytics
  { name: "pandas-dataframe-analyst", slug: "pandas-dataframe-analyst", description: "Load, clean, and analyze tabular data with pandas. Generate insights and charts.", category: "Data Analytics", stars: 8900, installs: 38700, featured: true, tags: ["pandas", "data", "analysis"] },
  { name: "sql-query-optimizer", slug: "sql-query-optimizer", description: "Analyze and rewrite SQL queries for performance. Explain execution plans.", category: "Data Analytics", stars: 6720, installs: 26300, featured: false, tags: ["sql", "database", "performance"] },
  { name: "data-pipeline-builder", slug: "data-pipeline-builder", description: "Build ETL pipelines with Python and dbt. Auto-generate transformations from schema.", category: "Data Analytics", stars: 4890, installs: 18200, featured: false, tags: ["etl", "dbt", "pipeline"] },
  { name: "anomaly-detector", slug: "anomaly-detector", description: "Detect statistical anomalies in time-series data using Prophet and Isolation Forest.", category: "Data Analytics", stars: 3450, installs: 12300, featured: false, tags: ["anomaly", "timeseries", "ml"] },

  // Writing & Content
  { name: "technical-doc-writer", slug: "technical-doc-writer", description: "Generate API documentation, README files, and technical guides from code and schemas.", category: "Writing", stars: 7230, installs: 29100, featured: true, tags: ["docs", "readme", "technical"] },
  { name: "blog-post-generator", slug: "blog-post-generator", description: "Create SEO-optimized blog posts with structured outlines and keyword placement.", category: "Writing", stars: 5410, installs: 21400, featured: false, tags: ["blog", "seo", "content"] },
  { name: "email-composer", slug: "email-composer", description: "Draft professional emails for various business contexts. Adapts tone to recipient.", category: "Writing", stars: 4100, installs: 16700, featured: false, tags: ["email", "communication", "business"] },

  // Web Scraping
  { name: "playwright-scraper", slug: "playwright-scraper", description: "Scrape JavaScript-heavy websites with Playwright. Extract structured data from pages.", category: "Web Scraping", stars: 6340, installs: 24800, featured: true, tags: ["playwright", "scraping", "web"] },
  { name: "rss-monitor", slug: "rss-monitor", description: "Monitor RSS feeds and news sources. Alert on keywords, topics, or entities.", category: "Web Scraping", stars: 3210, installs: 12100, featured: false, tags: ["rss", "news", "monitor"] },

  // Communication
  { name: "slack-notifier", slug: "slack-notifier", description: "Send formatted notifications to Slack channels with rich attachments and action buttons.", category: "Communication", stars: 8120, installs: 34200, featured: true, tags: ["slack", "notifications", "webhook"] },
  { name: "email-inbox-triage", slug: "email-inbox-triage", description: "Triage email inboxes by urgency and topic. Draft reply suggestions.", category: "Communication", stars: 4780, installs: 18900, featured: false, tags: ["email", "inbox", "triage"] },
];

async function seed() {
  console.log("Seeding skills catalog...");

  const existing = await db.select({ id: skillsTable.id }).from(skillsTable);
  if (existing.length > 0) {
    console.log(`Skills already seeded (${existing.length} records). Skipping.`);
    return;
  }

  await db.insert(skillsTable).values(
    skills.map((s) => ({
      name: s.name,
      slug: s.slug,
      description: s.description,
      category: s.category,
      stars: s.stars,
      installs: s.installs,
      featured: s.featured,
      tags: s.tags,
    }))
  );

  console.log(`Seeded ${skills.length} skills successfully.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
