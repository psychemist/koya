import { startMcpHttp } from './http.ts';
import { TOOLS } from './tools/index.ts';
import { startSweeper } from './sweeper.ts';

const port = Number(process.env.PORT ?? 8788);
const server = await startMcpHttp(port);
console.log(JSON.stringify({ level: 'info', at: 'mcp_boot', port, tools: TOOLS.map((t) => t.name) }));

const stopSweeper = startSweeper(60_000);

process.on('SIGTERM', () => { stopSweeper(); server.close(() => process.exit(0)); });
