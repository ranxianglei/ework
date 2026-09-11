/**
 * Example internal auth hook (daemon / machine-to-machine).
 *
 * Validates a permanent shared-secret header. Deploy:
 *   WORK_INTERNAL_AUTH_HOOK=/etc/ework/hooks/internal-auth.js
 *
 * Copy this file, change the secret, point the env var at your copy.
 */
const SHARED_SECRET = process.env.WORK_INTERNAL_AUTH_SECRET || "";

export default {
  async authenticate(req) {
    const auth = req.headers.get("x-internal-auth");
    if (!auth || !SHARED_SECRET) return null;
    if (auth !== SHARED_SECRET) return null;
    return {
      login: "ework-internal",
      isAdmin: true,
      kind: "system",
    };
  },
};
