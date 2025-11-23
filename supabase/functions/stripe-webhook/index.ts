// supabase/functions/stripe-webhook/index.ts
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import Stripe from 'https://esm.sh/stripe@14?target=deno&no-check';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });

Deno.serve(async (req: Request) => {
  try {
    const sig = req.headers.get('stripe-signature') || '';
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
    const bodyText = await req.text();

    let event;
    try {
      event = stripe.webhooks.constructEvent(bodyText, sig, webhookSecret);
    } catch (err: any) {
      console.error('Invalid stripe webhook signature', err?.message);
      return new Response(`Webhook Error: ${err?.message}`, { status: 400 });
    }

    // Handle events
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as any;
      if (session.payment_status === 'paid') {
        const userId = session.client_reference_id;
        const amount_total = session.amount_total ?? 0;
        const monto = (Number(amount_total) / 100).toFixed(2);

        const { data, error } = await supabase.rpc('registrar_pago_con_celebracion', { p_usuario_id: userId, p_monto: monto, p_metodo: 'stripe' });

        if (error) {
          console.error('registrar_pago_con_celebracion error', error);
        } else {
          if (data === 'USUARIO_100') {
            console.log('Usuario llegó a 100 por Stripe session', userId);
          }
        }
      }
    }

    if (event.type === 'account.updated') {
      const account = event.data.object as any;
      if (account.charges_enabled && account.payouts_enabled) {
        const { data: usuario } = await supabase.from('usuarios').select('id').eq('stripe_account_id', account.id).maybeSingle();
        if (usuario?.id) {
          await supabase.from('usuarios').update({ stripe_account_id: account.id }).eq('id', usuario.id);
          console.log('Cuenta stripe completada onboarding:', usuario.id);
        }
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err: any) {
    console.error('stripe-webhook handler error', err);
    return new Response('Internal error', { status: 500 });
  }
});
