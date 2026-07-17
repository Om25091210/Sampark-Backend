# Runtime secrets, injected into the ECS task as environment variables by the task
# EXECUTION role at container start. The application never calls Secrets Manager.
#
# S3_BUCKET is deliberately absent: it is not a secret. It is passed as a plain
# environment variable in the task definition, sourced from aws_s3_bucket.media.
resource "aws_secretsmanager_secret" "app" {
  name        = "${var.project}/${var.environment}"
  description = "SAMPARK backend runtime secrets (${var.environment})"

  # AWS-managed key. A CMK buys nothing here and costs ~$1/month.
  kms_key_id = null

  # Staging only: destroy deletes immediately instead of holding the name hostage
  # for 7-30 days. Terraform could not otherwise recreate a secret of the same name.
  # This MUST become >= 7 before this config is used for production.
  recovery_window_in_days = 0

  tags = { Name = "${var.project}/${var.environment}" }
}

# Placeholder value only. The real JWT_SECRET is written by hand after the first
# apply -- see infra/README.md.
#
# ADR-034: DATABASE_URL is NO LONGER HERE. It was a hand-assembled copy of the RDS
# master password, which `manage_master_user_password` rotates every 7 days -- so it
# was correct only until the first rotation, and staging died at 11:40 IST on
# 2026-07-17, exactly 7 days after it was written (Backend#17). The task definition
# now reads DB_PASSWORD straight from the secret RDS owns and composes the URL at
# container start. There is no copy left to go stale.
#
# JWT_SECRET stays: it is a real static secret with no rotating source to read from.
#
# ignore_changes on secret_string is load-bearing, not decorative. Without it, the
# next `terraform apply` would diff the live value against the placeholder below and
# quietly overwrite the real credential, breaking the running service. Terraform
# must create this secret version once and never look at it again.
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id

  secret_string = jsonencode({
    JWT_SECRET = "placeholder"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
