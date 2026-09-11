/**
 * Example user auth hook (human users — can expire).
 *
 * Validates a token against an external IdP (e.g. OAuth introspection,
 * LDAP, custom auth gateway). Deploy:
 *   WORK_USER_AUTH_HOOK=/etc/ework/hooks/user-auth.js
 *
 * Copy this file, modify the IdP URL + token extraction, point the env var.
 */
const IDP_URL = process.env.WORK_USER_AUTH_IDP_URL || "";

export default {
  async authenticate(req) {
    const token = req.headers.get("authorization");
    if (!token || !IDP_URL) return null;

    const resp = await fetch(IDP_URL, {
      headers: { authorization: token },
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.username) return null;

    return {
      login: data.username,
      isAdmin: data.is_admin === true,
      kind: "human",
    };
  },
};
