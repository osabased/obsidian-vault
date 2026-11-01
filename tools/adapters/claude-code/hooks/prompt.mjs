import { runHook } from '../../../lib/vault.mjs';
import * as agent from '../adapter.mjs';
import { prompt } from '../../../lib/handlers/prompt.mjs';
runHook('prompt', agent, prompt);
