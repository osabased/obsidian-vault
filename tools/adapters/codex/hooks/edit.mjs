import { runHook } from '../../../lib/vault.mjs';
import * as agent from '../adapter.mjs';
import { preTool } from '../../../lib/handlers/pre-tool.mjs';
runHook('edit', agent, preTool);
