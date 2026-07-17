Here's the complete Meta-side setup, in order. This is everything outside your codebase.

## 1. Create/confirm your Meta App
- Go to **developers.facebook.com** → My Apps → Create App.
- Choose type: **Business**.
- Fill in app name, contact email, and link it to your **Business Portfolio** (create one if you don't have it).

## 2. Add the WhatsApp product
- In your App Dashboard sidebar → **Add Product** → find **WhatsApp** → Set Up.
- This auto-provisions a **test WABA + test phone number** you can use immediately without App Review.

## 3. Enable Embedded Signup & create a Configuration
- Go to **WhatsApp → Embedded Signup** (sometimes under **WhatsApp → Configuration** depending on the current dashboard version).
- Click **Create Configuration**.
- Set:
  - **Business assets to share**: choose whether users select an existing WABA/create new, and whether phone number selection is included.
  - **Feature type**: standard onboarding vs coexistence (you need both flows working, so check if you can support both in one config or need two).
  - Permissions requested: `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`.
- Save it — copy the **Configuration ID**.
- Put this in your `.env` as `NEXT_PUBLIC_FACEBOOK_CONFIG_ID`.

## 4. Copy your App ID and App Secret
- **Settings → Basic** in the dashboard.
- `App ID` → `NEXT_PUBLIC_FACEBOOK_APP_ID` (safe to expose client-side).
- `App Secret` → `META_APP_SECRET` (server-only, never expose).

## 5. Configure Facebook Login for Business
- **Settings → Basic** → scroll to "Add Platform" if not already added → add **Website**.
- Enter your site URL (staging first, then production later).
- Go to **Facebook Login → Settings** in the sidebar.
- Add your domain(s) under **Allowed Domains for the JavaScript SDK** — this is required or `FB.login()` popup will fail with an origin error.
- You don't need OAuth Redirect URIs for Embedded Signup since it uses the JS SDK popup + postMessage, not a redirect — skip that field.

## 6. Set up the webhook
- **WhatsApp → Configuration** (or **App Dashboard → Webhooks**).
- Callback URL: your production `/api/whatsapp/webhook` endpoint (must be HTTPS).
- Verify token: same string your backend checks against.
- Subscribe to fields: `messages`, `message_template_status_update`, and any others your code handles.
- Click **Verify and Save** — Meta will hit your GET endpoint immediately to confirm.

## 7. Test with the sandbox/test number
- Use the auto-provisioned test WABA + number from step 2.
- Run your actual "Connect WhatsApp" button end-to-end against this test number.
- Confirm:
  - Popup opens and completes.
  - `postMessage` payload matches what your code expects.
  - Token exchange succeeds.
  - Webhook receives a test message.
- This works without App Review — it's scoped to test users/admins on your app only.

## 8. Add test users (if testing with teammates)
- **App Roles → Roles** → add teammates as **Testers** or **Developers** so they can go through the flow before public release.

## 9. Start Business Verification
- **Business Settings → Security Center** (in Meta Business Suite/Business Manager, not the App Dashboard) → **Start Verification**.
- Requires legal business name, address, phone, and a document (business license, tax ID, utility bill, etc.).
- This can take a few days to a couple of weeks — start it now, in parallel.

## 10. Submit for App Review (Advanced Access)
- **App Review → Permissions and Features**.
- Request **Advanced Access** for:
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
- You'll need to submit a **screen recording** of your actual Embedded Signup flow working end-to-end (this is why step 7 must be done first) plus a written explanation of your use case.
- Meta reviews this — typically a few days, sometimes longer.

## 11. Go live
- Once Business Verification + App Review are both approved, switch your app from **Development Mode** to **Live Mode** (toggle at top of App Dashboard).
- Real (non-test) merchants can now complete the flow.

---

**Do these in parallel, not strictly sequential:**
- Steps 1–8 (setup + test) — do this week, blocks nothing else.
- Steps 9–10 (verification + review) — kick off as soon as step 7 passes, since review needs your working demo recording.

Want me to write out exactly what to say in the App Review submission text (Meta is picky about this and rejects vague use-case descriptions)?