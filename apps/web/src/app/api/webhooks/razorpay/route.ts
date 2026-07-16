/**
 * Razorpay webhook endpoint
 * POST: Handle Razorpay webhook events
 */

import { headers } from 'next/headers';
import { verifyRazorpayWebhook, handleRazorpayWebhook } from '@/lib/payment/razorpay';
import { NextRequest, NextResponse } from 'next/server';

const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || '';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const headersList = await headers();
    const signature = headersList.get('x-razorpay-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
    }

    // Verify webhook signature
    const isValid = verifyRazorpayWebhook(body, signature, razorpayWebhookSecret);

    if (!isValid) {
      console.error('[Razorpay webhook] Signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    const event = JSON.parse(body);

    // Handle the webhook event
    await handleRazorpayWebhook(event);

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('[Razorpay webhook] Error:', error);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}
