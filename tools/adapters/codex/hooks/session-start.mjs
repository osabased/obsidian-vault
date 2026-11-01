import { runHook } from '../../../lib/vault.mjs';
import * as agent from '../adapter.mjs';
import { start } from '../../../lib/handlers/start.mjs';
runHook('session-start', agent, start);
