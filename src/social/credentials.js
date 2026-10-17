// Where a social credential comes from. A PORT: resolve(platform) -> { access_token, account_id, expires_at } (strings, in memory, one call).
//
//   createEnvCredentialPort(env)  - the owner's own long-lived tokens in the machine's environment (the pragmatic path for the trip).
//   later: the provider-connections Vault bridge (OAuth + Supabase Vault) replaces it without touching the publisher.
//
// A token is never printed, logged, persisted or returned by a status view: describe() reports presence and expiry only.

const KEYS = {
  instagram: { token: 'SOCIAL_INSTAGRAM_TOKEN', account: 'SOCIAL_INSTAGRAM_ACCOUNT_ID', expires: 'SOCIAL_INSTAGRAM_TOKEN_EXPIRES_AT' },
  facebook: { token: 'SOCIAL_FACEBOOK_PAGE_TOKEN', account: 'SOCIAL_FACEBOOK_PAGE_ID', expires: 'SOCIAL_FACEBOOK_TOKEN_EXPIRES_AT' },
};

export function createEnvCredentialPort(env = process.env) {
  return {
    async resolve(platform) {
      const k = KEYS[platform];
      if (!k || !env[k.token] || !env[k.account]) return null;
      return { access_token: env[k.token], account_id: env[k.account], expires_at: env[k.expires] || null };
    },
    /** Safe view: names and dates only. */
    describe(platform, now = Date.now()) {
      const k = KEYS[platform];
      const present = Boolean(k && env[k.token] && env[k.account]);
      const expires = present && env[k.expires] ? env[k.expires] : null;
      const left = expires ? Date.parse(expires) - now : null;
      return {
        platform, configured: present, account_id: present ? env[k.account] : null, expires_at: expires,
        state: !present ? 'NOT_CONFIGURED' : expires == null ? 'NO_EXPIRY_KNOWN' : left <= 0 ? 'EXPIRED' : left < 7 * 86_400_000 ? 'EXPIRES_SOON' : 'OK',
        days_left: left == null ? null : Math.floor(left / 86_400_000),
        env_names: k ? [k.token, k.account, k.expires] : [],
      };
    },
  };
}
