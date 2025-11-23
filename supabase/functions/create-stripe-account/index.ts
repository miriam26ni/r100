// supabase/functions/create-stripe-account/index.ts
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import Stripe from 'https://esm.sh/stripe@14?target=deno&no-check';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });

Deno.serve(async (req: Request) => {
  try {
    const auth = req.headers.get('authorization') || '';
    if (!auth.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 });
    const token = auth.split(' ')[1];

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return new Response('Invalid token', { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { full_name } = body;

    const { data: existing } = await supabase.from('usuarios').select('id,stripe_account_id').eq('id', user.id).maybeSingle();

    if (existing?.stripe_account_id) {
      const acct = await stripe.accounts.retrieve(existing.stripe_account_id);
      if (!acct.charges_enabled || !acct.payouts_enabled) {
        const link = await stripe.accountLinks.create({
          account: existing.stripe_account_id,
          refresh_url: Deno.env.get('SITE_URL') || 'https://r100.vercel.app',
          return_url: Deno.env.get('SITE_URL') || 'https://r100.vercel.app',
          type: 'account_onboarding'
        });
        return new Response(JSON.stringify({ onboardingUrl: link.url }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ alreadyConnected: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email ?? undefined,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } }
    });

    await supabase.from('usuarios').update({
      stripe_account_id: account.id,
      nombre: full_name || user.user_metadata?.full_name || 'Pendiente'
    }).eq('id', user.id);

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: Deno.env.get('SITE_URL') || 'https://r100.vercel.app',
      return_url: Deno.env.get('SITE_URL') || 'https://r100.vercel.app',
      type: 'account_onboarding'
    });

    return new Response(JSON.stringify({ onboardingUrl: link.url }), { status: 200, headers: { 'content-type': 'application/json' } });

  } catch (err: any) {
    console.error('create-stripe-account error', err);
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
