# Report photos and generated Hindi PDF exports. Written by the backend via
# src/lib/storage.ts (STORAGE_PROVIDER=s3), read by clients through presigned GETs.
resource "aws_s3_bucket" "media" {
  bucket = "${local.name_prefix}-media-${local.account_id}"

  tags = { Name = "${local.name_prefix}-media" }
}

# There is deliberately no aws_s3_bucket_versioning resource. A new bucket is
# unversioned, which is what we want: user-uploaded media has no recovery value and
# versioning would roughly double storage cost. Setting status = "Disabled"
# explicitly is rejected by the API for a bucket that was never versioned.

resource "aws_s3_bucket_public_access_block" "media" {
  bucket = aws_s3_bucket.media.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    # Reduces per-object KMS calls to zero; free with SSE-S3.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  # Provider v6 defaults this to all_storage_classes_128K, meaning objects under
  # 128 KB are never transitioned. Stated explicitly so the behaviour is visible:
  # small thumbnails will stay in Standard regardless of the rule below.
  transition_default_minimum_object_size = "all_storage_classes_128K"

  rule {
    id     = "transition-to-standard-ia"
    status = "Enabled"

    # Empty filter = every object in the bucket.
    filter {}

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    # A failed multipart upload otherwise leaves parts that bill forever and are
    # invisible in the console object listing.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# CORS governs browser-initiated cross-origin requests only. It grants nothing on
# its own -- Block Public Access above still denies anonymous reads, and every
# object access must carry a valid presigned signature.
#
# Note: the mobile client uploads photo bytes as multipart to the backend, which
# then PUTs to S3 server-side (see DESIGN.md decision 7). No browser or device ever
# issues a direct PUT here, so the PUT method below is currently unexercised. It is
# kept per spec to leave room for a future presigned-PUT flow.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
