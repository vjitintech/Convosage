// ─────────────────────────────────────────────────────────────────────────────
// CONVOSAGE AI — extension settings. THIS IS THE ONLY FILE YOU EDIT BEFORE BUILDING.
// Replace the placeholders with your own Supabase project values (Project Settings → API).
// The publishable/anon key is designed to be public; never put secret keys here.
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
  /** e.g. https://abcdefghijklmnop.supabase.co */
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  /** Supabase publishable key (sb_publishable_…) or legacy anon key */
  SUPABASE_PUBLISHABLE_KEY: "YOUR-SUPABASE-PUBLISHABLE-KEY",
  /** API base; leave empty to use SUPABASE_URL + /functions/v1/api */
  API_URL: "",
  /** Show the two dummy test accounts on the sign-in screen (turn off for public launch) */
  SHOW_TEST_ACCOUNTS: true,
  TEST_ACCOUNTS: [
    { label: "Dummy user 1 (India)", country: "+91", phone: "9999900001", otp: "123456" },
    { label: "Dummy user 2 (USA)", country: "+1", phone: "5550100002", otp: "654321" },
  ],
  /** Audio chunk length sent for transcription */
  AUDIO_CHUNK_SECONDS: 10,
  /** How often the selected screen is sampled for slide changes */
  FRAME_SAMPLE_MS: 2000,
  /** Force a frame upload at least this often while the screen is static */
  FRAME_MAX_INTERVAL_MS: 60000,
};
