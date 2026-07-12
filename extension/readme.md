# Influence Outreach Automator

A Chrome extension for the Influence Deal Studio. It has two jobs:

1. **Scrape** Instagram profiles into the dashboard (email, name, recent reel views) — driven from the dashboard's "Scrape Via Extension" button.
2. **Decide offers on Instagram** — a vertical offer panel that latches to the right of a creator's Instagram profile so you can settle their rate without tab-hopping to the dashboard.

## Decide-offer panel

The pain this removes: previously you had to remember the rate the creator sent (from the dashboard activity timeline) and open their profile in a separate tab before pricing an offer in Delegate. Now:

1. On the dashboard, a creator awaiting your offer shows a **"Decide offer ▸"** button next to their activity timeline (and an **"Open on IG"** button on their Delegate card).
2. Clicking it opens the creator's **Instagram profile** in a new tab with the **offer panel** docked on the right.
3. The panel shows the **rate the creator sent plus every counter** (the same rate timeline as the dashboard), the **safe floor / least views**, and controls to **accept their rate** or **send a counter offer** — all hitting the same backend endpoints as the dashboard.

You can also open the panel manually on any creator's profile via the slim **"Deal ▸"** tab on the right edge — it resolves the creator by their @username.

### How it's wired

| File | Role |
| --- | --- |
| `instagram-panel.js` | Content script that latches the panel (an extension-origin iframe) to the right of Instagram, handles SPA navigation, and picks up decide-offer hand-offs. |
| `panel.html` / `panel.css` / `panel.js` | The panel itself: rate timeline, safe floor, and the offer configurator (ported from the dashboard). Fetches + posts to the dashboard API. |
| `background.js` | `openDecideOffer`: stores the one-shot target (creator id + dashboard URL) and opens the profile tab. |
| `dashboard-bridge.js` | Forwards the dashboard's `OEA_OPEN_DECIDE_OFFER` message and remembers the dashboard URL. |
| `popup.html` / `popup.js` | Lets you set the Dashboard URL used by the panel when opened standalone. |

The panel is an **extension-origin** iframe (listed in `web_accessible_resources`) rather than a dashboard-origin frame: extension frames are CSS-isolated from Instagram and aren't blocked by Instagram's page CSP. It reaches the API using the dashboard URL captured when you open the dashboard (or set in the popup); no offers are ever sent by the extension itself — it calls the same server endpoints the dashboard does, which remain the single source of truth for pricing and sending.

---

## Legacy notes (Gmail compose / follow-ups)

The sections below describe an earlier Gmail-based sending flow. Sending is now handled server-side via Instantly.ai; kept for reference.

A Chrome extension that automatically sends follow-up emails directly within Gmail's web interface, and allows you to compose new emails from any website.

## Features

- **Browser-native sending**: Sends emails through Gmail's web UI, not via API
- **Thread tracking**: Monitors threads and counts your sent emails
- **Smart follow-ups**: Only sends if recipient hasn't replied
- **Rule-based triggers**: Define custom follow-up messages based on email count
- **External site compose**: Send emails from any website (Instagram, LinkedIn, etc.)
- **Instagram auto-extraction**: Automatically extracts email and name from Instagram profiles. Long bios that hide the email behind a "… more" toggle are expanded automatically before scraping, so emails below the fold are still captured (applies to the dashboard "Scrape Via Extension" flow too).
- **Template management**: Create and reuse email templates with subjects
- **Name personalization**: Automatically extracts and inserts recipient's first name
- **Markdown links**: Use [text](url) syntax for clickable links
- **No AI generation**: Uses only your predefined message templates
- **Thread preservation**: Sends as replies to maintain conversation context

## Installation

### Fresh Install

1. **Create extension folder** with these files:
   - `manifest.json`
   - `popup.html`
   - `popup.js`
   - `content.js`
   - `instagram-content.js`
   - `background.js`

2. **Create placeholder icons** (or use your own):
   - `icon16.png` (16x16 pixels)
   - `icon48.png` (48x48 pixels)
   - `icon128.png` (128x128 pixels)

3. **Load extension in Chrome**:
   - Open `chrome://extensions/`
   - Enable "Developer mode" (top-right toggle)
   - Click "Load unpacked"
   - Select your extension folder

### Updating from Previous Version

**Your existing follow-ups are safe!** The new version includes automatic migration:

1. **Keep extension installed** - don't uninstall
2. **Replace files** in your extension folder with updated versions
3. **Go to** `chrome://extensions/`
4. **Click reload icon** on the extension card
5. **Open Gmail** - migration runs automatically
6. **Check console** (F12) - you'll see: `✅ Migrated X threads from old format to new sequence format`

**What happens to your scheduled follow-ups:**
- ✅ All scheduled follow-ups are preserved
- ✅ Timestamps remain the same
- ✅ Follow-ups will send at the originally scheduled time
- ✅ Old format automatically converts to new sequence format
- ✅ No manual action needed

**Technical details:**
- Old format: `pendingFollowup: true, followupScheduledFor: timestamp`
- New format: `pendingFollowups: [{message, scheduledFor}]`
- Migration converts old → new automatically on first load

## Usage

### Method 1: Compose from External Sites (Instagram, LinkedIn, etc.)

1. **Visit any website** (e.g., Instagram, LinkedIn, Twitter)
2. **Click the extension icon** in your Chrome toolbar
3. **Fill in the form**:
   - Recipient email address
   - Recipient first name (optional, used for {firstName} variable)
   - Email subject
   - Select a template OR paste/write your email
4. **Click "Send via Gmail"**
5. Extension opens Gmail and fills in all fields automatically
6. **Review and click Send** in Gmail (this ensures MailSuite tracking works)

### Method 2: Automatic Follow-ups in Gmail

**How Background Monitoring Works:**
1. **Keep Gmail tab open** (can be in background, doesn't need to be active)
2. **Extension checks every 30 minutes** for pending follow-ups
3. **Automatically navigates** to threads that need follow-ups
4. **Checks if recipient replied** (skips if they have)
5. **Sends follow-up** through Gmail's compose interface
6. **Returns to inbox** after processing all threads

**You don't need to:**
- View specific threads
- Be actively using Gmail
- Remember to check

**You just need to:**
- Keep a Gmail tab open in your browser
- Let the extension run in the background

**Manual trigger:**
You can also manually trigger follow-up checks by opening the extension popup on Gmail.

### Setup Follow-up Rules (Gmail only)

1. Open Gmail in Chrome
2. Click the extension icon
3. Configure settings:
   - Set default delay (hours between follow-ups)
   - Create email templates for reuse
   - **Add follow-up rules** - these define what message to send after X emails
4. Click "Save Settings"

**Follow-up Rule vs Email Template:**
- **Email Template**: The initial email you send (has name, subject, body)
- **Follow-up Rule**: The follow-up message sent after X sent emails (just body text)

**When composing from external sites:**
- Select an Email Template for your initial message
- Select a Follow-up Rule to automate replies if no response
- Extension remembers your last follow-up selection

### Instagram Auto-Extraction

The extension automatically searches Instagram profiles for:
- **Email address** from bio text (common formats like "contact@email.com", "name [at] domain.com")
- **Full name** from profile header
- **First name** extracted from full name or username as fallback

**What it looks for in bios:**
- Standard emails: `contact@example.com`
- Spaced emails: `name @ domain . com`
- Text format: `name [at] domain [dot] com`
- Mailto links
- Any email pattern in visible text

**Fallback behavior:**
- If no email found → you enter manually
- If no name found → uses username with capital first letter
- Always shows status message indicating what was found

### Template System

**Creating templates (in Gmail):**
```
Template: "Cold Outreach"
Hi {firstName},

I came across your profile and wanted to reach out about...

Looking forward to connecting!
Best,
[Your name]
```

**Follow-up Rules:**

**After 1st email sent:**
```
Hi {firstName},

Just following up on my previous email. Would love to hear your thoughts.

Best regards
```

**After 2nd email sent:**
```
Hi {firstName},

I wanted to check in once more on this. Please let me know if you need any additional information.

Thanks
```

## Configuration Options

- **Default Delay**: Hours to wait before sending follow-up (default: 24)
- **Email Templates**: Reusable templates with name, subject, and body for initial emails
- **Follow-up Rules**: Define follow-up messages triggered after X sent emails (just body text)
- **Last-used Follow-up**: Extension remembers which follow-up rule you last selected
- **Template Variables**: 
  - `{firstName}` - Automatically replaced with recipient's first name
- **Link Syntax**:
  - Markdown: `[text](url)` → clickable link
  - HTML: `<a href="url">text</a>` → clickable link
- **Background Monitoring**: Checks every 30 minutes for pending follow-ups

## Use Cases

### Instagram Influencer Outreach
1. Browse Instagram profiles
2. Extension auto-extracts email from bio
3. Select "Collaboration" template
4. Send professional pitch via Gmail in seconds

### LinkedIn Networking
1. View someone's LinkedIn profile
2. Click extension, enter their email from LinkedIn
3. Use "Introduction" template
4. Compose and send from Gmail

### Website Contact Forms Alternative
1. Instead of filling out contact forms
2. Find the company email
3. Use extension to compose professional email
4. Send directly through your Gmail

## Technical Details

### How Sending Works

The extension operates entirely within Gmail's browser interface:

1. Opens the reply compose box by clicking Gmail's Reply button
2. Inserts your message template into the compose area
3. Clicks Gmail's Send button
4. All tracking pixels and extensions see the send as if you manually sent it

### Thread Tracking

- Monitors threads by analyzing Gmail's DOM structure
- Counts sent emails by identifying messages from "me"
- Detects recipient replies by checking message senders
- Stores thread state in Chrome's local storage

### Privacy & Security

- All data stored locally in Chrome storage
- No external servers or API calls
- No email content sent anywhere
- Works entirely client-side in your browser

## Troubleshooting

**Instagram auto-extraction not working:**
- Make sure you're on a profile page (instagram.com/username)
- Check if email is actually in the bio
- Try reloading the extension and Instagram page
- Check popup status message for what was found

**Email not auto-filling on Instagram:**
- Profile may not have email in bio
- Check browser console (F12) for extraction logs
- Enter email manually if not found

**External site compose not working:**
- Ensure you have an active Gmail session (logged in)
- Check that popup blockers aren't blocking Gmail tab
- Verify you granted the extension permissions for all sites

**Follow-ups not sending:**
- Ensure you're viewing the thread in Gmail when follow-up is due
- Check that recipient hasn't replied (extension won't send if they have)
- Verify your follow-up rules are saved in the extension popup

**Name extraction not working:**
- Extension tries to extract from display name or email address
- Falls back to "there" if name can't be determined

**Extension not detecting sent emails:**
- Gmail's interface must be fully loaded
- Try refreshing the Gmail tab
- Check Chrome extension console for errors

## Limitations

- Must keep Gmail tab open for scheduled follow-ups to send
- Requires Gmail's standard web interface (not mobile view)
- Only works with single recipient threads (not group emails)
- Depends on Gmail's DOM structure (may break if Gmail updates)

## Development

To modify the extension:

1. Edit the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on your extension
4. Reload Gmail tabs to see changes

## Support

For issues or questions:
- Check Chrome extension console: Right-click extension icon → "Inspect popup"
- Check page console in Gmail: F12 → Console tab
- Look for error messages starting with "Gmail Follow-up Automator"