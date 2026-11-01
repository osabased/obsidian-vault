import { runHook } from '../../../lib/vault.mjs';
import * as agent from '../adapter.mjs';
import { subagentStart } from '../../../lib/handlers/subagent-start.mjs';
runHook('subagent-start', agent, subagentStart);
