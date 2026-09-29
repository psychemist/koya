import type { ToolSpec } from '../define.ts';
import { searchTool } from './search-knowledge-base.ts';
import { customerTool } from './lookup-customer.ts';
import { transactionTool } from './lookup-transaction.ts';
import { payoutTool } from './lookup-payout.ts';

/** Every tool the server exposes. Tasks 7 to 10 each add one file and one line here. */
export const TOOLS: ToolSpec<any>[] = [searchTool, customerTool, transactionTool, payoutTool];
