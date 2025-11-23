// supabase/functions/process-payout-queue/index.ts
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET = Deno.env.get('STRIPE_SECRET_KEY')!;
const WISE_API_KEY = Deno.env.get('WISE_API_KEY')!;
const WISE_PROFILE_ID = Deno.env.get('WISE_PROFILE_ID')!;
const PGNET_ENABLED = (Deno.env.get('PGNET_ENABLED') || 'false') === 'true';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BATCH_SIZE = Number(Deno.env.get('WORKER_BATCH_SIZE') || '10');
const MAX_ATTEMPTS = 5;

async function fetchPendingBatch() {
  const { data } = await supabase.rpc('fetch_and_claim_events', { p_limit: BATCH_SIZE }).catch(() => ({ data: null }));
  if (!data) return [];
  return data;
}

Deno.serve(async () => {
  try {
    const { data: pending } = await supabase
      .from('events')
      .select('*')
      .eq('status', 'pending')
      .lte('available_at', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (!pending || pending.length === 0) return new Response('No pending', { status: 200 });

    for (const ev of pending) {
      const { data: claimed } = await supabase
        .from('events')
        .update({ status: 'processing', attempts: Number(ev.attempts || 0) + 1 })
        .eq('id', ev.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();
      if (!claimed) continue;

      try {
        const userId = ev.user_id;
        const { data: alreadyPaid } = await supabase.from('bonos_pagados').select('user_id').eq('user_id', userId).maybeSingle();
        if (alreadyPaid) {
          await supabase.from('events').update({ status: 'completed' }).eq('id', ev.id);
          continue;
        }

        const { data: user } = await supabase.from('usuarios').select('id,nombre,stripe_account_id').eq('id', userId).maybeSingle();
        if (!user) throw new Error('Usuario no encontrado ' + userId);

        if (user.stripe_account_id) {
          const body = `amount=10000&currency=usd&destination=${encodeURIComponent(user.stripe_account_id)}&transfer_group=BONO100-${userId}`;
          const stripeRes = await fetch('https://api.stripe.com/v1/transfers', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${STRIPE_SECRET}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
          });
          const stripeJson = await stripeRes.json();
          if (!stripeRes.ok) throw new Error('Stripe transfer failed: ' + JSON.stringify(stripeJson));

          await supabase.from('payouts_log').insert({ user_id: userId, status: 'succeeded', provider_response: stripeJson, attempt_number: ev.attempts });
          await supabase.from('bonos').insert({ usuario_id: userId, monto: 100, estado: 'pagado', metodo_pago: 'stripe', procesado_at: new Date().toISOString() }).catch(()=>{});
          await supabase.from('bonos_pagados').upsert({ user_id: userId, paid_at: new Date().toISOString() });
          await supabase.from('events').update({ status: 'completed' }).eq('id', ev.id);
          continue;
        }

        const { data: pinfo } = await supabase.from('payout_info').select('recipient_id,verified').eq('user_id', userId).maybeSingle();
        if (pinfo?.recipient_id && pinfo?.verified) {
          const payload = {
            targetAccount: pinfo.recipient_id,
            quoteUuid: 'auto',
            customerTransactionId: `BONO100-${userId}`,
            details: { reference: '¡Ganaste en Rotacion100!' }
          };
          const wiseRes = await fetch(`https://api.transferwise.com/v3/profiles/${WISE_PROFILE_ID}/transfers`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${WISE_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
          const wiseJson = await wiseRes.json();
          if (!wiseRes.ok) throw new Error('Wise failed: ' + JSON.stringify(wiseJson));

          await supabase.from('payouts_log').insert({ user_id: userId, status: 'succeeded', provider_response: wiseJson, attempt_number: ev.attempts });
          await supabase.from('bonos').insert({ usuario_id: userId, monto: 100, estado: 'pagado', metodo_pago: 'wise', procesado_at: new Date().toISOString() }).catch(()=>{});
          await supabase.from('bonos_pagados').upsert({ user_id: userId, paid_at: new Date().toISOString() });
          await supabase.from('events').update({ status: 'completed' }).eq('id', ev.id);
          continue;
        }

        await supabase.from('payouts_log').insert({ user_id: userId, status: 'failed', provider_response: { error: 'no_method' }, attempt_number: ev.attempts });
        const nextAvailable = new Date(Date.now() + 60 * 1000).toISOString();
        await supabase.from('events').update({ status: 'pending', available_at: nextAvailable }).eq('id', ev.id);
      } catch (payErr) {
        console.error('pay error', payErr);
        await supabase.from('payouts_log').insert({ user_id: ev.user_id, status: 'failed', provider_response: { error: String(payErr) }, attempt_number: ev.attempts }).catch(()=>{});
        const attempts = ev.attempts + 1;
        const backoffSeconds = Math.min(300, Math.pow(2, attempts) * 10);
        const nextAvailable = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        if (attempts >= MAX_ATTEMPTS) {
          await supabase.from('events').update({ status: 'failed', available_at: nextAvailable }).eq('id', ev.id);
        } else {
          await supabase.from('events').update({ status: 'pending', available_at: nextAvailable, attempts }).eq('id', ev.id);
        }
      }
    }

    return new Response('Processed batch', { status: 200 });
  } catch (err) {
    console.error('worker fatal', err);
    return new Response('Worker error', { status: 500 });
  }
});
