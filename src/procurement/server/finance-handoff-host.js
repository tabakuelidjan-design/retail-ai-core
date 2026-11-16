// Hosted wiring of the Stock / Achats -> Finance hand-off: the Finance inbox of the SAME Supabase project and merchant as the Core sign-in.
// Same gate as the Core's read-only Finance reader (hosted + Supabase + MERCHANT_TIMEZONE): otherwise null and the order screen simply has no such step.
// A failure here is logged and never stops Nordla.
import { createFinanceHandoff } from '../finance-handoff.js';

export async function buildFinanceHandoff({ env = process.env, merchantId, log = () => {} }) {
  try {
    if (String(env.SOURCING_HOSTED ?? '').trim() !== '1' || !String(env.SUPABASE_URL ?? '').trim() || !String(env.MERCHANT_TIMEZONE ?? '').trim()) return null;
    const { createSupabaseClient, loadSupabaseConfigFromEnv } = await import('../../supabase/client.js');
    const { createSupabaseFinanceStore } = await import('../../finance/supabase-store.js');
    const { createInboxService, createMemoryAttachmentStore } = await import('../../finance/inbox.js');
    const store = createSupabaseFinanceStore(createSupabaseClient(loadSupabaseConfigFromEnv(env)), { merchantId });
    return createFinanceHandoff({ inbox: createInboxService({ store, attachments: createMemoryAttachmentStore(), merchantId }) });
  } catch (e) { log(`Stock/Achats -> Finance hand-off NOT available (${e.code ?? 'ERROR'}): ${e.message}`); return null; }
}
