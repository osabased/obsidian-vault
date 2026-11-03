import { runHook } from '../../../lib/vault.mjs';
import * as agent from '../adapter.mjs';
import { vaultCall } from '../../../lib/handlers/vault-call.mjs';
runHook('vault-call', agent, vaultCall);
