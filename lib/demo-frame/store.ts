import "server-only";
/**
 * DEV-196d-2: the artifact route's reads, with the service role (spec §5.1: the bucket is private and has no policy for
 * anon / authenticated; only the server reads it). Every failure is "nothing" (null / []), never an error message:
 * the route answers the same 404 and logs nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { DEMO_FRAME_BUCKET, type FrameDemo, type FrameFile, type FrameImage, type FrameStore, type FrameVersion } from "./serve";

export function supabaseFrameStore(client: SupabaseClient = createServiceClient()): FrameStore {
  return {
    async version(id) {
      const { data, error } = await client
        .from("sales_demo_versions")
        .select("id, demo_id, status, revoked_at, expires_at, storage_prefix")
        .eq("id", id)
        .maybeSingle();
      return error || !data ? null : (data as FrameVersion);
    },
    async demo(id) {
      const { data, error } = await client.from("sales_demos").select("id, disabled_at").eq("id", id).maybeSingle();
      return error || !data ? null : (data as FrameDemo);
    },
    async files(versionId) {
      const { data, error } = await client
        .from("sales_demo_version_files")
        .select("path, role, sha256, bytes, content_type, width, height, image_id")
        .eq("version_id", versionId)
        .limit(64);
      return error || !data ? [] : (data as FrameFile[]);
    },
    async images(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await client.from("sales_demo_images").select("id, sha256, rights_status, rights_expiry, revoked_at").in("id", [...ids]);
      return error || !data ? [] : (data as FrameImage[]);
    },
    async object(key, maxBytes) {
      const { data, error } = await client.storage.from(DEMO_FRAME_BUCKET).download(key);
      if (error || !data || data.size > maxBytes) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
  };
}
