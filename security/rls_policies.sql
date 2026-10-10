-- Review existing policies before applying. Remove broad legacy policies first.
ALTER TABLE public.platelet_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platelet_analyses ADD COLUMN IF NOT EXISTS image_path text;

CREATE POLICY "pw_analysis_select" ON public.platelet_analyses FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "pw_analysis_insert" ON public.platelet_analyses FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "pw_analysis_update" ON public.platelet_analyses FOR UPDATE TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "pw_analysis_delete" ON public.platelet_analyses FOR DELETE TO authenticated USING ((select auth.uid()) = user_id);
CREATE POLICY "pw_profiles_select" ON public.profiles FOR SELECT TO authenticated USING ((select auth.uid()) = id);
CREATE POLICY "pw_profiles_insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK ((select auth.uid()) = id);
CREATE POLICY "pw_profiles_update" ON public.profiles FOR UPDATE TO authenticated USING ((select auth.uid()) = id) WITH CHECK ((select auth.uid()) = id);

-- Set microscope-images bucket to PRIVATE in Storage settings.
CREATE POLICY "pw_images_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id='microscope-images' AND (storage.foldername(name))[1] = (select auth.uid())::text);
CREATE POLICY "pw_images_select" ON storage.objects FOR SELECT TO authenticated USING (bucket_id='microscope-images' AND (storage.foldername(name))[1] = (select auth.uid())::text);
CREATE POLICY "pw_images_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id='microscope-images' AND (storage.foldername(name))[1] = (select auth.uid())::text);
