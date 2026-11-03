# User & installation guide

## Install (testing / developer mode)
**Chrome**
1. Extract the release ZIP. Don't select the ZIP file itself.
2. Check that `manifest.json` sits directly inside the folder you'll select (`dist`).
3. Open `chrome://extensions` and turn on **Developer mode**.
4. Click **Load unpacked** and select that folder.
5. Pin CONVOSAGE AI from the puzzle-piece menu. After an update, click **Reload** on its card.

**Microsoft Edge:** the same steps at `edge://extensions`. Review the permission warnings.
**Firefox / Safari:** not supported by this build. They need separate certified packages.
For customers, install from the Chrome Web Store or Edge Add-ons, or via your organisation's managed deployment.

## First-time setup
1. Click the CONVOSAGE icon. The side panel opens. Sign in with your mobile number and the SMS code.
2. Subscribe to Pro (US$10/month) to unlock live capture and AI.
3. Create or choose a **programme**, for example "Claims platform KT — 5 days".
4. Open **Context profile**:
   - Add objectives, domain, technology, audience, terminology, constraints and success criteria.
   - Or paste an agenda and click **Draft with AI**. AI-inferred items are marked **AI**; check them.
5. Create a **session** with a meaningful title. Attach only documents you're authorised to share (**Documents** tab).

## During a meeting
1. Join the meeting normally in Chrome or Edge, using the web version of Zoom, Meet or Teams.
2. With the meeting tab in front, click the CONVOSAGE icon and open your **Active** session.
3. Click **Start capture**:
   - Choose the sources: meeting tab audio, your microphone, and/or a shared screen you pick.
   - Read and tick the consent statement, then click Start.
4. Check that **REC** shows on the toolbar icon and the capture status in the panel.
5. Questions appear with *why it matters*, evidence and timestamp, priority and confidence.
   - Ask them yourself if appropriate. CONVOSAGE never speaks or joins on your behalf.
   - Use **Mark answered**, **Save**, **Dismiss**, 👍/👎 and **Copy**.
6. Use **Pause** or **Stop capture** as needed. Stop capture before leaving the meeting.

## Disable a session
1. Click **Disable session** and read the confirmation.
2. Confirm. Capture stops, the status shows **Disabled**, and the server blocks new capture and processing. Existing content is kept.
3. To reuse it, click **Enable session**, then press **Start capture** yourself. It never resumes automatically.

## After a meeting
- **Knowledge:** shows the summary, topics, decisions, actions (owners and dates only when stated), glossary, open questions, contradictions and gaps, each with evidence ids. Correct anything that's wrong. **Programme ledger** shows knowledge across all sessions.
- **Ask:** searches your authorised sessions and documents and answers with citations (session and timestamp).
- **Export:** Markdown, PDF, CSV or JSON. Redaction is on by default. Exports are audit-logged.
- **Delete:** schedules deletion, which is purged after the grace period unless cancelled or under legal hold.

## Troubleshooting
| Problem | Check |
|---|---|
| Extension will not load | Select the folder that directly contains `manifest.json`. Extract the ZIP first. Check the error on the extensions page. |
| "Can't reach the CONVOSAGE service" | Your internet connection or VPN. Then check the service status. |
| No meeting audio | Start capture with the meeting tab in front, after clicking the CONVOSAGE icon on that tab. The tab must be playing audio. |
| Microphone blocked | Allow it in the tab CONVOSAGE opens, or in the site settings for the extension. |
| No slide text | You must pick a screen, window or tab in **Shared screen**. Slide text is read only when the view changes. |
| "Session is not Active" | The session is Disabled or Archived. Enable it (if you're the owner or an admin), then start a new capture. |
| Irrelevant questions | Improve the context profile, give 👎 feedback, and check the transcript quality. |

## Known limitations
- Capture depends on browser support and your permissions; you may need to re-authorise.
- Extensions can't see platform participant rosters or internal media streams.
- Slides are detected from visible changes; original decks and speaker notes aren't accessible.
- Screen capture uses bandwidth, battery and CPU.
- Speakers are labelled "Unknown speaker" unless known; voice-based identification isn't attempted.
- AI output can be wrong. Evidence and human review remain necessary.
