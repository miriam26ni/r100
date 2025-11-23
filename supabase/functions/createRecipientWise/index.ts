// supabase/functions/createRecipientWise/index.ts
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

Deno.serve(async (req: Request) => {
  try {
    const auth = req.headers.get('authorization') || '';
    if (!auth.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 });
    const token = auth.split(' ')[1];

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return new Response('Invalid token', { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { account_holder_name, account_number, routing_number, country = 'US', currency = 'USD' } = body;

    if (!account_holder_name || !account_number) {
      return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    // Build payload for Wise
    const payload: any = {
      profile: Deno.env.get('WISE_PROFILE_ID'),
      accountHolderName: account_holder_name,
      currency: currency.toUpperCase(),
      type: country === 'US' ? 'us_ach' : 'iban',
      details: country === 'US' ? { accountNumber: account_number, routingNumber: routing_number } : { iban: account_number }
    };

    const res = await fetch(`https://api.transferwise.com/v3/profiles/${Deno.env.get('WISE_PROFILE_ID')}/recipients`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('WISE_API_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      await supabase.from('payout_info').upsert({
        user_id: user.id,
        validation_error: data,
        verified: false
      });
      return new Response(JSON.stringify({ error: 'Validation error', details: data }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    // Save verified recipient
    await supabase.from('payout_info').upsert({
      user_id: user.id,
      recipient_id: data.id,
      account_holder_name,
      account_number,
      routing_number: country === 'US' ? routing_number : null,
      country,
      currency: currency.toUpperCase(),
      verified: true
    });

    return new Response(JSON.stringify({ success: true, recipient_id: data.id }), { status: 200, headers: { 'content-type': 'application/json' } });

  } catch (err: any) {
    console.error('createRecipientWise error', err);
    return new Response(JSON.stringify({ error: String(err?.message ?? err) }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
