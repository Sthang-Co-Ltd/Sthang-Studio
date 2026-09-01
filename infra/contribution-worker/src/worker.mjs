import api from './index.mjs';
import { cleanupExpiredSubmitted } from './retention.mjs';

export default {
  fetch(request, env, context) {
    return api.fetch(request, env, context);
  },
  scheduled(_controller, env, context) {
    context.waitUntil(cleanupExpiredSubmitted(env));
  },
};
