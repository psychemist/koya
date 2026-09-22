import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { getRunState } from './tools/get-run-state.ts';
import { saveIcp } from './tools/save-icp.ts';
import { discoverCompanies } from './tools/discover-companies.ts';
import { scrapeCompanySite } from './tools/scrape-company-site.ts';
import { saveLead } from './tools/save-lead.ts';
import { saveOutreach } from './tools/save-outreach.ts';
import { finishRun } from './tools/finish-run.ts';

/**
 * The agent's entire route to the outside world.
 *
 * There is no notification tool, no send tool and no email tool, and there
 * will not be one. A page that can make the agent post into the team's Discord
 * is a page that has reached the team.
 */
export const leadgenServer = createSdkMcpServer({
  name: 'leadgen',
  version: '1.0.0',
  tools: [getRunState, saveIcp, discoverCompanies, scrapeCompanySite,
          saveLead, saveOutreach, finishRun],
});

export const LEADGEN_TOOL_NAMES = [
  'mcp__leadgen__get_run_state',
  'mcp__leadgen__save_icp',
  'mcp__leadgen__discover_companies',
  'mcp__leadgen__scrape_company_site',
  'mcp__leadgen__save_lead',
  'mcp__leadgen__save_outreach',
  'mcp__leadgen__finish_run',
] as const;
