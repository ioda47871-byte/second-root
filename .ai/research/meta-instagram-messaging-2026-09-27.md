# Meta Instagram Messaging API: official-docs research

- **Check date:** 2026-09-27
- **Sources:** developers.facebook.com only. Pages were fetched raw, mostly through the site's own "View as Markdown" (`<page>.md`) endpoints under `https://developers.facebook.com/documentation/...`. Legacy `/docs/...` URLs redirect or map to the same pages.
- **Scope:** receive DMs sent to our own IG Professional account through Webhooks, and reply through the Send API only after a human approves. We never send the first message.
- **Caveat:** Meta is moving docs from `/docs/` to `/documentation/` (the Webhooks overview shows "Updated: Sep 16, 2026"). Some reference pages are client-rendered only and could not be read as text. The Messenger **Send API reference** and **Message Tags** pages are two of them. Those gaps are listed under "unconfirmed" below.

---

## 1. API flavor, permissions, App Review / access level

**URLs read**
- https://developers.facebook.com/documentation/instagram-platform/overview
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
- https://developers.facebook.com/documentation/instagram-platform/app-review
- https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview (Facebook Login / Messenger Platform flavor)
- https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started
- https://developers.facebook.com/docs/graph-api/overview/access-levels
- https://developers.facebook.com/docs/features-reference/human-agent

**Quotes**
- Instagram Login flavor: "This API setup does not require a Facebook Page to be linked to the Instagram professional account."
- Messaging API (IG Login), Permissions: "`instagram_business_basic`", "`instagram_business_manage_messages`". Webhook event subscriptions: "`messages`, `messaging_optins`, `messaging_postbacks`, `messaging_reactions`, `messaging_referrals`, `messaging_seen`".
- Messaging API (IG Login), Access Level: "Advanced Access if your app serves Instagram professional accounts you don't own or manage" / "Standard Access if your app serves Instagram professional accounts you own or manage or have added to your app in the App Dashboard; Some features may not work properly until your app has been granted Advanced Access".
- Access tokens (IG Login): "An Instagram User access token requested from a person who can send a message from the Instagram professional account". Base URL: "`graph.instagram.com`".
- Business Login scope values (IG Login): `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_messages`, `instagram_business_manage_comments`. The old `business_*` scope values were "deprecated on January 27, 2025".
- App Review page, scenario table: "My app is only for a business I own or manage. | No login or Instagram Login | Standard Access | Not required". Same row for "No login or Facebook Login". For "Tech Provider … serves multiple businesses": Advanced Access, App Review "Required".
- App Review page: "Your app can either use Facebook Login or Instagram Login but not both."
- Overview: "If your app only serves your Instagram professional account or an account you manage, Standard Access is all your app needs." and "Advanced Access … requires App Review and Business Verification."
- Graph API access levels: "features with Standard Access are only active for app users who have a role on the app."
- Facebook Login flavor (Messenger Platform), requirements: "`instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_showlist` [sic], `business_management`". A Page access token is required, and the Page must be linked to the IG account.
- Facebook Login flavor, Send a Message: "Apps with Standard Access can only send messages to people that have a role on the app".
- Facebook Login flavor, testing limitations: "Apps with Standard Access can only interact with people who have a role on the app".
- Facebook Login flavor, get-started: the IG account must turn on "Instagram Settings > Messages and story replies > Message controls > Connected Tools > toggle Allow Access to Messages".
- Webhooks setup: "Your app must be **Live** to receive notifications for app users."
- Human Agent feature: "This permission or feature requires successful completion of the App Review process before your app can access live data … only available with business verification."

**Conclusion**
- **Recommended flavor:** Instagram API with Instagram Login (Business Login for Instagram, host `graph.instagram.com`). Meta points Page-less IG accounts to this flavor. It needs only `instagram_business_basic` and `instagram_business_manage_messages`, and it uses an Instagram User access token.
- The Facebook Login / Messenger Platform flavor needs a linked FB Page and a Page access token. Its permissions are `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement` (per the webhook fields matrix), and `business_management`.
- **Own account only:** Meta's App Review table says Standard Access and "App Review: Not required" for both flavors. The app must still be **Live** for webhooks to be delivered.
- The HUMAN_AGENT tag (7-day window) is a separate feature. It needs App Review and Business Verification even for our own account.

**Unconfirmed / ambiguous**
- **Main risk: can a Standard Access app receive DMs from, and reply to, customers who have no role on the app?**
  - The generic access-levels doc says Standard Access features are "only active for app users who have a role on the app". "App user" here most likely means our own IG account, which has a role. That would make the rule satisfied.
  - The Facebook Login-flavor Send page explicitly says Standard Access apps "can only send messages to people that have a role on the app". Read literally, that blocks replies to real customers.
  - The IG Login Messaging page only says "Some features may not work properly until your app has been granted Advanced Access".
  - An older copy of the webhooks setup page, still served at `/documentation/instagram-platform/webhooks.md`, had a table listing "Access level: Advanced Access" and "Business Verification: Required" for Business Login for Instagram webhooks. The current setup page (Sep 2026) dropped that table and requires Advanced Access only for `comments` / `live_comments`.
  - **Verify empirically:** go Live with Standard Access, DM the account from a non-role IG user, and confirm both the webhook and the reply work. If either fails, plan for Business Verification and Advanced Access through App Review.
- The exact App Dashboard location and name of the Standard/Advanced toggle for IG Login was not verified.

---

## 2. Graph API version

**URLs read**
- https://developers.facebook.com/docs/graph-api/changelog
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog
- https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api

**Quotes**
- Graph API changelog: "The latest Graph API version is: v26.0". The versions table:

  | Version | Introduced | Available until |
  | --- | --- | --- |
  | v26.0 | July 29, 2026 | TBD |
  | v25.0 | February 18, 2026 | July 29, 2028 |
  | v24.0 | October 8, 2025 | February 18, 2028 |

- Messenger Platform changelog: "The Messenger Platform follows Graph API Versioning. The latest version is: v26.0".
- Examples in the docs: the Messaging API page uses `https://graph.instagram.com/v25.0/<IG_ID>/messages`. The Webhooks setup page uses `https://graph.instagram.com/v26.0/<INSTAGRAM_ACCOUNT_ID>/subscribed_apps`.

**Conclusion**
- Pin **v26.0**, the latest version, available until "TBD".
- v25.0 is also fully supported until 2028-07-29.
- Keep the version in config, not hard-coded.

**Unconfirmed**
- No doc says whether `graph.instagram.com` has its own version table. The docs imply it shares Graph API versioning.

---

## 3. Webhook setup: verification, fields, payload, echoes, retries

**URLs read**
- https://developers.facebook.com/documentation/instagram-platform/webhooks (Updated Sep 16, 2026)
- https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
- https://developers.facebook.com/documentation/instagram-platform/webhooks/fields
- https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks

### Verification handshake

**Quotes**
- "we'll send a `GET` request to your endpoint URL" with query params `hub.mode`, `hub.challenge` and `hub.verify_token`:
  - `hub.mode`: "This value will always be set to `subscribe`."
  - `hub.challenge`: "An `int` you must pass back to us."
  - `hub.verify_token`: "A string that we grab from the **Verify Token** field in your app's App Dashboard."
- "Verify that the `hub.verify_token` value matches the string you set … Respond with the `hub.challenge` value."
- "your server must have a valid TLS or SSL certificate … Self-signed certificates are not supported."

### Subscribing to fields

**Quotes**
- Step 2: in the App Dashboard, add the callback URL and verify token, then select the fields.
- Then enable the subscription per account with `POST https://graph.instagram.com/v26.0/<INSTAGRAM_ACCOUNT_ID>/subscribed_apps?subscribed_fields=<WEBHOOK_FIELDS>&access_token=<INSTAGRAM_USER_ACCESS_TOKEN>`, which returns `{"success": true}`.
- Fields matrix (IG Login): `messages` needs "`instagram_business_basic`, `instagram_business_manage_messages`". `message_echoes` is listed as its own field, with the permissions shown as "`instagram_business_basic`, `instagram_business_manage_comments`". That looks like a doc error.
- For the Messenger flavor, `message_echoes` is "Included in the `messages` webhook notification".
- "You cannot select fields for each app user account. An account receives every field selected for the app."

### Incoming message payload (IG Login)

Quote: "`object` set to `instagram`".

```json
{
  "object": "instagram",
  "entry": [{
    "id": "<YOUR_APP_USERS_INSTAGRAM_ACCOUNT_ID>",
    "time": <TIME_META_SENT_NOTIFICATION>,
    "messaging": [{
      "sender":    { "id": "<SENDER_ID>" },
      "recipient": { "id": "<RECIPIENT_ID>" },
      "timestamp": <TIME_WEBHOOK_WAS_TRIGGERED>,
      "message": { "mid": "<MESSAGE_ID>", "text": "<MESSAGE_TEXT>" }
    }]
  }]
}
```

**ID table (quoted)**
- "Your app user **receives** a message": `id` and `recipient.id` = "Your app user's Instagram professional account ID". `sender.id` = "The Instagram user's Instagram-scoped ID".
- "Your app user **sends** a message": `recipient.id` = the user's IGSID. `sender.id` = our IG professional account ID.

**Optional `message` properties**
- `text`
- `attachments[]` (`type` + `payload.url`)
- `is_deleted`
- `is_echo`: "set to `true` is included when the message was sent by your app user"
- `is_self`
- `is_unsupported`
- `quick_reply`
- `referral`
- `reply_to`

**Other events**
- `message_edit`, with `mid`, `text` and `num_edit`
- `message_reactions`
- `messaging_seen` (`read.mid`)
- `messaging_postbacks`

**Timestamps**
- `entry.time`: "The time Meta sent the notification".
- `messaging[].timestamp`: "The time when the message was sent".
- Examples show 13-digit (millisecond) values such as `1569262485349`.

### Delivery, retries and duplicates

**Quotes**
- Instagram webhooks setup: "Event Notifications are aggregated and sent in a batch with a **maximum** of 1000 updates. However batching cannot be guaranteed … handle each Webhook individually."
- Same page: "If any update sent to your server fails, we will retry immediately, then try a few more times with decreasing frequency over the next 36 hours. Your server should handle deduplication in these cases. Unacknowledged responses will be dropped after 36 hours."
- Same page: "Note: The frequency with which Messenger event notifications are sent is different."
- Same page, test checklist: "Confirm that duplicate notifications do not repeat an action."
- Same page: "You will not be able to query historical webhook event notification data".
- Messenger webhooks: respond "with a `200 OK HTTPS` response" and "within 5 or less seconds".
- Messenger webhooks: "If a notification sent to your server fails, we will immediately try a few more times. Your server should handle deduplication … If, after 15 minutes … an alert is sent … If delivery … continues to fail for 1 hour, you will receive a **Webhooks Disabled** alert, and your app will be unsubscribed".
- Messenger webhooks: "[messages] may not be delivered in the order they were sent … use the webhook **timestamp** field".

**Conclusion**
1. Implement `GET` verification: check `hub.mode === "subscribe"` and the verify token, then return `hub.challenge` as plain text with status 200.
2. Subscribe to the `messages` field in the Dashboard.
3. Call `POST /<IG_ID>/subscribed_apps?subscribed_fields=messages` with the IG User token.
4. Iterate over every `entry[]` and every `messaging[]`.
5. Skip or record echoes (`message.is_echo === true`), which are our own sends.
6. Deduplicate on `message.mid`. Duplicates are officially expected.
7. Order messages by `timestamp`.
8. Return 200 quickly (within 5s is the Messenger guidance), then process asynchronously.
9. Persist the raw payload, because there is no history replay.

**Unconfirmed / ambiguous**
- **Retry schedule:** Instagram Webhooks says retries run over 36 hours. Messenger Platform webhooks say an alert after 15 minutes and auto-unsubscribe after 1 hour of failures. The Instagram page itself notes that Messenger frequency differs. Which regime applies to IG-Login messaging webhooks is not stated. **Assume the stricter one:** failures lasting about 1 hour may unsubscribe the app.
- **Echo delivery:** echoes may arrive under `messages` (with `is_echo`) or only under a separate `message_echoes` field. The IG Login matrix lists `message_echoes` separately, with suspicious permissions. Test both.
- **Timestamp unit:** seconds or milliseconds is not stated in prose. The examples show milliseconds for `timestamp`, and `entry.time` also appears as milliseconds in the IG examples.
- **Top-level array:** the IG examples wrap the payload in a top-level `[ … ]` array in some snippets and not in others. It is almost certainly a single JSON object. Parse defensively.
- The 5-second response requirement is stated only on the Messenger page.

---

## 4. Webhook payload signature

**URLs read**
- https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks

**Quotes**
- IG setup: "We sign all Event Notification payloads with a **SHA256** signature and include the signature in the request's `X-Hub-Signature-256` header, preceded with `sha256=`. You don't have to validate the payload, but you should."
- IG setup: "Generate a **SHA256** signature using the payload and your app's **App Secret**. Compare your signature to the signature in the `X-Hub-Signature-256` header (everything after `sha256=`)."
- Sample header: `X-Hub-Signature-256: sha256={super-long-SHA256-signature}`.
- Messenger webhooks: "we generate the signature using an *escaped unicode* version of the payload, with lowercase hex digits. If you just calculate against the decoded bytes, you will end up with a different signature. For example, the string `äöå` should be escaped to `äöå`."
- The official sample code computes `crypto.createHmac("sha256", config.appSecret).update(buf).digest("hex")`, where `buf` is the raw request body.

**Conclusion**
- The signature is HMAC-SHA256 with key = App Secret over the **raw request body bytes exactly as received**.
- The header is `X-Hub-Signature-256: sha256=<lowercase hex>`.
- The body Meta sends is already the unicode-escaped JSON, so hashing the raw bytes works.
- **Never** re-serialize parsed JSON before hashing.
- In Next.js route handlers, read `await req.text()` or `arrayBuffer()` before calling `JSON.parse`.
- Compare with a constant-time comparison.

**Unconfirmed**
- The "escaped unicode" note appears only on the Messenger Platform webhooks page, not on the Instagram setup page. It is assumed to apply, since it is the same signing infrastructure.
- The docs do not say whether the IG Login flavor signs with the Meta App secret or a separate "Instagram app secret" shown in the Instagram product settings. **Verify in the App Dashboard.** The Instagram API setup screen displays an Instagram app ID/secret that is distinct from the Meta app's.

---

## 5. Send API

**URLs read**
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
- https://developers.facebook.com/documentation/instagram-platform/overview (Rate Limiting)
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
- https://developers.facebook.com/docs/graph-api/guides/error-handling

### Request (IG Login)

**Quotes**
- Endpoints: "`/<IG_ID>/messages` or `/me/messages`". "All endpoints can be accessed via the `graph.instagram.com` host."
- Required parameters: "`recipient:{id:<IGSID>}`" and "`message:{<MESSAGE_ELEMENTS>}`".
- "Message text must be UTF-8 and be a 1000 bytes or less. Links must be valid formatted URLs."

Sample request:

```
curl -X POST "https://graph.instagram.com/v25.0/<IG_ID>/messages"
  -H "Authorization: Bearer <INSTAGRAM_USER_ACCESS_TOKEN>"
  -H "Content-Type: application/json"
  -d '{"recipient":{"id":"<IGSID>"},"message":{"text":"<TEXT_OR_LINK>"}}'
```

### Response

Quote: "Upon success, your app will receive the following JSON response:"

```json
{ "recipient_id": "IGSID", "message_id": "MESSAGE-ID" }
```

### Tokens (IG Login)

**Quotes**
- Business Login returns a short-lived token ("valid for 1 hour"), which can be exchanged for a long-lived token "valid for 60 days" via `https://graph.instagram.com/access_token`.
- The long-lived token can be refreshed via `https://graph.instagram.com/refresh_access_token`.
- "Access tokens from the App Dashboard are long-lived and are valid for 60 days."
- Long-lived token requests "must be made in server-side code".

### Rate limits

**Quotes (Overview, "Messaging Rate Limits")**
- Send API: "Your app can make 100 calls per second per Instagram professional account for messages that contain text, links, reactions, and stickers" and "10 calls per second per Instagram professional account for messages that contain audio or video content".
- Conversations API: "2 calls per second per Instagram professional account".
- Non-messaging calls use `4800 * Number of Impressions` per 24 hours.

### Error format

Graph API error format:

```json
{"error":{"message":"…","type":"OAuthException","code":190,"error_subcode":460,"error_user_title":"…","error_user_msg":"…","fbtrace_id":"…"}}
```

The Instagram error-codes sample also includes `"is_transient": false`.

**Relevant codes (Messenger error-codes page)**

| Code | Meaning |
| --- | --- |
| `10` – `2534022` | "This message is sent outside of allowed window. … Apps can only send a message to a customer within 24 hours of receiving the customer's message." |
| `100` – `2534014` | "No matching Instagram user … Instagram User ID are not supported" |
| `190` | invalid token |
| `200` – `2534041` | "The account owner has disabled access to instagram direct messages." |
| `551` | "This person isn't receiving messages from you right now." |
| `613` – `2534040` | rate limit |
| `10` – `1893063` | "temporarily restricted from sending messages" |
| `100` – `2534029` | "blocked from sending messages via the IG Messaging API" |
| `2` | "An unexpected error has occurred. Please retry your request later." |

**Graph API error handling**
- code 1: "Wait and retry"
- code 2: "Temporary issue due to downtime. Wait and retry"
- codes 4 and 17: "Temporary issue due to throttling. Wait and retry"

**Conclusion**
- Send with `POST https://graph.instagram.com/v26.0/me/messages` (or `/<IG_ID>/messages`).
- Use `Authorization: Bearer <long-lived IG User token>`.
- Body: `{"recipient":{"id":"<IGSID>"},"message":{"text":"…"}}`, with text of 1000 UTF-8 bytes or less.
- Store the returned `message_id`. The echo webhook will carry it as `mid`, which lets us reconcile.
- Refresh the token before 60 days.
- Map the error `code`/`error_subcode` pairs above, especially 2534022 (window closed).

**Unconfirmed**
- `messaging_type` (`RESPONSE` / `UPDATE` / `MESSAGE_TAG`) appears in the Messenger Send API examples but **not** in the IG Login examples. Whether the IG Login endpoint accepts or requires it is unconfirmed. Omitting it matches the official IG Login samples.
- The IG Login docs do not publish a dedicated error-code table for messaging. The codes above come from the Messenger Platform list, which covers Instagram Messaging, and may differ slightly on `graph.instagram.com`.
- The exact HTTP status codes returned for send errors are not documented for messaging.

---

## 6. Messaging window and policy

**URLs read**
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
- https://developers.facebook.com/documentation/instagram-platform/overview
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy
- https://developers.facebook.com/docs/features-reference/human-agent

**Quotes**
- "Conversations only begin when an Instagram user sends a message to your app user…"
- "Only after an Instagram user has sent your app user's Instagram professional account a message can your app send a message to the Instagram user. Your app has 24 hours to respond to any message sent from an Instagram user to your app user."
- "If more time is needed to allow a human agent to respond, you can use the human agent tag to send a response within 7 days." (Overview)
- "The **Human Agent** feature allows your app to have a human agent respond to user messages using the **human_agent** tag within 7 days of a user's message. The allowed usage … cases where a user's issue cannot be resolved in the standard messaging window. Examples include when the business is closed for the weekend, or if the issue requires more than 24 hours to resolve."
- Human Agent requires "successful completion of the App Review process" and "business verification".
- Messenger send-messages: "To send messages to a person on Messenger or Instagram, the conversation must be initiated by that person."
- Messenger send-messages: "Message Tags may not be used to send promotional content".
- Policy: "One-time notifications are not available for IG Messaging API." and "Some message tags are available only for Messenger Platform and not IG Messaging API."
- Messenger send-messages: "Effective April 27th, 2026, all API requests containing the Message Tags CONFIRMED_EVENT_UPDATE, ACCOUNT_UPDATE, and POST_PURCHASE_UPDATE will receive error code 100."
- Automation disclosure: "When required by applicable law, automated chat experiences must disclose that a person is interacting with an automated service".

**Conclusion**
- Replies are allowed only within **24 hours of the user's most recent message**, and only after the user has messaged first. We send no cold messages, which is compliant.
- Replies up to **7 days** later need the `HUMAN_AGENT` tag. That requires the Human Agent feature through App Review plus Business Verification, and the content must be non-promotional human support.
- The approval UI should show a countdown to 24h from the latest inbound `timestamp`, and should block sends after that unless Human Agent has been granted.

**Unconfirmed**
- The exact request syntax for the tag on `graph.instagram.com` could not be read. The Send API reference and Message Tags pages are JS-rendered and returned no text. The expected shape, based on Messenger convention, is `"messaging_type":"MESSAGE_TAG","tag":"HUMAN_AGENT"`, but it is **not verified** for IG Login.
- Whether the window resets on every inbound user message is implied ("24 hours to respond to any message") but not stated as "last message".
- Messenger policy lists other window openers (a comment, an ig.me link), but those are Messenger Platform statements.

---

## 7. Identifiers and sender profile

**URLs read**
- https://developers.facebook.com/documentation/instagram-platform/overview (Scoped User IDs)
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes

**Quotes**
- "When an Instagram user … sends a message to an Instagram professional account, an Instagram-scoped User ID is created that represents that person on that app. This ID is specific to the person and the Instagram account they are interacting with."
- Profile endpoint: `GET https://graph.instagram.com/v25.0/<INSTAGRAM_SCOPED_ID>?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user&access_token=<INSTAGRAM_ACCESS_TOKEN>`.
- Permissions: "`instagram_business_basic`, `instagram_business_manage_messages`". The token must come from the app user "who received the webhook notification and who can manage messages".
- Consent: "**User consent is required to access an Instagram user's profile.** User consent is set only when an Instagram user sends a message to your app user, or clicks an icebreaker or persistent menu."
- Limitation: "If the Instagram user has blocked your app user, your app will not be able to view the Instagram user's information."
- Fields:
  - `name`: "can be null if name not set"
  - `profile_pic`: "can be null … The URL will expire in a few days"
  - `username`
  - `follower_count`
  - `is_verified_user`
  - `is_user_follow_business`
  - `is_business_follow_user`
- Error `100`–`2534014`: "Check to make sure the ID you are using is a valid Instagram–scoped ID. Instagram User ID are not supported."

**Conclusion**
- `sender.id` is an **IGSID**. It is scoped to the person × our IG account, and it is not a global IG user ID or username. Store it as the primary key for the contact. The docs call it an `int` in one table, but treat it as a **string**.
- Fetch the username with `GET /<IGSID>?fields=username,name,profile_pic` using the IG User token. This works only after the user has messaged us.
- Do not persist `profile_pic` URLs long term, because they expire.

**Unconfirmed**
- IGSID stability across token refreshes and re-logins is not stated.
- The docs do not say whether the IGSID differs between the IG Login and Facebook Login flavors for the same person. The Overview describes both "Instagram-scoped" and "Page-scoped" IDs in near-identical wording, which is ambiguous.
- The `is_verified_user` field appears in the reference table but not in the sample request.

---

## 8. Idempotency, deduplication and retries for sends

**URLs read**
- All of the above
- https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
- https://developers.facebook.com/docs/graph-api/guides/error-handling
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes

**Quotes**
- Webhooks (inbound): "Your server should handle deduplication in these cases." and "Confirm that duplicate notifications do not repeat an action."
- Messenger error code `1` – `1357046`: "Received invalid JSON reply. … The messages are all sent successfully, but the endpoint returns an error. … There is a system delay in returning the error message." This is official evidence that a send can **succeed while an error is returned**.
- Error handling: codes 1, 2, 4 and 17 say "Wait and retry the operation". The IG error sample includes `"is_transient"`.

**Conclusion**
- **No official idempotency key or deduplication mechanism exists for the Send API.** None was found in any page read.
- A blind retry after a timeout or ambiguous error **can produce a duplicate DM**.
- Recommended design:
  1. Keep an approval-state machine (`approved → sending → sent/failed`) with a unique DB constraint so each approved reply is sent at most once.
  2. Retry automatically **only** on clear pre-send failures (codes 4/17/613 throttling, 2 "temporary") with backoff, and only when the send clearly did not complete.
  3. On timeouts or ambiguous errors, mark the reply `unknown` and reconcile against the `message_echoes` / `is_echo` webhook (matching our `message_id` = `mid`, or recipient + text + time) before any manual resend.
  4. Deduplicate inbound webhooks by `mid`, and also by event type for edits and reactions.

**Unconfirmed**
- No official statement on whether Meta deduplicates identical sends.
- No official statement on the recommended retry count or backoff for the IG Send API.
- It is not confirmed that echo webhooks include the same `mid` that the Send API returned as `message_id`. This is expected, but not stated verbatim for IG Login.

---

## Summary of top risks to verify empirically

1. Standard Access (no App Review) with a Live app. Does it deliver `messages` webhooks from non-role customers and allow replies to them? The docs conflict (see section 1).
2. Which secret signs IG-Login webhooks: the Meta App Secret or the Instagram app secret (see section 4).
3. The webhook failure regime: 36-hour retries, or auto-unsubscribe after 1 hour (see section 3).
4. Echo delivery via `messages` + `is_echo` versus the separate `message_echoes` field (see section 3).
5. `HUMAN_AGENT` tag syntax on `graph.instagram.com`. It needs App Review in any case (see section 6).
