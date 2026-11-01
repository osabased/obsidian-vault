import { runHook } from '../../../lib/vault.mjs';
import * as agent from '../adapter.mjs';
import { stop } from '../../../lib/handlers/stop.mjs';
runHook('stop', agent, stop);
