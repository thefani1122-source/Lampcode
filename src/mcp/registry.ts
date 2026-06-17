// ── MCP Provider Registry ─────────────────────────────────────────────────────
// 27 providers: 8 with real hosted MCP servers (supportsRealMCP: true),
// the rest use webhook URLs or are prompt/credential-only.

export interface McpProvider {
  slug: string;
  name: string;
  category: "database" | "automation" | "devtools" | "communication" | "payments" | "analytics" | "content" | "storage";
  icon: string; // emoji
  description: string;
  mcpServerUrl: string | null | ((creds: Record<string, string>) => string);
  authType: "bearer_token" | "api_key" | "webhook_url" | "basic_auth";
  credentialFields: Array<{
    key: string;
    label: string;
    type: "text" | "password" | "url";
    placeholder?: string;
    help?: string;
    optional?: boolean;
  }>;
  supportsRealMCP: boolean;
  promptRule?: string;
}

export const MCP_REGISTRY: Record<string, McpProvider> = {
  // ── Real MCP providers (supportsRealMCP: true) ────────────────────────────

  github: {
    slug: "github",
    name: "GitHub",
    category: "devtools",
    icon: "🐙",
    description: "Create repos, manage issues, open pull requests, and more via the GitHub MCP server",
    mcpServerUrl: "https://api.githubcopilot.com/mcp/",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "github_token",
        label: "Personal Access Token",
        type: "password",
        placeholder: "ghp_...",
        help: "Create at github.com/settings/tokens — needs repo and workflow scopes",
      },
    ],
    supportsRealMCP: true,
  },

  stripe: {
    slug: "stripe",
    name: "Stripe",
    category: "payments",
    icon: "💳",
    description: "Manage payments, customers, subscriptions, and products via the Stripe MCP server",
    mcpServerUrl: "https://mcp.stripe.com",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "stripe_key",
        label: "Stripe API Key",
        type: "password",
        placeholder: "sk_live_... or rk_live_...",
        help: "Use a Restricted Key from dashboard.stripe.com/apikeys for least privilege",
      },
    ],
    supportsRealMCP: true,
  },

  linear: {
    slug: "linear",
    name: "Linear",
    category: "devtools",
    icon: "📋",
    description: "Create and manage issues, projects, and cycles via the Linear MCP server",
    mcpServerUrl: "https://mcp.linear.app/sse",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "linear_key",
        label: "Linear API Key",
        type: "password",
        placeholder: "lin_api_...",
        help: "Create at linear.app/settings/api under Personal API Keys",
      },
    ],
    supportsRealMCP: true,
  },

  vercel: {
    slug: "vercel",
    name: "Vercel",
    category: "devtools",
    icon: "▲",
    description: "Deploy projects, manage domains, and view deployments via the Vercel MCP server",
    mcpServerUrl: "https://mcp.vercel.com",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "vercel_token",
        label: "Vercel Account Token",
        type: "password",
        placeholder: "...",
        help: "Create at vercel.com/account/tokens",
      },
    ],
    supportsRealMCP: true,
  },

  cloudflare: {
    slug: "cloudflare",
    name: "Cloudflare",
    category: "devtools",
    icon: "🌥️",
    description: "Manage Workers, KV, R2, and DNS records via the Cloudflare MCP server",
    mcpServerUrl: "https://mcp.cloudflare.com/sse",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "cf_token",
        label: "Cloudflare API Token",
        type: "password",
        placeholder: "...",
        help: "Create at dash.cloudflare.com/profile/api-tokens",
      },
    ],
    supportsRealMCP: true,
  },

  sentry: {
    slug: "sentry",
    name: "Sentry",
    category: "devtools",
    icon: "🪲",
    description: "Query errors, manage issues, and view performance data via the Sentry MCP server",
    mcpServerUrl: "https://mcp.sentry.dev/mcp",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "sentry_token",
        label: "Sentry Internal Integration Token",
        type: "password",
        placeholder: "...",
        help: "Create an Internal Integration at sentry.io/settings/ → Integrations",
      },
    ],
    supportsRealMCP: true,
  },

  notion: {
    slug: "notion",
    name: "Notion",
    category: "content",
    icon: "📝",
    description: "Read and write pages, databases, and blocks via the Notion MCP server",
    mcpServerUrl: "https://mcp.notion.com/mcp",
    authType: "bearer_token",
    credentialFields: [
      {
        key: "notion_token",
        label: "Notion Integration Token",
        type: "password",
        placeholder: "secret_...",
        help: "Create an integration at notion.com/profile/integrations and share pages with it",
      },
    ],
    supportsRealMCP: true,
  },

  n8n: {
    slug: "n8n",
    name: "n8n",
    category: "automation",
    icon: "⚙️",
    description: "Trigger and manage n8n workflows via your self-hosted n8n MCP endpoint",
    mcpServerUrl: (creds: Record<string, string>) =>
      `${(creds["instance_url"] ?? "").replace(/\/+$/, "")}/mcp`,
    authType: "bearer_token",
    credentialFields: [
      {
        key: "instance_url",
        label: "n8n Instance URL",
        type: "url",
        placeholder: "https://n8n.yourdomain.com",
        help: "The public URL of your n8n instance (must be accessible from the internet)",
      },
      {
        key: "api_key",
        label: "n8n API Key",
        type: "password",
        placeholder: "n8n_...",
        help: "Create at your n8n instance → Settings → API",
      },
    ],
    supportsRealMCP: true,
  },

  // ── Webhook / credential-only providers (supportsRealMCP: false) ──────────

  make: {
    slug: "make",
    name: "Make",
    category: "automation",
    icon: "🔧",
    description: "Trigger Make (formerly Integromat) scenarios via incoming webhooks",
    mcpServerUrl: null,
    authType: "webhook_url",
    credentialFields: [
      {
        key: "webhook_url",
        label: "Make Webhook URL",
        type: "url",
        placeholder: "https://hook.eu1.make.com/...",
        help: "Add a Webhook trigger to your scenario and copy the URL here",
      },
    ],
    supportsRealMCP: false,
    promptRule: "To trigger Make: POST to the user's webhook_url with a JSON body describing the action.",
  },

  zapier: {
    slug: "zapier",
    name: "Zapier",
    category: "automation",
    icon: "⚡",
    description: "Trigger Zapier Zaps via incoming webhooks",
    mcpServerUrl: null,
    authType: "webhook_url",
    credentialFields: [
      {
        key: "webhook_url",
        label: "Zapier Webhook URL",
        type: "url",
        placeholder: "https://hooks.zapier.com/hooks/catch/...",
        help: "Use a Webhooks by Zapier trigger and copy the URL here",
      },
    ],
    supportsRealMCP: false,
    promptRule: "To trigger Zapier: POST to the user's webhook_url with a JSON body describing the action.",
  },

  slack: {
    slug: "slack",
    name: "Slack",
    category: "communication",
    icon: "💬",
    description: "Send messages to Slack channels via an incoming webhook",
    mcpServerUrl: null,
    authType: "webhook_url",
    credentialFields: [
      {
        key: "webhook_url",
        label: "Slack Incoming Webhook URL",
        type: "url",
        placeholder: "https://hooks.slack.com/services/...",
        help: "Create a Slack app at api.slack.com/apps, add Incoming Webhooks, and copy the URL",
      },
    ],
    supportsRealMCP: false,
    promptRule: "To post to Slack: POST to webhook_url with JSON {text: '...'}.",
  },

  shopify: {
    slug: "shopify",
    name: "Shopify",
    category: "content",
    icon: "🛍️",
    description: "Manage Shopify store products, orders, and customers via the Admin API",
    mcpServerUrl: null,
    authType: "bearer_token",
    credentialFields: [
      {
        key: "store_url",
        label: "Shopify Store URL",
        type: "url",
        placeholder: "https://yourstore.myshopify.com",
        help: "Your Shopify store URL",
      },
      {
        key: "access_token",
        label: "Admin API Access Token",
        type: "password",
        placeholder: "shpat_...",
        help: "Create a Custom App in Shopify Admin → Settings → Apps and sales channels",
      },
    ],
    supportsRealMCP: false,
  },

  wordpress: {
    slug: "wordpress",
    name: "WordPress",
    category: "content",
    icon: "📰",
    description: "Create and manage WordPress posts, pages, and media via the REST API",
    mcpServerUrl: null,
    authType: "basic_auth",
    credentialFields: [
      {
        key: "site_url",
        label: "WordPress Site URL",
        type: "url",
        placeholder: "https://yoursite.com",
        help: "The root URL of your WordPress site",
      },
      {
        key: "username",
        label: "WordPress Username",
        type: "text",
        placeholder: "admin",
        help: "Your WordPress admin username",
      },
      {
        key: "app_password",
        label: "Application Password",
        type: "password",
        placeholder: "xxxx xxxx xxxx xxxx xxxx xxxx",
        help: "Create at WordPress Admin → Users → Profile → Application Passwords",
      },
    ],
    supportsRealMCP: false,
  },

  airtable: {
    slug: "airtable",
    name: "Airtable",
    category: "database",
    icon: "📊",
    description: "Read and write Airtable bases, tables, and records via the REST API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "api_key",
        label: "Airtable Personal Access Token",
        type: "password",
        placeholder: "pat...",
        help: "Create at airtable.com/account under Personal Access Tokens",
      },
    ],
    supportsRealMCP: false,
  },

  hubspot: {
    slug: "hubspot",
    name: "HubSpot",
    category: "analytics",
    icon: "🧲",
    description: "Manage CRM contacts, deals, and companies via the HubSpot API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "api_key",
        label: "HubSpot Private App Access Token",
        type: "password",
        placeholder: "pat-na1-...",
        help: "Create a Private App at app.hubspot.com/settings/integrations/private-apps",
      },
    ],
    supportsRealMCP: false,
  },

  mailchimp: {
    slug: "mailchimp",
    name: "Mailchimp",
    category: "communication",
    icon: "🐵",
    description: "Manage audiences, campaigns, and subscribers via the Mailchimp API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "api_key",
        label: "Mailchimp API Key",
        type: "password",
        placeholder: "xxxxxxxxxxxxxxxx-us1",
        help: "Find at mailchimp.com/account → Extras → API keys",
      },
    ],
    supportsRealMCP: false,
  },

  resend: {
    slug: "resend",
    name: "Resend",
    category: "communication",
    icon: "📨",
    description: "Transactional email sending via the Resend API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "api_key",
        label: "Resend API Key",
        type: "password",
        placeholder: "re_...",
        help: "Create an API key at resend.com/api-keys",
      },
    ],
    supportsRealMCP: false,
  },

  twilio: {
    slug: "twilio",
    name: "Twilio",
    category: "communication",
    icon: "📱",
    description: "Send SMS, WhatsApp messages, and make calls via the Twilio API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "account_sid",
        label: "Account SID",
        type: "text",
        placeholder: "ACxxxxxxxxxxxxxxxx",
        help: "Found on your Twilio Console dashboard",
      },
      {
        key: "auth_token",
        label: "Auth Token",
        type: "password",
        placeholder: "...",
        help: "Found on your Twilio Console dashboard",
      },
      {
        key: "phone_number",
        label: "Twilio Phone Number",
        type: "text",
        placeholder: "+15551234567",
        help: "Your Twilio phone number in E.164 format (optional)",
        optional: true,
      },
    ],
    supportsRealMCP: false,
  },

  sendgrid: {
    slug: "sendgrid",
    name: "SendGrid",
    category: "communication",
    icon: "📧",
    description: "Send transactional and marketing email via the SendGrid API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "api_key",
        label: "SendGrid API Key",
        type: "password",
        placeholder: "SG...",
        help: "Create at app.sendgrid.com/settings/api_keys",
      },
    ],
    supportsRealMCP: false,
  },

  figma: {
    slug: "figma",
    name: "Figma",
    category: "content",
    icon: "🎨",
    description: "Read Figma files, components, and design tokens via the Figma API",
    mcpServerUrl: null,
    authType: "bearer_token",
    credentialFields: [
      {
        key: "access_token",
        label: "Figma Personal Access Token",
        type: "password",
        placeholder: "figd_...",
        help: "Create at figma.com/settings → Account → Personal access tokens",
      },
    ],
    supportsRealMCP: false,
  },

  jira: {
    slug: "jira",
    name: "Jira",
    category: "devtools",
    icon: "🎫",
    description: "Create and manage Jira issues, sprints, and projects via the Atlassian API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "site_url",
        label: "Jira Site URL",
        type: "url",
        placeholder: "https://yourcompany.atlassian.net",
        help: "Your Atlassian cloud site URL",
      },
      {
        key: "email",
        label: "Atlassian Account Email",
        type: "text",
        placeholder: "you@company.com",
        help: "The email address of your Atlassian account",
      },
      {
        key: "api_token",
        label: "Atlassian API Token",
        type: "password",
        placeholder: "...",
        help: "Create at id.atlassian.com/manage-profile/security/api-tokens",
      },
    ],
    supportsRealMCP: false,
  },

  openai: {
    slug: "openai",
    name: "OpenAI",
    category: "devtools",
    icon: "🤖",
    description: "Use OpenAI models (GPT-4o, o1, DALL·E, Whisper) in generated apps",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "api_key",
        label: "OpenAI API Key",
        type: "password",
        placeholder: "sk-...",
        help: "Create at platform.openai.com/api-keys",
      },
    ],
    supportsRealMCP: false,
  },

  mixpanel: {
    slug: "mixpanel",
    name: "Mixpanel",
    category: "analytics",
    icon: "📈",
    description: "Track events and query analytics data via the Mixpanel API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "project_token",
        label: "Mixpanel Project Token",
        type: "password",
        placeholder: "...",
        help: "Find at mixpanel.com → Project Settings → Access Keys",
      },
    ],
    supportsRealMCP: false,
  },

  segment: {
    slug: "segment",
    name: "Segment",
    category: "analytics",
    icon: "📡",
    description: "Send events and identify users via the Segment tracking API",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "write_key",
        label: "Segment Write Key",
        type: "password",
        placeholder: "...",
        help: "Find at app.segment.com → Sources → Your Source → Settings → API Keys",
      },
    ],
    supportsRealMCP: false,
  },

  mongodb: {
    slug: "mongodb",
    name: "MongoDB Atlas",
    category: "database",
    icon: "🍃",
    description: "MongoDB Atlas database for generated apps — connect via connection string",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "connection_string",
        label: "MongoDB Atlas Connection String",
        type: "password",
        placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/dbname",
        help: "Get from cloud.mongodb.com → Database → Connect → Drivers",
      },
    ],
    supportsRealMCP: false,
  },

  neon: {
    slug: "neon",
    name: "Neon",
    category: "database",
    icon: "⚡",
    description: "Neon serverless Postgres — connect generated apps to your Neon database",
    mcpServerUrl: null,
    authType: "api_key",
    credentialFields: [
      {
        key: "database_url",
        label: "Neon Database URL",
        type: "password",
        placeholder: "postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb",
        help: "Find at console.neon.tech → Project → Connection Details",
      },
    ],
    supportsRealMCP: false,
  },

  railway: {
    slug: "railway",
    name: "Railway",
    category: "devtools",
    icon: "🚂",
    description: "Deploy to Railway from generated apps",
    mcpServerUrl: null,
    authType: "bearer_token",
    credentialFields: [
      {
        key: "api_token",
        label: "Railway API Token",
        type: "password",
        placeholder: "...",
        help: "Create at railway.app/account/tokens",
      },
    ],
    supportsRealMCP: false,
  },
};

export function getMcpProvider(slug: string): McpProvider | undefined {
  return MCP_REGISTRY[slug];
}

export function resolveServerUrl(
  provider: McpProvider,
  creds: Record<string, string>,
): string | null {
  if (provider.mcpServerUrl === null) return null;
  if (typeof provider.mcpServerUrl === "function") {
    return provider.mcpServerUrl(creds);
  }
  return provider.mcpServerUrl;
}
