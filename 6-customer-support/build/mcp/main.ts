import { startMcpHttp } from './http.ts';
import { TOOLS } from './tools/index.ts';

const port = Number(process.env.PORT ?? 8788);
const server = await startMcpHttp(port);
console.log(JSON.stringify({ level: 'info', at: 'mcp_boot', port, tools: TOOLS.map((t) => t.name) }));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
