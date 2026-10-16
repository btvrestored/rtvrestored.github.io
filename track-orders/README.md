# Track-order backend (shared by BTV + RTV)

This folder is the single backend source for the separate Supabase project used for music requests. It is intentionally separate from the existing chat/SMS databases. Both websites send a fixed channel value (btv or rtv) into the same track_requests queue; moderators are restricted by row-level security to their assigned channel(s).

## What it does

- Requires an artist and a direct HTTPS clip link to a YouTube or VK video. Track title is optional.
- Saves submissions as pending; approval is always a manual decision.
- Uses MusicBrainz for artist/recording lookup. Discogs support is optional and requires a server-side token.
- Validates inputs again in the Edge Function, has a hidden honeypot and a server-side limit of 5 submissions per IP/channel per 10-minute bucket and 20 catalog searches per IP/channel per bucket.
- Caches catalog searches for 12 hours and globally throttles requests to respect provider limits.
- Keeps the database secret key out of the browser and repository.

Catalog presence is only a metadata cross-check. It does not mean the track is suitable for a channel; moderators must listen/review the clip before approval.

## Deploy

1. Create a dedicated Supabase project for track requests. Do not use either channel's existing chat/SMS project.
2. Install the Supabase CLI and sign in.
3. From this directory, run: supabase link --project-ref YOUR_PROJECT_REF.
4. Apply the migration with supabase db push, or paste supabase/migrations/202610160001_track_requests.sql into the SQL Editor.
5. In Supabase Dashboard -> Edge Functions -> Secrets, add TRACK_REQUEST_HASH_SALT with at least 24 random characters. Do not commit this value. SUPABASE_URL and the server-side Supabase secret are supplied by the hosted runtime. For optional Discogs searches, also add DISCOGS_TOKEN.
6. Deploy both functions: supabase functions deploy track-request-submit and supabase functions deploy track-catalog-search.
7. In Authentication -> Users, create the moderator account(s). Copy each user's UID and run, for example:
   INSERT INTO public.track_request_admins (user_id, channel) VALUES ('AUTH-USER-UUID', 'all');
   Use btv or rtv instead of all to restrict access to one channel. Keep public sign-up disabled.
8. In each repository's track-order-config.js, set the project URL and publishable key. This public key is designed for browser use; RLS remains the security boundary. Never put a Supabase secret/service-role key in this file.

## Function secrets

TRACK_REQUEST_HASH_SALT is used only to hash requester identifiers before they are placed in rate-limit buckets. DISCOGS_TOKEN is optional. All server keys belong in Supabase Function Secrets, never in JavaScript, .env.example, or a public Git repository.

## Notes

- verify_jwt = false is intentional for the public form/catalog endpoints. They validate their payloads, restrict browser origins, apply server-side rate limits, and use a server-side key to write. It does not make the secret key public.
- CORS is not an authorization boundary; database RLS and server-side validation are essential.
- If the MusicBrainz service rate-limits the project, wait before retrying. Do not try to bypass the provider's limits.
