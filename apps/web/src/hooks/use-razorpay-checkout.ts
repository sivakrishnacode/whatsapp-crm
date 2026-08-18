"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Razorpay plan checkout, in ONE place.
 *
 * ⚠️ It has to be one place. The API verifies Razorpay's HMAC signature
 * over `<order_id>|<payment_id>` before it will record a payment, so a
 * caller that forgets to forward `razorpay_signature` does not fail
 * visibly — it takes the customer's money and then reports "payment
 * successful but failed to update subscription". Two copies of this flow
 * is two chances to omit one field; `/pricing` and the locked `/billing`
 * screen both come through here.
 */

/**
 * The slice of Razorpay's checkout API we use. Typed here rather than
 * pulled from a package: the SDK ships as a script tag, so there is no
 * module to import types from.
 */
interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (response: RazorpayPaymentResponse) => void;
  prefill: { name: string; email: string };
  theme: { color: string };
}

interface RazorpayCheckout {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayCheckout;
  }
}

export type BillingCycle = "monthly" | "yearly";

export interface RazorpayCheckoutOptions {
  /** Shown in Razorpay's own form so the customer isn't retyping. */
  prefill: { name: string; email: string };
  /** Runs once the server has RECORDED the payment, not when it clears. */
  onPaid: (planName: string) => void;
}

export function useRazorpayCheckout({
  prefill,
  onPaid,
}: RazorpayCheckoutOptions) {
  const [pending, setPending] = useState(false);

  // The script is fetched per mounting screen and removed on unmount, so
  // a long dashboard session isn't carrying a payment SDK around.
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    document.body.appendChild(script);

    return () => {
      script.remove();
    };
  }, []);

  const pay = useCallback(
    async (planName: string, billingCycle: BillingCycle = "monthly") => {
      // Publishable key — safe in the client, but it differs between test
      // and live and must not be baked into the bundle as a literal.
      const razorpayKey = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
      if (!razorpayKey) {
        toast.error("Payments are not configured. Please contact support.");
        return;
      }

      setPending(true);
      try {
        const response = await fetch(
          "/api/subscription/razorpay/create-order",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planName, billingCycle }),
          },
        );

        const data = await response.json();

        if (!response.ok) {
          toast.error(data.error || "Failed to create payment order");
          return;
        }

        const options: RazorpayOptions = {
          key: razorpayKey,
          order_id: data.orderId,
          amount: data.amount,
          currency: data.currency,
          name: "Converse360",
          description: `${planName} Plan - ${billingCycle === "yearly" ? "Yearly" : "Monthly"}`,
          handler: (payment: RazorpayPaymentResponse) => {
            void confirm(planName, billingCycle, data.orderId, payment);
          },
          prefill,
          theme: { color: "#00ac55" },
        };

        const Razorpay = window.Razorpay;
        if (!Razorpay) {
          toast.error("Checkout failed to load. Please refresh and try again.");
          return;
        }
        new Razorpay(options).open();
      } catch (error) {
        console.error("Payment error:", error);
        toast.error("Failed to initiate payment");
      } finally {
        setPending(false);
      }
    },
    // `confirm` is defined below and is stable for the life of the hook;
    // it closes over onPaid, which the caller owns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefill, onPaid],
  );

  /**
   * Hand the gateway's own proof to the server.
   *
   * ⚠️ `razorpay_signature` is not optional decoration — it IS the
   * authorisation. Omitting it makes the confirm call fail closed, which
   * is the correct direction but leaves a paid customer unrecorded, so
   * the failure message tells them to contact support rather than
   * pretending the plan changed.
   */
  async function confirm(
    planName: string,
    billingCycle: BillingCycle,
    orderId: string,
    payment: RazorpayPaymentResponse,
  ): Promise<void> {
    try {
      const response = await fetch(
        "/api/subscription/razorpay/confirm-payment",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            planName,
            billingCycle,
            razorpayOrderId: payment.razorpay_order_id ?? orderId,
            razorpayPaymentId: payment.razorpay_payment_id,
            razorpaySignature: payment.razorpay_signature,
          }),
        },
      );

      if (!response.ok) {
        toast.error(
          "Payment went through but we could not update your plan. " +
            "Please contact support — do not pay again.",
        );
        return;
      }

      onPaid(planName);
    } catch (error) {
      console.error("Error confirming payment:", error);
      toast.error(
        "Payment went through but we could not update your plan. " +
          "Please contact support — do not pay again.",
      );
    }
  }

  return { pay, pending };
}
