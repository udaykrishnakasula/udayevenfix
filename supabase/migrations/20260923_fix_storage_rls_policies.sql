-- ============================================================================
-- EasyX Storage RLS Policies Correction
-- Fixes path index mismatch for nested storage paths:
--   - deposit-proofs: deposits/${userId}/${uuid}_proof${n}.${ext} -> index 2
--   - kyc-documents:  front/${userId}/${uuid}.${ext}             -> index 2
--                     back/${userId}/${uuid}.${ext}              -> index 2
--   - kyc-selfies:    selfie/${userId}/${uuid}.${ext}            -> index 2
--   - support-attachments: ${userId}/${attachmentId}.${ext}      -> index 1 (preserved)
-- All buckets remain PRIVATE (public = false).
-- ============================================================================

-- 1. kyc-documents
DROP POLICY IF EXISTS "Users can upload their own KYC docs" ON storage.objects;
CREATE POLICY "Users can upload their own KYC docs"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'kyc-documents' 
    AND (auth.uid())::text = (storage.foldername(name))[2]
);

DROP POLICY IF EXISTS "Users can view their own KYC docs or admins view all" ON storage.objects;
CREATE POLICY "Users can view their own KYC docs or admins view all"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'kyc-documents' 
    AND ((auth.uid())::text = (storage.foldername(name))[2] OR is_admin())
);

-- 2. kyc-selfies
DROP POLICY IF EXISTS "Users can upload their own KYC selfies" ON storage.objects;
CREATE POLICY "Users can upload their own KYC selfies"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'kyc-selfies' 
    AND (auth.uid())::text = (storage.foldername(name))[2]
);

DROP POLICY IF EXISTS "Users can view their own KYC selfies or admins view all" ON storage.objects;
CREATE POLICY "Users can view their own KYC selfies or admins view all"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'kyc-selfies' 
    AND ((auth.uid())::text = (storage.foldername(name))[2] OR is_admin())
);

-- 3. deposit-proofs
DROP POLICY IF EXISTS "Users can upload deposit proofs" ON storage.objects;
CREATE POLICY "Users can upload deposit proofs"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'deposit-proofs' 
    AND (auth.uid())::text = (storage.foldername(name))[2]
);

DROP POLICY IF EXISTS "Users can view own deposit proofs or admins view all" ON storage.objects;
CREATE POLICY "Users can view own deposit proofs or admins view all"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'deposit-proofs' 
    AND ((auth.uid())::text = (storage.foldername(name))[2] OR is_admin())
);
